use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{self, disable_raw_mode, enable_raw_mode};
use futures::{SinkExt, StreamExt};
use offdesk_protocol::{MachineInfo, SpaceInfo, TerminalAttention, TerminalInfo};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use unicode_width::UnicodeWidthStr;

use crate::attach;
use crate::client::{CreateTerminalRequest, HubClient};
use crate::config::ResolvedConfig;
use crate::resolve::short_id;
use crate::CliError;

/// `Ctrl+]` (ASCII GS, 0x1d) detaches from an attached terminal back to the TUI picker
/// (or exits when launched via `offdesk attach`). Standard telnet/mosh/ssh escape that
/// never conflicts with Claude Code, agy, vim, or tmux.
const DETACH_BYTE: u8 = 0x1d;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterMode {
    All,
    Waiting,
    Working,
}

impl FilterMode {
    fn next(self) -> Self {
        match self {
            FilterMode::All => FilterMode::Waiting,
            FilterMode::Waiting => FilterMode::Working,
            FilterMode::Working => FilterMode::All,
        }
    }

    fn label(self) -> &'static str {
        match self {
            FilterMode::All => "All",
            FilterMode::Waiting => "Waiting",
            FilterMode::Working => "Working",
        }
    }
}

struct SessionItem {
    terminal: TerminalInfo,
    machine_name: String,
    display_title: String,
    short_cwd: String,
    space_id: Option<String>,
    space_name: Option<String>,
}

struct RawModeGuard;

impl RawModeGuard {
    fn enter() -> Result<Self, CliError> {
        enable_raw_mode().map_err(|e| CliError::Usage(format!("failed to enter raw TTY mode: {e}")))?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let mut out = io::stdout();
        // Reset mouse tracking, bracketed paste, alternate screen, cursor visibility & SGR.
        let _ = out.write_all(
            b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l",
        );
        let _ = out.flush();
        let _ = disable_raw_mode();
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn display_title(t: &TerminalInfo) -> String {
    if let Some(custom) = t.custom_title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return custom.to_string();
    }
    let raw = t.title.trim();
    if raw.is_empty() {
        return "shell".to_string();
    }
    raw.to_string()
}

fn shorten_cwd(cwd: &str) -> String {
    if let Some(rest) = cwd.strip_prefix("/home/") {
        if let Some(idx) = rest.find('/') {
            return format!("~{}", &rest[idx..]);
        }
        return "~".to_string();
    }
    if let Some(rest) = cwd.strip_prefix("/Users/") {
        if let Some(idx) = rest.find('/') {
            return format!("~{}", &rest[idx..]);
        }
        return "~".to_string();
    }
    cwd.to_string()
}

fn is_waiting(t: &TerminalInfo) -> bool {
    matches!(
        t.attention,
        Some(TerminalAttention::Confirmation) | Some(TerminalAttention::FolderTrust)
    )
}

fn is_working(t: &TerminalInfo, now: i64) -> bool {
    if is_waiting(t) {
        return false;
    }
    t.last_activity_ms
        .is_some_and(|ms| now.saturating_sub(ms) < 60_000)
}

fn format_age(last_activity_ms: Option<i64>, now: i64) -> String {
    let Some(ms) = last_activity_ms else {
        return String::new();
    };
    let diff_s = ((now - ms).max(0) / 1000) as u64;
    if diff_s < 60 {
        "now".to_string()
    } else if diff_s < 3600 {
        format!("{}m", diff_s / 60)
    } else if diff_s < 86400 {
        format!("{}h", diff_s / 3600)
    } else {
        format!("{}d", diff_s / 86400)
    }
}

fn truncate_width(s: &str, max_w: usize) -> String {
    if max_w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0usize;
    for ch in s.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > max_w {
            if max_w >= 1 && w < max_w {
                out.push('…');
            }
            break;
        }
        out.push(ch);
        w += cw;
    }
    out
}

