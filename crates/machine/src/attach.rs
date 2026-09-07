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

/// Per-machine collection of live attaches.
///
/// Each attach owns one `tmux attach-session` subprocess + the PTY it speaks
/// over. Browsers don't share attaches; tmux's multi-client design gives
/// each browser an independent client view of the same session.
pub struct AttachManager {
    inner: Arc<Mutex<HashMap<String, AttachHandle>>>,
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
        let sender = self
            .inner
            .lock()
            .await
            .get(attach_id)
            .map(|h| h.command_tx.clone())
            .ok_or(ComposerStatus::Failed)?;
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
        let command_tx = {
            let inner = self.inner.lock().await;
            inner.get(attach_id).map(|handle| handle.command_tx.clone())
        };
        if let Some(command_tx) = command_tx {
            command_tx.send(AttachCommand::Input(data)).await.is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, attach_id: &str, cols: u16, rows: u16) -> bool {
        let command_tx = {
            let inner = self.inner.lock().await;
            inner.get(attach_id).map(|handle| handle.command_tx.clone())
        };
        if let Some(command_tx) = command_tx {
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
