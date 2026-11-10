use bytes::Bytes;
use portable_pty::PtySize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::pty::spawn_tmux_attach;

/// Reason a per-client tmux attach ended.
#[derive(Debug, Clone)]
pub enum AttachExitReason {
    /// Hub asked us to close (the consumer dropped events_rx). Treated the
    /// same as a clean close from the user's point of view.
    HubRequested,
    /// The tmux attach process exited (PTY EOF or `tmux ls` lost the
    /// session). Includes shell-died, session-killed, tmux-server-died.
    ProcessExited,
    /// Could not spawn the attach or read from its PTY. Should be rare.
    IoError(String),
}

impl std::fmt::Display for AttachExitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HubRequested => write!(f, "hub requested close"),
            Self::ProcessExited => write!(f, "tmux attach process exited"),
            Self::IoError(e) => write!(f, "io error: {}", e),
        }
    }
}

/// Outbound event from a single attach task to the hub-conn forwarding loop.
#[derive(Debug)]
pub enum AttachEvent {
    Output(Bytes),
    Died(AttachExitReason),
}

#[derive(Debug)]
enum AttachCommand {
    Input(Bytes),
    Composer {
        paste: Bytes,
        ack: tokio::sync::oneshot::Sender<bool>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Ask tmux to fully redraw this attach's client (hub dropped output
    /// frames for a slow browser and needs the screen repaired).
    Refresh,
}

/// How long after a viewer nudged a session (resized it, or its terminal sent
/// a focus or mouse report) its output counts as the repaint the nudge caused
/// rather than as activity: full-screen programs repaint on SIGWINCH and on
/// focus-in, and tmux counts the repaint as output. Attaching repaints only
/// the client.
pub const VIEW_NUDGE_GRACE_MS: i64 = 3_000;

/// Per-machine collection of live attaches.
///
/// Each attach owns one `tmux attach-session` subprocess + the PTY it speaks
/// over. Browsers don't share attaches; tmux's multi-client design gives
/// each browser an independent client view of the same session.
pub struct AttachManager {
    inner: Arc<Mutex<HashMap<String, AttachHandle>>>,
    /// Per session: when a viewer last nudged it, in ms since the epoch.
    view_nudges: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    /// Per session: when someone last typed into it, in ms since the epoch.
    typed_inputs: Arc<std::sync::Mutex<HashMap<String, i64>>>,
}

struct AttachHandle {
    /// Sending here controls the attach's PTY.
    /// Dropping this is the close signal — the writer thread sees the
    /// channel close, kills the tmux attach child, and the reader thread
    /// follows on PTY EOF.
    command_tx: mpsc::Sender<AttachCommand>,
    /// Recorded so callers can look up which session this attach belongs to
    /// (e.g., to issue `tmux resize-window` against the right session).
    session_id: String,
}

impl AttachManager {
    pub async fn write_composer(
        &self,
        attach_id: &str,
        paste: Bytes,
    ) -> Result<(), offdesk_protocol::ComposerStatus> {
        use offdesk_protocol::ComposerStatus;
        let (sender, session_id) = self
            .inner
            .lock()
            .await
            .get(attach_id)
            .map(|h| (h.command_tx.clone(), h.session_id.clone()))
            .ok_or(ComposerStatus::Failed)?;
        self.note_typed_input(&session_id);
        let (ack, rx) = tokio::sync::oneshot::channel();
        sender
            .send(AttachCommand::Composer { paste, ack })
            .await
            .map_err(|_| ComposerStatus::Failed)?;
        match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
            Ok(Ok(true)) => Ok(()),
            _ => Err(ComposerStatus::Unknown),
        }
    }
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            view_nudges: Arc::new(std::sync::Mutex::new(HashMap::new())),
            typed_inputs: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Open a new attach for the given session. Returns a receiver that
    /// yields one `AttachEvent::Output` per chunk read from the PTY,
    /// followed by exactly one `AttachEvent::Died` when the attach ends.
    pub async fn open(
        &self,
        attach_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> mpsc::Receiver<AttachEvent> {
        let (events_tx, events_rx) = mpsc::channel::<AttachEvent>(64);
        let (command_tx, command_rx) = mpsc::channel::<AttachCommand>(64);

        self.inner.lock().await.insert(
            attach_id.clone(),
            AttachHandle {
                command_tx,
                session_id: session_id.clone(),
            },
        );

        std::thread::spawn(move || {
            run_attach_task(attach_id, session_id, cols, rows, events_tx, command_rx);
        });

        events_rx
    }

    pub async fn write_input(&self, attach_id: &str, data: Bytes) -> bool {
        // Clone the sender out from under the lock; awaiting send() while
        // holding the async Mutex would block close() / close_all() /
        // session_of() if the writer thread is slow to drain command_rx.
        let handle = {
            let inner = self.inner.lock().await;
            inner
                .get(attach_id)
                .map(|handle| (handle.command_tx.clone(), handle.session_id.clone()))
        };
        if let Some((command_tx, session_id)) = handle {
            // Focusing a pane in the app sends only a focus report.
            if is_typed_input(&data) {
                self.note_typed_input(&session_id);
            } else {
                self.note_view_nudge(&session_id);
            }
            command_tx.send(AttachCommand::Input(data)).await.is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, attach_id: &str, cols: u16, rows: u16) -> bool {
        let handle = {
            let inner = self.inner.lock().await;
            inner
                .get(attach_id)
                .map(|handle| (handle.command_tx.clone(), handle.session_id.clone()))
        };
        if let Some((command_tx, session_id)) = handle {
            self.note_view_nudge(&session_id);
            command_tx
                .send(AttachCommand::Resize { cols, rows })
                .await
                .is_ok()
        } else {
            false
        }
    }

    /// Request a full tmux redraw of this attach's client.
    pub async fn refresh(&self, attach_id: &str) -> bool {
        let command_tx = {
            let inner = self.inner.lock().await;
            inner.get(attach_id).map(|handle| handle.command_tx.clone())
        };
        if let Some(command_tx) = command_tx {
            command_tx.send(AttachCommand::Refresh).await.is_ok()
        } else {
            false
        }
    }

    /// Drop the attach handle. The writer thread sees its input channel
    /// close, kills the tmux attach child, and the reader thread exits on
    /// PTY EOF — eventually emitting an `AttachEvent::Died` to the consumer.
    pub async fn close(&self, attach_id: &str) {
        self.inner.lock().await.remove(attach_id);
    }

    pub async fn close_all(&self) {
        self.inner.lock().await.clear();
    }

    pub async fn session_of(&self, attach_id: &str) -> Option<String> {
        self.inner
            .lock()
            .await
            .get(attach_id)
            .map(|h| h.session_id.clone())
    }

    fn note_view_nudge(&self, session_id: &str) {
        stamp_now(&self.view_nudges, session_id);
    }

    /// Record that someone typed into a session: a person in an app, or an
    /// answer sent to its agent.
    pub fn note_typed_input(&self, session_id: &str) {
        stamp_now(&self.typed_inputs, session_id);
    }

    /// When someone last typed into a session, in ms since the epoch.
    pub fn last_typed_input(&self, session_id: &str) -> Option<i64> {
        self.typed_inputs
            .lock()
            .ok()
            .and_then(|inputs| inputs.get(session_id).copied())
    }

    /// Whether a session's last output (`activity_ms`) is the redraw a
    /// viewer caused, so it should not count as the session being active.
    pub fn is_view_redraw(&self, session_id: &str, activity_ms: i64) -> bool {
        let nudge_ms = self
            .view_nudges
            .lock()
            .ok()
            .and_then(|nudges| nudges.get(session_id).copied());
        explained_by_view_nudge(nudge_ms, activity_ms)
    }

    /// Forget the nudges and input times of sessions that no longer exist.
    pub fn retain_sessions(&self, keep: impl Fn(&str) -> bool) {
        for map in [&self.view_nudges, &self.typed_inputs] {
            if let Ok(mut times) = map.lock() {
                times.retain(|session_id, _| keep(session_id));
            }
        }
    }
}

fn stamp_now(times: &std::sync::Mutex<HashMap<String, i64>>, session_id: &str) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    if let Ok(mut times) = times.lock() {
        times.insert(session_id.to_string(), now_ms);
    }
}

/// Whether input holds something typed (keys, a paste) rather than only what
/// the viewing terminal sends by itself: focus reports, mouse reports, and
/// replies to the program's queries (cursor position, device attributes,
/// colours). A modified F3 (`ESC [ 1 ; 2 R`) reads as a cursor report.
fn is_typed_input(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        if data[i] != 0x1b {
            return true;
        }
        match data.get(i + 1) {
            // A lone Escape key.
            None => return true,
            Some(b'[') => {
                let start = i + 2;
                let mut end = start;
                while data.get(end).is_some_and(|b| (0x20..=0x3f).contains(b)) {
                    end += 1;
                }
                let Some(&last) = data.get(end) else {
                    return true;
                };
                let params = &data[start..end];
                let reply = match last {
                    // X10 mouse report: three bytes follow.
                    b'M' if params.is_empty() => {
                        i = end + 4;
                        continue;
                    }
                    b'I' | b'O' => params.is_empty(),
                    b'M' | b'm' => params.first() == Some(&b'<'),
                    b'c' => matches!(params.first(), Some(b'?' | b'>' | b'=')),
                    b'u' => params.first() == Some(&b'?'),
                    b'y' => params.ends_with(b"$"),
                    b'R' | b'n' | b't' => true,
                    _ => false,
                };
                if !reply {
                    return true;
                }
                i = end + 1;
            }
            // OSC, DCS, APC and PM replies, ended by BEL or ST.
            Some(b']' | b'P' | b'_' | b'^') => {
                let mut end = i + 2;
                loop {
                    match data.get(end) {
                        None => return false,
                        Some(0x07) => {
                            end += 1;
                            break;
                        }
                        Some(0x1b) if data.get(end + 1) == Some(&b'\\') => {
                            end += 2;
                            break;
                        }
                        Some(_) => end += 1,
                    }
                }
                i = end;
            }
            // Alt+key, and the SS3 keys (`ESC O A`).
            Some(_) => return true,
        }
    }
    false
}