/// Resolve a terminal's Space `(id, name)` via its workspace group.
fn resolve_session_space(
    terminal: &TerminalInfo,
    group_spaces: &HashMap<String, String>,
    space_names: &HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    let Some(group_id) = terminal.workspace_group_id.as_deref() else {
        return (None, None);
    };
    let Some(space_id) = group_spaces.get(group_id) else {
        return (None, None);
    };
    let space_name = space_names.get(space_id).cloned();
    (Some(space_id.clone()), space_name)
}

/// Cycle the active Space filter: `None` (All) -> Space 1 -> Space 2 -> ... -> `None`.
fn cycle_space(current: Option<&str>, spaces: &[SpaceInfo], forward: bool) -> Option<String> {
    if spaces.is_empty() {
        return None;
    }
    match current {
        None => {
            if forward {
                Some(spaces[0].id.clone())
            } else {
                spaces.last().map(|s| s.id.clone())
            }
        }
        Some(active_id) => {
            let Some(pos) = spaces.iter().position(|s| s.id == active_id) else {
                return if forward {
                    Some(spaces[0].id.clone())
                } else {
                    spaces.last().map(|s| s.id.clone())
                };
            };
            if forward {
                spaces.get(pos + 1).map(|s| s.id.clone())
            } else if pos == 0 {
                None
            } else {
                Some(spaces[pos - 1].id.clone())
            }
        }
    }
}

async fn load_sessions(
    client: &HubClient,
    machine_filter: Option<&str>,
) -> Result<(Vec<MachineInfo>, Vec<SpaceInfo>, Vec<SessionItem>), CliError> {
    let machines = client.machines().await?;
    let terminals = client.terminals().await?;
    let spaces = client
        .spaces_optional()
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let space_names: HashMap<String, String> = spaces
        .iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();

    let mut group_spaces: HashMap<String, String> = HashMap::new();
    if !spaces.is_empty() {
        let grouped_machines: HashSet<&str> = terminals
            .iter()
            .filter(|t| t.reachable && t.workspace_group_id.is_some())
            .map(|t| t.machine_id.as_str())
            .collect();
        for machine_id in grouped_machines {
            if let Ok(groups) = client.workspace_groups(machine_id).await {
                for group in groups {
                    if let Some(space_id) = group.space_id {
                        group_spaces.insert(group.id, space_id);
                    }
                }
            }
        }
    }

    let machine_names: HashMap<String, String> = machines
        .iter()
        .map(|m| (m.id.clone(), m.name.clone()))
        .collect();
    let filter_lower = machine_filter.map(|s| s.to_lowercase());
    let now = now_ms();

    let mut items: Vec<SessionItem> = terminals
        .into_iter()
        .filter(|t| t.reachable)
        .filter(|t| {
            let Some(ref f) = filter_lower else {
                return true;
            };
            let mname = machine_names
                .get(&t.machine_id)
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            t.machine_id.to_lowercase().starts_with(f) || mname.contains(f)
        })
        .map(|t| {
            let machine_name = machine_names
                .get(&t.machine_id)
                .cloned()
                .unwrap_or_else(|| short_id(&t.machine_id).to_string());
            let dt = display_title(&t);
            let sc = shorten_cwd(&t.cwd);
            let (space_id, space_name) = resolve_session_space(&t, &group_spaces, &space_names);
            SessionItem {
                terminal: t,
                machine_name,
                display_title: dt,
                short_cwd: sc,
                space_id,
                space_name,
            }
        })
        .collect();

    // Sort: waiting first, then working, then most recently active.
    items.sort_by(|a, b| {
        let rank = |t: &TerminalInfo| -> u8 {
            if is_waiting(t) {
                0
            } else if is_working(t, now) {
                1
            } else {
                2
            }
        };
        rank(&a.terminal)
            .cmp(&rank(&b.terminal))
            .then_with(|| {
                b.terminal
                    .last_activity_ms
                    .unwrap_or(0)
                    .cmp(&a.terminal.last_activity_ms.unwrap_or(0))
            })
            .then_with(|| a.display_title.cmp(&b.display_title))
    });

    Ok((machines, spaces, items))
}

