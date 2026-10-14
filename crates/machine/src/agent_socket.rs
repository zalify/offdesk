//! The node's agent socket (docs/plans/2026-10-14-agent-runs.md, A2): coding agents'
//! hooks and reports (`offdesk hook …`, `offdesk run …`) write one JSON line
//! (`LocalAgentReport`) to a Unix socket in the config directory, readable only by this
//! user. The node finds the terminal from the tmux pane the agent runs in and passes the
//! signal to the hub. It only carries reports: nothing that comes in can control a
//! terminal, and agents never need a token.
use std::sync::Arc;
use std::time::Duration;

use offdesk_protocol::{LocalAgentReport, MachineToHub};
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast;

use crate::pty::{tmux_socket, PtyManager};

/// Longest line accepted (a question with its options fits easily).
const MAX_REPORT_BYTES: u64 = 64 * 1024;
/// A writer gets this long to send its line.
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Sources a report may name.
const SOURCES: [&str; 2] = ["hooks", "report"];

/// Checks a report that came in: a known source, from a pane of this node's tmux
/// server (its socket is named like ours), not another tmux the person runs.
pub fn accept(report: &LocalAgentReport, our_socket: &str) -> Result<(), &'static str> {
    if !SOURCES.contains(&report.source.as_str()) {
        return Err("unknown source");
    }
    if !report.tmux_pane.starts_with('%') || report.tmux_pane.len() > 16 {
        return Err("not a tmux pane");
    }
    let socket = report.tmux_socket.as_deref().ok_or("no tmux socket")?;
    let name = std::path::Path::new(socket)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("no tmux socket")?;
    if name != our_socket {
        return Err("another tmux server");
    }
    Ok(())
}

/// Listens on the agent socket until the node exits; each accepted report goes to
/// `signals` for whichever hub connection is up (none: it's dropped).
pub fn spawn(pty: Arc<PtyManager>, signals: broadcast::Sender<MachineToHub>) {
    let path = offdesk_protocol::agent_socket_path();
    tokio::spawn(async move {
        let listener = match bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::warn!("agent socket {} unavailable: {error}", path.display());
                return;
            }
        };
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let pty = pty.clone();
            let signals = signals.clone();
            tokio::spawn(async move {
                let mut line = Vec::new();
                let mut limited = (&mut stream).take(MAX_REPORT_BYTES);
                let read = limited.read_to_end(&mut line);
                if tokio::time::timeout(READ_TIMEOUT, read).await.is_err() {
                    return;
                }
                let Ok(report) = serde_json::from_slice::<LocalAgentReport>(line.trim_ascii())
                else {
                    return;
                };
                if let Err(reason) = accept(&report, tmux_socket()) {
                    tracing::debug!("agent report ignored: {reason}");
                    return;
                }
                let pane = report.tmux_pane.clone();
                let terminal =
                    tokio::task::spawn_blocking(move || pty.terminal_for_pane(&pane)).await;
                let Ok(Some(terminal_id)) = terminal else {
                    return;
                };
                let _ = signals.send(MachineToHub::AgentSignal {
                    terminal_id,
                    agent: report.agent,
                    source: report.source,
                    signal: report.signal,
                });
            });
        }
    });
}

fn bind(path: &std::path::Path) -> std::io::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A socket left by a node that exited; another live node would hold it
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_protocol::AgentSignal;

    fn report(pane: &str, socket: Option<&str>, source: &str) -> LocalAgentReport {
        LocalAgentReport {
            tmux_pane: pane.into(),
            tmux_socket: socket.map(str::to_string),
            agent: None,
            source: source.into(),
            signal: AgentSignal::Working,
        }
    }

    #[test]
    fn only_reports_from_this_nodes_tmux_are_taken() {
        let ours = "/tmp/tmux-501/offdesk";
        assert_eq!(
            accept(&report("%3", Some(ours), "hooks"), "offdesk"),
            Ok(())
        );
        assert_eq!(
            accept(&report("%3", Some(ours), "report"), "offdesk"),
            Ok(())
        );
        // Another tmux server with the same pane number
        assert_eq!(
            accept(
                &report("%3", Some("/tmp/tmux-501/default"), "hooks"),
                "offdesk"
            ),
            Err("another tmux server")
        );
        assert_eq!(
            accept(&report("%3", None, "hooks"), "offdesk"),
            Err("no tmux socket")
        );
        assert_eq!(
            accept(&report("3", Some(ours), "hooks"), "offdesk"),
            Err("not a tmux pane")
        );
        assert_eq!(
            accept(&report("%3", Some(ours), "admin"), "offdesk"),
            Err("unknown source")
        );
    }
}
