use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{self, disable_raw_mode, enable_raw_mode};
use futures::{SinkExt, StreamExt};
use offdesk_protocol::{MachineInfo, TerminalAttention, TerminalInfo};
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

async fn load_sessions(
    client: &HubClient,
    machine_filter: Option<&str>,
) -> Result<(Vec<MachineInfo>, Vec<SessionItem>), CliError> {
    let machines = client.machines().await?;
    let terminals = client.terminals().await?;
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
            SessionItem {
                terminal: t,
                machine_name,
                display_title: dt,
                short_cwd: sc,
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

    Ok((machines, items))
}

fn filter_items<'a>(
    items: &'a [SessionItem],
    query: &str,
    mode: FilterMode,
    now: i64,
) -> Vec<&'a SessionItem> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect();
    items
        .iter()
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
                "{} {} {} {}",
                item.display_title,
                item.machine_name,
                item.short_cwd,
                short_id(&item.terminal.id)
            )
            .to_lowercase();
            tokens.iter().all(|tok| hay.contains(tok))
        })
        .collect()
}

fn draw_picker(
    items: &[SessionItem],
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

    let waiting_cnt = items.iter().filter(|i| is_waiting(&i.terminal)).count();
    let working_cnt = items.iter().filter(|i| is_working(&i.terminal, now)).count();

    let mut buf = String::with_capacity(cols * rows * 2);
    // Synchronized output + home + clear
    buf.push_str("\x1b[?2026h\x1b[?25l\x1b[H\x1b[2J");

    // Line 1: Header
    let mode_badge = if watch_only { " [watch]" } else { "" };
    let header_left = format!(" offdesk tui{mode_badge}");
    let header_right = format!(
        "[{}]  {} wait · {} work · {} total ",
        mode.label(),
        waiting_cnt,
        working_cnt,
        items.len()
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
        buf.push_str("\x1b[38;2;113;113;122mFilter by title, project, machine, or id…\x1b[0m");
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
        buf.push_str("\r\n   \x1b[38;2;113;113;122mNo matching sessions. Press Tab to switch filter or Ctrl+N to open a new terminal.\x1b[0m\r\n");
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
            let title_avail = cols.saturating_sub(6 + meta_disp.width());
            let title_disp = truncate_width(&item.display_title, title_avail);
            let gap = cols.saturating_sub(5 + title_disp.width() + meta_disp.width());

            if is_sel {
                buf.push_str("\x1b[48;2;36;39;48m\x1b[38;2;163;230;53m▎\x1b[0m\x1b[48;2;36;39;48m ");
                buf.push_str(dot);
                buf.push_str("\x1b[48;2;36;39;48m\x1b[1;38;2;244;244;245m ");
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
                buf.push_str(" \x1b[38;2;228;228;231m");
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
        let hints = " ↑↓ move · Enter attach · Tab filter · ^N new · ^R refresh · ^] detach · Esc quit";
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
    let (_, items) = load_sessions(client, None).await?;
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
    let (mut machines, mut items) = load_sessions(client, machine_filter.as_deref()).await?;

    let mut query = String::new();
    let mut mode = FilterMode::All;
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
        let filtered = filter_items(&items, &query, mode, now);
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
                    (KeyCode::Char('r'), KeyModifiers::CONTROL) => {
                        status_msg = Some("Refreshing sessions…".to_string());
                        if let Ok((m, it)) = load_sessions(client, machine_filter.as_deref()).await {
                            machines = m;
                            items = it;
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
                            let req = CreateTerminalRequest {
                                cwd: &m.home_dir,
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
                                    if let Ok((m2, it2)) =
                                        load_sessions(client, machine_filter.as_deref()).await
                                    {
                                        machines = m2;
                                        items = it2;
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
                            if let Ok((m2, it2)) =
                                load_sessions(client, machine_filter.as_deref()).await
                            {
                                machines = m2;
                                items = it2;
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