fn filter_items<'a>(
    items: &'a [SessionItem],
    query: &str,
    mode: FilterMode,
    active_space: Option<&str>,
    now: i64,
) -> Vec<&'a SessionItem> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect();
    items
        .iter()
        .filter(|item| match active_space {
            None => true,
            Some(space_id) => item.space_id.as_deref() == Some(space_id),
        })
        .filter(|item| match mode {
            FilterMode::All => true,
            FilterMode::Waiting => is_waiting(&item.terminal),
            FilterMode::Working => is_working(&item.terminal, now),
        })
        .filter(|item| {
            if tokens.is_empty() {
                return true;
            }
            let hay = format!(
                "{} {} {} {} {}",
                item.display_title,
                item.machine_name,
                item.short_cwd,
                short_id(&item.terminal.id),
                item.space_name.as_deref().unwrap_or("")
            )
            .to_lowercase();
            tokens.iter().all(|tok| hay.contains(tok))
        })
        .collect()
}

fn draw_picker(
    items: &[SessionItem],
    spaces: &[SpaceInfo],
    active_space: Option<&str>,
    filtered: &[&SessionItem],
    selected: usize,
    scroll: usize,
    query: &str,
    mode: FilterMode,
    status_msg: Option<&str>,
    watch_only: bool,
) -> io::Result<()> {
    let (cols, rows) = terminal::size().unwrap_or((100, 30));
    let cols = cols.max(40) as usize;
    let rows = rows.max(10) as usize;
    let now = now_ms();

    let scoped_items: Vec<&SessionItem> = items
        .iter()
        .filter(|i| match active_space {
            None => true,
            Some(sid) => i.space_id.as_deref() == Some(sid),
        })
        .collect();
    let waiting_cnt = scoped_items.iter().filter(|i| is_waiting(&i.terminal)).count();
    let working_cnt = scoped_items
        .iter()
        .filter(|i| is_working(&i.terminal, now))
        .count();

    let mut buf = String::with_capacity(cols * rows * 2);
    // Synchronized output + home + clear
    buf.push_str("\x1b[?2026h\x1b[?25l\x1b[H\x1b[2J");

    // Line 1: Header
    let mode_badge = if watch_only { " [watch]" } else { "" };
    let header_left = format!(" offdesk tui{mode_badge}");
    let space_badge = if !spaces.is_empty() {
        let label = active_space
            .and_then(|sid| spaces.iter().find(|s| s.id == sid))
            .map(|s| s.name.as_str())
            .unwrap_or("All Spaces");
        format!("[{label}] ")
    } else {
        String::new()
    };
    let header_right = format!(
        "{space_badge}[{}]  {} wait · {} work · {} total ",
        mode.label(),
        waiting_cnt,
        working_cnt,
        scoped_items.len()
    );
    let pad = cols.saturating_sub(header_left.width() + header_right.width());
    buf.push_str("\x1b[1;38;2;217;249;157m");
    buf.push_str(&header_left);
    buf.push_str("\x1b[0;38;2;148;163;184m");
    for _ in 0..pad {
        buf.push(' ');
    }
    buf.push_str(&header_right);
    buf.push_str("\x1b[0m\r\n");

    // Line 2: Divider
    buf.push_str("\x1b[38;2;52;56;66m");
    for _ in 0..cols {
        buf.push('─');
    }
    buf.push_str("\x1b[0m\r\n");

    // Line 3: Search bar
    buf.push_str(" \x1b[1;38;2;163;230;53m❯\x1b[0m ");
    if query.is_empty() {
        buf.push_str("\x1b[38;2;113;113;122mFilter by title, space, project, machine, or id…\x1b[0m");
    } else {
        buf.push_str(query);
    }
    buf.push_str("\x1b[38;2;217;199;115m█\x1b[0m\r\n");

    // Line 4: Divider
    buf.push_str("\x1b[38;2;52;56;66m");
    for _ in 0..cols {
        buf.push('─');
    }
    buf.push_str("\x1b[0m\r\n");

    // List rows (rows - 6 available)
    let list_height = rows.saturating_sub(6);
    if filtered.is_empty() {
        buf.push_str("\r\n   \x1b[38;2;113;113;122mNo matching sessions. Press Tab or [/] to switch filter, or Ctrl+N to open a new terminal.\x1b[0m\r\n");
    } else {
        for (i, item) in filtered.iter().skip(scroll).take(list_height).enumerate() {
            let abs_idx = scroll + i;
            let is_sel = abs_idx == selected;
            let dot = if is_waiting(&item.terminal) {
                "\x1b[38;2;248;113;113m●\x1b[0m"
            } else if is_working(&item.terminal, now) {
                "\x1b[38;2;74;222;128m●\x1b[0m"
            } else {
                "\x1b[38;2;113;113;122m○\x1b[0m"
            };
            let age = format_age(item.terminal.last_activity_ms, now);
            let meta = if age.is_empty() {
                format!("{}  {}", item.machine_name, item.short_cwd)
            } else {
                format!("{}  {}  {}", item.machine_name, item.short_cwd, age)
            };
            let max_meta = (cols / 2).min(46);
            let meta_disp = truncate_width(&meta, max_meta);
            let space_tag = item
                .space_name
                .as_deref()
                .map(|name| format!("[{}] ", truncate_width(name, 14)))
                .unwrap_or_default();
            let space_tag_w = space_tag.width();
            let title_avail = cols.saturating_sub(6 + meta_disp.width() + space_tag_w);
            let title_disp = truncate_width(&item.display_title, title_avail);
            let gap = cols.saturating_sub(5 + space_tag_w + title_disp.width() + meta_disp.width());

            if is_sel {
                buf.push_str("\x1b[48;2;36;39;48m\x1b[38;2;163;230;53m▎\x1b[0m\x1b[48;2;36;39;48m ");
                buf.push_str(dot);
                buf.push_str("\x1b[48;2;36;39;48m ");
                if !space_tag.is_empty() {
                    buf.push_str("\x1b[38;2;125;211;252m");
                    buf.push_str(&space_tag);
                }
                buf.push_str("\x1b[1;38;2;244;244;245m");
                buf.push_str(&title_disp);
                for _ in 0..gap {
                    buf.push(' ');
                }
                buf.push_str("\x1b[0;48;2;36;39;48m\x1b[38;2;161;161;170m");
                buf.push_str(&meta_disp);
                buf.push_str(" \x1b[0m\r\n");
            } else {
                buf.push_str("  ");
                buf.push_str(dot);
                buf.push(' ');
                if !space_tag.is_empty() {
                    buf.push_str("\x1b[38;2;96;165;250m");
                    buf.push_str(&space_tag);
                }
                buf.push_str("\x1b[38;2;228;228;231m");
                buf.push_str(&title_disp);
                for _ in 0..gap {
                    buf.push(' ');
                }
                buf.push_str("\x1b[38;2;113;113;122m");
                buf.push_str(&meta_disp);
                buf.push_str(" \x1b[0m\r\n");
            }
        }
    }

    // Bottom footer pinned to last two lines
    buf.push_str(&format!("\x1b[{};1H\x1b[38;2;52;56;66m", rows.saturating_sub(1)));
    for _ in 0..cols {
        buf.push('─');
    }
    buf.push_str("\x1b[0m");
    buf.push_str(&format!("\x1b[{rows};1H\x1b[2K"));
    if let Some(msg) = status_msg {
        buf.push_str(&format!(" \x1b[38;2;250;204;21m{}\x1b[0m", truncate_width(msg, cols - 2)));
    } else {
        let hints = " ↑↓ move · Enter attach · Tab filter · [/] space · ^N new · ^R refresh · ^] detach · Esc quit";
        buf.push_str(&format!("\x1b[38;2;148;163;184m{}\x1b[0m", truncate_width(hints, cols)));
    }
    buf.push_str("\x1b[?2026l");

    let mut out = io::stdout();
    out.write_all(buf.as_bytes())?;
    out.flush()
}

