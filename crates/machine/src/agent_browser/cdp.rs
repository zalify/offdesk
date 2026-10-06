//! Minimal Chrome DevTools Protocol client.
//!
//! One browser-level WebSocket carries every page via flattened sessions:
//! commands for a page carry its `sessionId`, and events are broadcast with
//! the `sessionId` they came from so listeners can filter.

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Screenshots are large; tungstenite's default limits are far too small.
const MAX_WS_SIZE: usize = 64 * 1024 * 1024;
/// Synthetic event broadcast once when the connection ends.
pub const CLOSED_EVENT: &str = "__closed";
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub session_id: Option<String>,
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct CdpClient {
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next_id: AtomicU64,
    events: broadcast::Sender<CdpEvent>,
    closed: Arc<AtomicBool>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Arc<Self>, String> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_WS_SIZE))
            .max_frame_size(Some(MAX_WS_SIZE));
        let (ws, _) = tokio_tungstenite::connect_async_with_config(ws_url, Some(config), false)
            .await
            .map_err(|e| format!("CDP connect failed: {e}"))?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (events, _) = broadcast::channel(2048);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                while let Some(Ok(msg)) = stream.next().await {
                    let Message::Text(text) = msg else {
                        if matches!(msg, Message::Close(_)) {
                            break;
                        }
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if let Some(id) = v.get("id").and_then(Value::as_u64) {
                        let tx = pending.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let res = match v.get("error") {
                                Some(err) => Err(err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("CDP error")
                                    .to_string()),
                                None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(res);
                        }
                    } else if let Some(method) = v.get("method").and_then(Value::as_str) {
                        let _ = events.send(CdpEvent {
                            session_id: v
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            method: method.to_string(),
                            params: v.get("params").cloned().unwrap_or(Value::Null),
                        });
                    }
                }
                closed.store(true, Ordering::SeqCst);
                // Lets listeners notice Chromium dying without a command.
                let _ = events.send(CdpEvent {
                    session_id: None,
                    method: CLOSED_EVENT.to_string(),
                    params: Value::Null,
                });
                let drained: Vec<_> = pending.lock().unwrap().drain().collect();
                for (_, tx) in drained {
                    let _ = tx.send(Err("browser connection closed".to_string()));
                }
            });
        }

        Ok(Arc::new(Self {
            out,
            pending,
            next_id: AtomicU64::new(1),
            events,
            closed,
        }))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    /// Send a command (optionally to a flattened session) and await its reply.
    pub async fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if self.is_closed() {
            return Err("browser connection closed".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self
            .out
            .send(Message::Text(msg.to_string().into()))
            .is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err("browser connection closed".to_string());
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("browser connection closed".to_string()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("CDP call {method} timed out"))
            }
        }
    }
}
