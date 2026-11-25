use crate::config::ClientConfig;
use futures::{SinkExt, StreamExt};
use offdesk_protocol::compression::AttachInflater;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MachineEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub home_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TerminalEntry {
    pub id: String,
    pub machine_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_true")]
    pub reachable: bool,
    #[serde(default)]
    pub attention: Option<String>,
    #[serde(default)]
    pub last_activity_ms: Option<i64>,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    40
}
fn default_true() -> bool {
    true
}

impl TerminalEntry {
    pub fn display_name(&self) -> String {
        let t = self.title.trim();
        if !t.is_empty() {
            // Strip noisy CLI flags (e.g. "agy --dangerously-sk ~/p/webmux" -> "agy · webmux").
            let mut parts = t.split_whitespace();
            if let Some(cmd) = parts.next() {
                let rest: Vec<&str> = parts.collect();
                let is_known_cli = matches!(
                    cmd.to_ascii_lowercase().as_str(),
                    "agy" | "claude" | "codex" | "gemini" | "aider" | "opencode" | "goose"
                        | "fish" | "zsh" | "bash" | "sh" | "nvim" | "vim" | "hx"
                );
                if is_known_cli && rest.iter().any(|tok| tok.starts_with('-')) {
                    let path_hint = rest
                        .iter()
                        .rev()
                        .find(|tok| !tok.starts_with('-') && (tok.contains('/') || **tok == "~"))
                        .copied();
                    let dir = path_hint
                        .or(if self.cwd.is_empty() { None } else { Some(self.cwd.as_str()) })
                        .and_then(|p| p.trim_end_matches('/').rsplit('/').next())
                        .filter(|s| !s.is_empty());
                    return match dir {
                        Some(d) => format!("{cmd} · {d}"),
                        None => cmd.to_string(),
                    };
                }
            }
            return t.to_string();
        }
        let cleaned = self.cwd.trim_end_matches('/');
        cleaned
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("shell")
            .to_string()
    }

    pub fn is_waiting(&self) -> bool {
        self.reachable && self.attention.is_some()
    }