/// Interactive Raw-TTY attach directly to a remote terminal over Hub WebSocket.
/// Returns `Ok(true)` if the user pressed `Ctrl+]` to detach cleanly, or `Ok(false)`
/// if the remote terminal closed.
async fn attach_interactive(
    config: &ResolvedConfig,
    client: &HubClient,
    terminal: &TerminalInfo,
    watch_only: bool,
) -> Result<bool, CliError> {
    if !watch_only {
        let _ = client.claim_control(&terminal.machine_id).await;
    }

    let device_id = format!("cli-tui-{}", uuid::Uuid::new_v4());
    let mut socket = attach::connect(config, &terminal.machine_id, &terminal.id, &device_id).await?;

    // Clear screen & leave picker alt-screen cleanly before remote PTY paints.
    {
        let mut out = io::stdout();
        let _ = out.write_all(b"\x1b[?1049l\x1b[2J\x1b[H\x1b[?25h");
        let _ = out.flush();
    }

    let mut last_size = terminal::size().unwrap_or((120, 36));
    if !watch_only {
        let msg = serde_json::json!({
            "type": "resize",
            "cols": last_size.0,
            "rows": last_size.1,
        });
        let _ = socket.send(Message::Text(msg.to_string().into())).await;
    }

    // Spawn a dedicated blocking stdin reader so raw bytes (including UTF-8 IME
    // commits, Kitty/CSI sequences, SGR mouse, bracketed paste) flow with 0ms lag.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_reader = Arc::clone(&stop_flag);
    std::thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 4096];
        while !stop_reader.load(Ordering::Relaxed) {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if in_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut resize_tick = tokio::time::interval(Duration::from_millis(80));
    resize_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut detached_by_user = false;
    loop {
        tokio::select! {
            ws_msg = socket.next() => {
                match ws_msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        let mut out = io::stdout();
                        let _ = out.write_all(&bytes);
                        let _ = out.flush();
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = socket.send(Message::Pong(p)).await;
                    }
                    Some(Err(_)) => {
                        break;
                    }
                    _ => {}
                }
            }
            maybe_bytes = in_rx.recv() => {
                let Some(bytes) = maybe_bytes else { break; };
                if let Some(pos) = bytes.iter().position(|&b| b == DETACH_BYTE) {
                    if pos > 0 && !watch_only {
                        let data = String::from_utf8_lossy(&bytes[..pos]).into_owned();
                        let frame = serde_json::json!({ "type": "input", "data": data });
                        let _ = socket.send(Message::Text(frame.to_string().into())).await;
                    }
                    detached_by_user = true;
                    break;
                }
                if !watch_only && !bytes.is_empty() {
                    let data = String::from_utf8_lossy(&bytes).into_owned();
                    let frame = serde_json::json!({ "type": "input", "data": data });
                    if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
            _ = resize_tick.tick() => {
                if !watch_only {
                    if let Ok(sz) = terminal::size() {
                        if sz != last_size && sz.0 >= 20 && sz.1 >= 6 {
                            last_size = sz;
                            let frame = serde_json::json!({
                                "type": "resize",
                                "cols": sz.0,
                                "rows": sz.1,
                            });
                            let _ = socket.send(Message::Text(frame.to_string().into())).await;
                        }
                    }
                }
            }
        }
    }

    stop_flag.store(true, Ordering::Relaxed);
    let _ = socket.close(None).await;

    // Cleanly reset any mouse/paste modes the remote TUI enabled.
    {
        let mut out = io::stdout();
        let _ = out.write_all(
            b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m",
        );
        let _ = out.flush();
    }

    Ok(detached_by_user)
}