/// tmux reports activity in whole seconds, so the nudge's second counts
/// from its start.
fn explained_by_view_nudge(nudge_ms: Option<i64>, activity_ms: i64) -> bool {
    let Some(nudge_ms) = nudge_ms else {
        return false;
    };
    activity_ms >= nudge_ms - nudge_ms.rem_euclid(1000)
        && activity_ms <= nudge_ms + VIEW_NUDGE_GRACE_MS
}

impl Default for AttachManager {
    fn default() -> Self {
        Self::new()
    }
}

fn run_attach_task(
    attach_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
    events_tx: mpsc::Sender<AttachEvent>,
    mut command_rx: mpsc::Receiver<AttachCommand>,
) {
    let _ = attach_id; // reserved for tracing in a future change

    // Spawn the tmux attach. On failure we report Died and bail.
    let attach = match spawn_tmux_attach(&session_id, cols, rows) {
        Ok(v) => v,
        Err(e) => {
            let _ = events_tx.blocking_send(AttachEvent::Died(AttachExitReason::IoError(e)));
            return;
        }
    };
    let mut writer = attach.writer;
    let reader = attach.reader;
    let mut child = attach.child;
    let master = attach.master;

    // Reader thread: blocking PTY reads → events_tx. Owns the reader handle
    // and emits the Died event when the PTY closes (which happens on shell
    // exit, tmux session kill, or this main thread killing the child).
    let reader_events_tx = events_tx.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 16_384];
        let exit = loop {
            match reader.read(&mut buf) {
                Ok(0) => break AttachExitReason::ProcessExited,
                Ok(n) => {
                    let chunk = Bytes::copy_from_slice(&buf[..n]);
                    if reader_events_tx
                        .blocking_send(AttachEvent::Output(chunk))
                        .is_err()
                    {
                        // Consumer of events_rx is gone; nothing left to do.
                        break AttachExitReason::HubRequested;
                    }
                }
                Err(e) => break AttachExitReason::IoError(e.to_string()),
            }
        };
        let _ = reader_events_tx.blocking_send(AttachEvent::Died(exit));
    });

    // The tmux client behind this attach is the spawned child process;
    // its pid is how a Refresh finds the right client to redraw.
    let child_pid = child.process_id();

    // Writer loop on this thread: commands → PTY. Exits when command_tx is
    // dropped (close_attach / AttachManager dropped).
    while let Some(command) = command_rx.blocking_recv() {
        match command {
            AttachCommand::Composer { paste, ack } => {
                // Keep the paste and its submit key together in the writer
                // queue. Give terminal applications a chance to process the
                // bracketed paste before handling Enter as a separate key.
                let pasted = writer
                    .write_all(&paste)
                    .and_then(|_| writer.flush())
                    .is_ok();
                if pasted {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let delivered =
                    pasted && writer.write_all(b"\r").and_then(|_| writer.flush()).is_ok();
                let _ = ack.send(delivered);
                if !delivered {
                    break;
                }
            }
            AttachCommand::Input(chunk) => {
                if writer.write_all(&chunk).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            AttachCommand::Resize { cols, rows } => {
                if master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .is_err()
                {
                    break;
                }
            }
            AttachCommand::Refresh => {
                if let Some(pid) = child_pid {
                    crate::pty::refresh_tmux_client_by_pid(pid);
                }
            }
        }
    }

    // Force the child down so the reader thread sees PTY EOF and finishes.
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader_handle.join();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check: the manager can be constructed and cleaned up without
    /// spawning anything. Real attach behavior is exercised by the new E2E
    /// specs (`terminal-multi-attach`, `terminal-attach-recovery`); a unit
    /// test would need an injectable tmux socket which the current
    /// `spawn_tmux_attach` doesn't expose.
    #[test]
    fn typed_input_is_told_from_what_the_terminal_sends_itself() {
        for typed in [
            &b"ls\r"[..],
            b"\r",
            b"\x03",
            b"\x1b",
            b"\x1b[A",
            b"\x1bOA",
            b"\x1bb",
            b"\x1b[3~",
            b"\x1b[200~pasted\x1b[201~",
            b"\x1b[Ia",
        ] {
            assert!(is_typed_input(typed), "{typed:?}");
        }
        for own in [
            &b""[..],
            b"\x1b[I",
            b"\x1b[O\x1b[I",
            b"\x1b[<35;10;5M",
            b"\x1b[<0;10;5m",
            b"\x1b[M #!",
            b"\x1b[12;40R",
            b"\x1b[?1;2c",
            b"\x1b[>0;276;0c",
            b"\x1b[?2026;2$y",
            b"\x1b[?0u",
            b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1bP>|xterm.js(5.5.0)\x1b\\",
        ] {
            assert!(!is_typed_input(own), "{own:?}");
        }
    }

    #[test]
    fn output_just_after_a_view_nudge_is_its_redraw() {
        // Nudged at 10.7s: tmux stamps the repaint 10s, 11s, ... 13s.
        assert!(explained_by_view_nudge(Some(10_700), 10_000));
        assert!(explained_by_view_nudge(Some(10_700), 13_000));
        assert!(!explained_by_view_nudge(Some(10_700), 14_000));
        assert!(!explained_by_view_nudge(Some(10_700), 9_000));
        assert!(!explained_by_view_nudge(None, 10_000));
    }

    #[tokio::test]
    async fn resize_marks_the_session_nudged() {
        let mgr = AttachManager::new();
        let (command_tx, _command_rx) = mpsc::channel::<AttachCommand>(1);
        mgr.inner.lock().await.insert(
            "attach-a".to_string(),
            AttachHandle {
                command_tx,
                session_id: "term-a".to_string(),
            },
        );
        let now_s = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
        };
        assert!(!mgr.is_view_redraw("term-a", now_s() * 1000));
        assert!(mgr.resize("attach-a", 132, 40).await);
        // The repaint lands in the same second or just after.
        let repaint_ms = now_s() * 1000;
        assert!(mgr.is_view_redraw("term-a", repaint_ms));
        assert!(!mgr.is_view_redraw("term-b", repaint_ms));
        mgr.retain_sessions(|_| false);
        assert!(!mgr.is_view_redraw("term-a", repaint_ms));
    }

    #[tokio::test]
    async fn typing_is_recorded_and_focusing_is_not() {
        let mgr = AttachManager::new();
        let (command_tx, _command_rx) = mpsc::channel::<AttachCommand>(4);
        mgr.inner.lock().await.insert(
            "attach-a".to_string(),
            AttachHandle {
                command_tx,
                session_id: "term-a".to_string(),
            },
        );
        assert!(mgr.write_input("attach-a", Bytes::from_static(b"\x1b[I")).await);
        assert_eq!(mgr.last_typed_input("term-a"), None);
        assert!(mgr.write_input("attach-a", Bytes::from_static(b"y")).await);
        assert!(mgr.last_typed_input("term-a").is_some());
        assert_eq!(mgr.last_typed_input("term-b"), None);
        mgr.retain_sessions(|_| false);
        assert_eq!(mgr.last_typed_input("term-a"), None);
    }

    #[tokio::test]
    async fn manager_construct_and_drop() {
        let mgr = AttachManager::new();
        mgr.close_all().await;
    }

    #[tokio::test]
    async fn resize_sends_resize_command_to_existing_attach() {
        let mgr = AttachManager::new();
        let (command_tx, mut command_rx) = mpsc::channel::<AttachCommand>(1);

        mgr.inner.lock().await.insert(
            "attach-a".to_string(),
            AttachHandle {
                command_tx,
                session_id: "term-a".to_string(),
            },
        );

        assert!(mgr.resize("attach-a", 132, 40).await);

        match command_rx.recv().await {
            Some(AttachCommand::Resize { cols, rows }) => {
                assert_eq!(cols, 132);
                assert_eq!(rows, 40);
            }
            other => panic!("expected resize command, got {other:?}"),
        }
    }
}