    /// Derive a stable project/workspace group name from `cwd` (zero-config).
    /// Git worktrees under `~/projects/<repo>/<worktree>` automatically group under `<repo>`.
    pub fn project_group(&self) -> String {
        let raw = self.cwd.trim().trim_end_matches('/');
        if raw.is_empty() || raw == "~" || raw == "/" {
            return "~".to_string();
        }
        let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
        // Treat bare home directories (`/home/<user>` or `/Users/<user>`) as `~`.
        if segments.len() == 2 && matches!(segments[0], "home" | "Users") {
            return "~".to_string();
        }
        // If path passes through a common projects root, use the immediate child as the project name
        // so sibling worktrees (e.g. `.../projects/webmux/feat-foo`) stay in the same group.
        for (i, seg) in segments.iter().enumerate() {
            if matches!(
                seg.to_ascii_lowercase().as_str(),
                "projects" | "project" | "repos" | "repo" | "code" | "workspace" | "workspaces" | "work" | "dev" | "github"
            ) {
                if let Some(project) = segments.get(i + 1) {
                    return (*project).to_string();
                }
            }
        }
        segments
            .last()
            .copied()
            .unwrap_or("~")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term_with_cwd(cwd: &str) -> TerminalEntry {
        TerminalEntry {
            id: "t1".into(),
            machine_id: "m1".into(),
            title: "agy".into(),
            cwd: cwd.into(),
            cols: 120,
            rows: 40,
            reachable: true,
            attention: None,
            last_activity_ms: None,
        }
    }

    #[test]
    fn project_group_extracts_repo_and_collapses_worktrees() {
        assert_eq!(
            term_with_cwd("/home/chareice/projects/webmux/feat-antigravity-support").project_group(),
            "webmux"
        );
        assert_eq!(
            term_with_cwd("/home/chareice/projects/jiashun").project_group(),
            "jiashun"
        );
        assert_eq!(term_with_cwd("/home/chareice").project_group(), "~");
        assert_eq!(term_with_cwd("~").project_group(), "~");
        assert_eq!(term_with_cwd("/var/services/offdesk").project_group(), "offdesk");
    }
}

#[derive(Debug, Clone)]
pub enum HubEvent {
    Inventory {
        machines: Vec<MachineEntry>,
        terminals: Vec<TerminalEntry>,
    },
    TerminalOutput {
        terminal_id: String,
        bytes: Vec<u8>,
    },
    TerminalResized {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    TerminalCreated(TerminalEntry),
    Error(String),
}

#[derive(Debug)]
pub enum HubCommand {
    RefreshInventory,
    EnsureAttach {
        machine_id: String,
        terminal_id: String,
    },
    SendInput {
        terminal_id: String,
        data: String,
    },
    Resize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    ClaimControl {
        machine_id: String,
    },
    CreateTerminal {
        machine_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    },
}

enum SocketCmd {
    Input(String),
    Resize(u16, u16),
}

pub fn spawn_hub_worker(
    cfg: ClientConfig,
    mut cmd_rx: mpsc::UnboundedReceiver<HubCommand>,
    on_event: Arc<dyn Fn(HubEvent) + Send + Sync>,
) {
    tokio::spawn(async move {
        let http = build_http_client(&cfg.hub_url);
        let mut sockets: HashMap<String, mpsc::UnboundedSender<SocketCmd>> = HashMap::new();
        let mut claimed_machines: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        // Initial inventory fetch + periodic 5s background refresh.
        let fetch = || {
            let http = http.clone();
            let cfg = cfg.clone();
            let on_event = Arc::clone(&on_event);
            async move {
                match fetch_inventory(&http, &cfg).await {
                    Ok((machines, terminals)) => {
                        on_event(HubEvent::Inventory {
                            machines,
                            terminals,
                        });
                    }
                    Err(e) => on_event(HubEvent::Error(e)),
                }
            }
        };
        fetch().await;

        let mut poll = tokio::time::interval(std::time::Duration::from_secs(5));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = poll.tick() => {
                    fetch().await;
                }
                maybe_cmd = cmd_rx.recv() => {
                    let Some(cmd) = maybe_cmd else { break };
                    match cmd {
                        HubCommand::RefreshInventory => {
                            fetch().await;
                        }
                        HubCommand::EnsureAttach { machine_id, terminal_id } => {
                            if sockets.get(&terminal_id).is_some_and(|tx| !tx.is_closed()) {
                                continue;
                            }
                            let (tx, rx) = mpsc::unbounded_channel();
                            sockets.insert(terminal_id.clone(), tx);
                            spawn_terminal_socket(
                                cfg.clone(),
                                machine_id,
                                terminal_id,
                                rx,
                                Arc::clone(&on_event),
                            );
                        }
                        HubCommand::SendInput { terminal_id, data } => {
                            if let Some(tx) = sockets.get(&terminal_id) {
                                let _ = tx.send(SocketCmd::Input(data));
                            }
                        }
                        HubCommand::Resize { terminal_id, cols, rows } => {
                            if let Some(tx) = sockets.get(&terminal_id) {
                                let _ = tx.send(SocketCmd::Resize(cols, rows));
                            }
                        }
                        HubCommand::ClaimControl { machine_id } => {
                            if claimed_machines.contains(&machine_id) {
                                continue;
                            }
                            let http = http.clone();
                            let cfg = cfg.clone();
                            let mid = machine_id.clone();
                            claimed_machines.insert(machine_id);
                            tokio::spawn(async move {
                                let _ = claim_control(&http, &cfg, &mid).await;
                            });
                        }
                        HubCommand::CreateTerminal { machine_id, cwd, cols, rows } => {
                            let http = http.clone();
                            let cfg = cfg.clone();
                            let on_event = Arc::clone(&on_event);
                            tokio::spawn(async move {
                                match create_terminal(&http, &cfg, &machine_id, &cwd, cols, rows).await {
                                    Ok(term) => on_event(HubEvent::TerminalCreated(term)),
                                    Err(e) => on_event(HubEvent::Error(e)),
                                }
                            });
                        }
                    }
                }
            }
        }
    });
}

fn build_http_client(hub_url: &str) -> reqwest::Client {
    let local = offdesk_protocol::local_host::host_of(hub_url)
        .is_some_and(offdesk_protocol::local_host::is_local_host);
    let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
    if local {
        builder.no_proxy().build().unwrap_or_default()
    } else {
        builder.build().unwrap_or_default()
    }
}