/// `offdesk attach <target> [--watch]` — attach directly to a single terminal.
pub async fn run_attach(
    config: &ResolvedConfig,
    client: &HubClient,
    target: &str,
    watch_only: bool,
) -> Result<(), CliError> {
    let (_, _, items) = load_sessions(client, None).await?;
    let q = target.to_lowercase();
    let matched = items
        .iter()
        .find(|i| i.terminal.id.to_lowercase().starts_with(&q))
        .or_else(|| {
            items
                .iter()
                .find(|i| i.display_title.to_lowercase().contains(&q))
        })
        .ok_or_else(|| CliError::Usage(format!("no online terminal matching '{target}'")))?;

    let _guard = RawModeGuard::enter()?;
    let _ = attach_interactive(config, client, &matched.terminal, watch_only).await?;
    Ok(())
}

/// `offdesk tui [--machine <name|id>] [--watch]` — interactive fuzzy session switcher
/// + native Ghostty/Alacritty/iTerm2 raw-TTY attach.
pub async fn run_tui(
    config: &ResolvedConfig,
    client: &HubClient,
    machine_filter: Option<String>,
    watch_only: bool,
) -> Result<(), CliError> {
    let _guard = RawModeGuard::enter()?;
    let (mut machines, mut spaces, mut items) =
        load_sessions(client, machine_filter.as_deref()).await?;

    let mut query = String::new();
    let mut mode = FilterMode::All;
    let mut active_space: Option<String> = None;
    let mut selected: usize = 0;
    let mut scroll: usize = 0;
    let mut status_msg: Option<String> = None;

    // Enter alt-screen for the picker.
    {
        let mut out = io::stdout();
        let _ = out.write_all(b"\x1b[?1049h");
        let _ = out.flush();
    }

    loop {
        let now = now_ms();
        let filtered = filter_items(&items, &query, mode, active_space.as_deref(), now);
        if filtered.is_empty() {
            selected = 0;
            scroll = 0;
        } else {
            if selected >= filtered.len() {
                selected = filtered.len() - 1;
            }
            let (_, rows) = terminal::size().unwrap_or((100, 30));
            let list_h = (rows as usize).saturating_sub(6).max(1);
            if selected < scroll {
                scroll = selected;
            } else if selected >= scroll + list_h {
                scroll = selected + 1 - list_h;
            }
        }

        let _ = draw_picker(
            &items,
            &spaces,
            active_space.as_deref(),
            &filtered,
            selected,
            scroll,
            &query,
            mode,
            status_msg.as_deref(),
            watch_only,
        );

        if !event::poll(Duration::from_millis(250)).unwrap_or(false) {
            continue;
        }
        let Ok(ev) = event::read() else { continue };
        match ev {
            Event::Resize(_, _) => continue,
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                status_msg = None;
                match (key.code, key.modifiers) {
                    (KeyCode::Esc, _)
                    | (KeyCode::Char('c'), KeyModifiers::CONTROL)
                    | (KeyCode::Char('q'), KeyModifiers::CONTROL) => {
                        break;
                    }
                    (KeyCode::Up, _) | (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                        if selected > 0 {
                            selected -= 1;
                        }
                    }
                    (KeyCode::Down, _) | (KeyCode::Char('n'), KeyModifiers::CONTROL)
                        if key.code == KeyCode::Down =>
                    {
                        if selected + 1 < filtered.len() {
                            selected += 1;
                        }
                    }
                    (KeyCode::Char('j'), KeyModifiers::CONTROL) => {
                        if selected + 1 < filtered.len() {
                            selected += 1;
                        }
                    }
                    (KeyCode::Char('k'), KeyModifiers::CONTROL) => {
                        if selected > 0 {
                            selected -= 1;
                        }
                    }
                    (KeyCode::Tab, _) => {
                        mode = mode.next();
                        selected = 0;
                        scroll = 0;
                    }
                    (KeyCode::Char(']'), KeyModifiers::NONE) => {
                        active_space = cycle_space(active_space.as_deref(), &spaces, true);
                        selected = 0;
                        scroll = 0;
                    }
                    (KeyCode::Char('['), KeyModifiers::NONE) => {
                        active_space = cycle_space(active_space.as_deref(), &spaces, false);
                        selected = 0;
                        scroll = 0;
                    }
                    (KeyCode::Char('r'), KeyModifiers::CONTROL) => {
                        status_msg = Some("Refreshing sessions…".to_string());
                        if let Ok((m, sp, it)) =
                            load_sessions(client, machine_filter.as_deref()).await
                        {
                            machines = m;
                            spaces = sp;
                            items = it;
                            if let Some(ref sid) = active_space {
                                if !spaces.iter().any(|s| &s.id == sid) {
                                    active_space = None;
                                }
                            }
                            status_msg = Some(format!("Refreshed ({} online)", items.len()));
                        }
                    }
                    (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                        let target_machine = machine_filter
                            .as_deref()
                            .and_then(|f| {
                                let fl = f.to_lowercase();
                                machines.iter().find(|m| {
                                    m.id.to_lowercase().starts_with(&fl)
                                        || m.name.to_lowercase().contains(&fl)
                                })
                            })
                            .or_else(|| machines.first());
                        if let Some(m) = target_machine {
                            status_msg = Some(format!("Opening new terminal on {}…", m.name));
                            let (cols, rows) = terminal::size().unwrap_or((120, 36));
                            let _ = client.claim_control(&m.id).await;
                            let default_cwd = active_space
                                .as_deref()
                                .and_then(|sid| spaces.iter().find(|s| s.id == sid))
                                .and_then(|s| s.default_cwd.as_deref())
                                .filter(|cwd| !cwd.trim().is_empty())
                                .unwrap_or(&m.home_dir);
                            let req = CreateTerminalRequest {
                                cwd: default_cwd,
                                startup_command: None,
                                cols: Some(cols),
                                rows: Some(rows),
                                device_id: Some(client.device_id()),
                                opened_by_label: None,
                            };
                            match client.create_terminal(&m.id, &req).await {
                                Ok(new_term) => {
                                    let _ = attach_interactive(config, client, &new_term, watch_only)
                                        .await;
                                    // Re-enter picker alt-screen and refresh list.
                                    let mut out = io::stdout();
                                    let _ = out.write_all(b"\x1b[?1049h");
                                    let _ = out.flush();
                                    if let Ok((m2, sp2, it2)) =
                                        load_sessions(client, machine_filter.as_deref()).await
                                    {
                                        machines = m2;
                                        spaces = sp2;
                                        items = it2;
                                        if let Some(ref sid) = active_space {
                                            if !spaces.iter().any(|s| &s.id == sid) {
                                                active_space = None;
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    status_msg = Some(format!("Open failed: {e}"));
                                }
                            }
                        } else {
                            status_msg = Some("No online machine available".to_string());
                        }
                    }
                    (KeyCode::Backspace, _) => {
                        query.pop();
                        selected = 0;
                        scroll = 0;
                    }
                    (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                        query.clear();
                        selected = 0;
                        scroll = 0;
                    }
                    (KeyCode::Enter, _) => {
                        if let Some(chosen) = filtered.get(selected) {
                            let term = chosen.terminal.clone();
                            let _ = attach_interactive(config, client, &term, watch_only).await;
                            // Re-enter picker alt-screen and refresh list after Ctrl+] detach.
                            let mut out = io::stdout();
                            let _ = out.write_all(b"\x1b[?1049h");
                            let _ = out.flush();
                            if let Ok((m2, sp2, it2)) =
                                load_sessions(client, machine_filter.as_deref()).await
                            {
                                machines = m2;
                                spaces = sp2;
                                items = it2;
                                if let Some(ref sid) = active_space {
                                    if !spaces.iter().any(|s| &s.id == sid) {
                                        active_space = None;
                                    }
                                }
                            }
                            status_msg = Some(format!("Detached from {}", display_title(&term)));
                        }
                    }
                    (KeyCode::Char(c), mods) if !mods.contains(KeyModifiers::CONTROL) && !mods.contains(KeyModifiers::ALT) => {
                        query.push(c);
                        selected = 0;
                        scroll = 0;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cycle_space, filter_items, resolve_session_space, FilterMode, SessionItem};
    use offdesk_protocol::{SpaceInfo, TerminalAttention, TerminalInfo};
    use std::collections::HashMap;

    fn space(id: &str, name: &str) -> SpaceInfo {
        SpaceInfo {
            id: id.to_string(),
            name: name.to_string(),
            icon: None,
            color: None,
            default_cwd: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn session(
        id: &str,
        title: &str,
        space_id: Option<&str>,
        space_name: Option<&str>,
        waiting: bool,
        last_activity_ms: Option<i64>,
    ) -> SessionItem {
        SessionItem {
            terminal: TerminalInfo {
                id: id.to_string(),
                machine_id: "m-1".to_string(),
                title: title.to_string(),
                cwd: "/home/dev/repo".to_string(),
                title_source: Default::default(),
                workspace_group_id: None,
                cols: 120,
                rows: 36,
                attention: waiting.then_some(TerminalAttention::Confirmation),
                opened_by: None,
                last_activity_ms,
                custom_title: None,
                reachable: true,
            },
            machine_name: "devbox".to_string(),
            display_title: title.to_string(),
            short_cwd: "~/repo".to_string(),
            space_id: space_id.map(str::to_string),
            space_name: space_name.map(str::to_string),
        }
    }

    #[test]
    fn cycle_space_wraps_forward_and_backward() {
        let spaces = vec![space("s1", "Work"), space("s2", "Personal")];
        assert_eq!(cycle_space(None, &spaces, true), Some("s1".to_string()));
        assert_eq!(
            cycle_space(Some("s1"), &spaces, true),
            Some("s2".to_string())
        );
        assert_eq!(cycle_space(Some("s2"), &spaces, true), None);

        assert_eq!(cycle_space(None, &spaces, false), Some("s2".to_string()));
        assert_eq!(
            cycle_space(Some("s2"), &spaces, false),
            Some("s1".to_string())
        );
        assert_eq!(cycle_space(Some("s1"), &spaces, false), None);

        assert_eq!(cycle_space(None, &[], true), None);
        assert_eq!(cycle_space(Some("missing"), &spaces, true), Some("s1".to_string()));
    }

    #[test]
    fn resolve_session_space_maps_group_to_space() {
        let mut group_spaces = HashMap::new();
        group_spaces.insert("g1".to_string(), "s1".to_string());
        let mut space_names = HashMap::new();
        space_names.insert("s1".to_string(), "Work".to_string());

        let mut term = session("t1", "api", None, None, false, None).terminal;
        assert_eq!(
            resolve_session_space(&term, &group_spaces, &space_names),
            (None, None)
        );
        term.workspace_group_id = Some("g1".to_string());
        assert_eq!(
            resolve_session_space(&term, &group_spaces, &space_names),
            (Some("s1".to_string()), Some("Work".to_string()))
        );
    }

    #[test]
    fn filter_items_combines_space_status_and_fuzzy_query() {
        let now = 100_000;
        let items = vec![
            session("t1", "api-server", Some("s1"), Some("Work"), true, Some(99_000)),
            session("t2", "web-ui", Some("s1"), Some("Work"), false, Some(95_000)),
            session("t3", "notes", Some("s2"), Some("Personal"), false, Some(1_000)),
            session("t4", "scratch", None, None, false, Some(98_000)),
        ];

        // All spaces, all statuses
        assert_eq!(filter_items(&items, "", FilterMode::All, None, now).len(), 4);

        // Space s1 only
        let s1_all = filter_items(&items, "", FilterMode::All, Some("s1"), now);
        assert_eq!(
            s1_all.iter().map(|i| i.terminal.id.as_str()).collect::<Vec<_>>(),
            vec!["t1", "t2"]
        );

        // Space s1 + Waiting
        let s1_wait = filter_items(&items, "", FilterMode::Waiting, Some("s1"), now);
        assert_eq!(
            s1_wait.iter().map(|i| i.terminal.id.as_str()).collect::<Vec<_>>(),
            vec!["t1"]
        );

        // Space s1 + Working
        let s1_work = filter_items(&items, "", FilterMode::Working, Some("s1"), now);
        assert_eq!(
            s1_work.iter().map(|i| i.terminal.id.as_str()).collect::<Vec<_>>(),
            vec!["t2"]
        );

        // Fuzzy search matches space name across all spaces
        let by_space_name = filter_items(&items, "personal", FilterMode::All, None, now);
        assert_eq!(
            by_space_name.iter().map(|i| i.terminal.id.as_str()).collect::<Vec<_>>(),
            vec!["t3"]
        );
    }
}