async fn fetch_inventory(
    http: &reqwest::Client,
    cfg: &ClientConfig,
) -> Result<(Vec<MachineEntry>, Vec<TerminalEntry>), String> {
    let m_req = http
        .get(format!("{}/api/machines", cfg.hub_url))
        .bearer_auth(&cfg.token)
        .send();
    let t_req = http
        .get(format!("{}/api/terminals", cfg.hub_url))
        .bearer_auth(&cfg.token)
        .send();

    let (m_resp, t_resp) = tokio::try_join!(m_req, t_req).map_err(|e| e.to_string())?;
    let machines: Vec<MachineEntry> = m_resp
        .error_for_status()
        .map_err(|e| format!("machines API: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse machines: {e}"))?;
    let terminals: Vec<TerminalEntry> = t_resp
        .error_for_status()
        .map_err(|e| format!("terminals API: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse terminals: {e}"))?;
    Ok((machines, terminals))
}

async fn claim_control(
    http: &reqwest::Client,
    cfg: &ClientConfig,
    machine_id: &str,
) -> Result<(), String> {
    http.post(format!("{}/api/machines/{}/control", cfg.hub_url, machine_id))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({ "device_id": cfg.device_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn create_terminal(
    http: &reqwest::Client,
    cfg: &ClientConfig,
    machine_id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<TerminalEntry, String> {
    let resp = http
        .post(format!("{}/api/machines/{}/terminals", cfg.hub_url, machine_id))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({
            "cwd": cwd,
            "cols": cols,
            "rows": rows,
            "device_id": cfg.device_id,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.error_for_status()
        .map_err(|e| format!("create terminal: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse created terminal: {e}"))
}

fn spawn_terminal_socket(
    cfg: ClientConfig,
    machine_id: String,
    terminal_id: String,
    mut cmd_rx: mpsc::UnboundedReceiver<SocketCmd>,
    on_event: Arc<dyn Fn(HubEvent) + Send + Sync>,
) {
    tokio::spawn(async move {
        let ws_url = cfg.terminal_ws_url(&machine_id, &terminal_id);
        let ws_cfg = WebSocketConfig::default();
        let conn = tokio_tungstenite::connect_async_with_config(&ws_url, Some(ws_cfg), true).await;
        let (ws_stream, _) = match conn {
            Ok(v) => v,
            Err(e) => {
                on_event(HubEvent::Error(format!(
                    "WS connect {} failed: {}",
                    &terminal_id[..8.min(terminal_id.len())],
                    e
                )));
                return;
            }
        };

        let (mut write, mut read) = ws_stream.split();
        let mut inflater: Option<AttachInflater> = None;

        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    let msg = match cmd {
                        SocketCmd::Input(data) => serde_json::json!({ "type": "input", "data": data }),
                        SocketCmd::Resize(cols, rows) => serde_json::json!({ "type": "resize", "cols": cols, "rows": rows }),
                    };
                    if write.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                }
                maybe_msg = read.next() => {
                    let Some(Ok(msg)) = maybe_msg else { break };
                    match msg {
                        Message::Binary(raw) => {
                            let bytes = if let Some(inf) = &mut inflater {
                                match inf.push(&raw) {
                                    Ok(out) => out,
                                    Err(_) => raw.to_vec(),
                                }
                            } else {
                                raw.to_vec()
                            };
                            if !bytes.is_empty() {
                                on_event(HubEvent::TerminalOutput {
                                    terminal_id: terminal_id.clone(),
                                    bytes,
                                });
                            }
                        }
                        Message::Text(text) => {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                match val.get("type").and_then(|t| t.as_str()) {
                                    Some("compression_enabled") | Some("compression") => {
                                        if val.get("algo").and_then(|a| a.as_str()) == Some("deflate-raw-v1") {
                                            inflater = Some(AttachInflater::new());
                                        }
                                    }
                                    Some("resized") => {
                                        if let (Some(c), Some(r)) = (
                                            val.get("cols").and_then(|v| v.as_u64()),
                                            val.get("rows").and_then(|v| v.as_u64()),
                                        ) {
                                            on_event(HubEvent::TerminalResized {
                                                terminal_id: terminal_id.clone(),
                                                cols: c as u16,
                                                rows: r as u16,
                                            });
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Message::Ping(p) => {
                            let _ = write.send(Message::Pong(p)).await;
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
    });
}
