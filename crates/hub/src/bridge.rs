//! Bridges (docs/plans/2026-10-14-agent-runs-external-access.md, B3;
//! docs/agent-bridge-protocol.md): the hub keeps a WebSocket open to a server the
//! person paired, so the server sees agent runs and, within what the person allowed on
//! this hub, answers them and starts agents. The hub always dials out: nothing has to
//! reach it.
//!
//! Events are the same as webhooks', from the same outbox: an event's `seq` is its
//! outbox id, and the server's `ack {seq}` marks everything up to it delivered. Each
//! connection sends `hello`, a `snapshot`, then every event not yet acknowledged, so a
//! long disconnect loses nothing and the server drops repeats by seq. Commands go
//! through the same code as the HTTP API (`answer_as`, `start_as`): the bridge acts as a
//! scoped caller named `bridge:<name>`, with its integration's access, limits and audit.
//! Terminal output never goes over a bridge.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use offdesk_protocol::{AgentAnswer, AgentPermissionMode, RunAgent, StartAgentRun, TokenScope};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue, Message};
use tokio_util::sync::CancellationToken;

use crate::auth::AuthUser;
use crate::db::{self, integrations::{self, Integration}};
use crate::AppState;

/// The protocol version this hub speaks (`hello.protocol`).
pub const PROTOCOL: u32 = 1;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PING_EVERY: Duration = Duration::from_secs(30);
/// Nothing from the server for this long: the connection is dead.
const SILENT_FOR: Duration = Duration::from_secs(90);
/// Events are also looked for this often, besides being woken.
const POLL_EVERY: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// The run history a snapshot carries.
const SNAPSHOT_RECENT_MS: i64 = 24 * 3600 * 1000;

/// Wakes connected bridges when events are queued.
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn wake() {
    WAKE.notify_waiters();
}

/// How a bridge's connection is doing, for its listing.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Status {
    pub connected: bool,
    /// When the current connection opened.
    pub since_ms: Option<i64>,
    pub last_error: Option<String>,
}

struct Handle {
    cancel: CancellationToken,
    status: Arc<Mutex<Status>>,
}

static STATE: OnceLock<AppState> = OnceLock::new();
static BRIDGES: OnceLock<Mutex<HashMap<String, Handle>>> = OnceLock::new();

fn bridges() -> &'static Mutex<HashMap<String, Handle>> {
    BRIDGES.get_or_init(Default::default)
}

/// Connects every enabled bridge, and keeps `sync` able to start more.
pub fn start(state: AppState) {
    let enabled = state
        .db
        .get()
        .ok()
        .and_then(|conn| integrations::enabled_bridges(&conn).ok())
        .unwrap_or_default();
    let _ = STATE.set(state);
    for bridge in enabled {
        sync(&bridge.id);
    }
}

/// After a bridge was added, turned on or off, or removed: drops its connection at once
/// and opens a new one if it's (still) enabled.
pub fn sync(id: &str) {
    if let Some(old) = bridges().lock().unwrap().remove(id) {
        old.cancel.cancel();
    }
    let Some(state) = STATE.get().cloned() else {
        return;
    };
    let enabled = state
        .db
        .get()
        .ok()
        .and_then(|conn| integrations::find(&conn, id).ok().flatten())
        .is_some_and(|i| i.kind == "bridge" && i.enabled);
    if !enabled {
        return;
    }
    let handle = Handle {
        cancel: CancellationToken::new(),
        status: Arc::new(Mutex::new(Status::default())),
    };
    let (cancel, status) = (handle.cancel.clone(), handle.status.clone());
    bridges().lock().unwrap().insert(id.to_string(), handle);
    let id = id.to_string();
    tokio::spawn(async move { keep_connected(state, id, cancel, status).await });
}

pub fn status(id: &str) -> Option<Status> {
    bridges()
        .lock()
        .unwrap()
        .get(id)
        .map(|handle| handle.status.lock().unwrap().clone())
}

/// `wss://`, or `ws://` to this machine (a server you run next to the hub).
pub fn url_allowed(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "wss" => url.host_str().is_some(),
        "ws" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")),
        _ => false,
    }
}

/// This hub's id for bridge servers, made once.
fn hub_id(conn: &rusqlite::Connection) -> rusqlite::Result<String> {
    if let Some(id) = db::hub_state::get(conn, "bridge_hub_id")? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    db::hub_state::set(conn, "bridge_hub_id", &id)?;
    Ok(id)
}

/// A bridge key: 32 random bytes, base64url.
pub fn new_key() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("random bytes");
    format!(
        "obk_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_secs(1u64 << attempt.min(6)).min(MAX_BACKOFF);
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    // ±25 % jitter
    base.mul_f64(0.75 + f64::from(byte[0]) / 255.0 * 0.5)
}

async fn keep_connected(state: AppState, id: String, cancel: CancellationToken, status: Arc<Mutex<Status>>) {
    let mut attempt = 0u32;
    loop {
        let bridge = match state.db.get().map(|conn| integrations::find(&conn, &id)) {
            Ok(Ok(Some(bridge))) if bridge.enabled => bridge,
            _ => return,
        };
        let opened = Instant::now();
        let error = tokio::select! {
            _ = cancel.cancelled() => return,
            result = connect_and_serve(&state, &bridge, &cancel, &status) => match result {
                Ok(()) => return,
                Err(error) => error,
            },
        };
        {
            let mut status = status.lock().unwrap();
            status.connected = false;
            status.since_ms = None;
            status.last_error = Some(error.clone());
        }
        if let Ok(conn) = state.db.get() {
            let _ = integrations::record_bridge_error(&conn, &id, Some(&error));
        }
        tracing::info!("bridge {} disconnected: {}", bridge.name, error);
        // A connection that held for a while starts the backoff over
        if opened.elapsed() > Duration::from_secs(60) {
            attempt = 0;
        }
        let wait = backoff(attempt);
        attempt = attempt.saturating_add(1);
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// One connection: open it, say hello, then serve until it ends (Err: why) or the
/// bridge is turned off (Ok).
async fn connect_and_serve(
    state: &AppState,
    bridge: &Integration,
    cancel: &CancellationToken,
    status: &Arc<Mutex<Status>>,
) -> Result<(), String> {
    let hub = state
        .db
        .get()
        .map_err(|e| e.to_string())
        .and_then(|conn| hub_id(&conn).map_err(|e| e.to_string()))?;
    let mut request = bridge
        .url
        .as_str()
        .into_client_request()
        .map_err(|_| "the bridge URL is invalid".to_string())?;
    let headers = request.headers_mut();
    let header = |value: &str| HeaderValue::from_str(value).map_err(|_| "a header can't be sent".to_string());
    headers.insert("authorization", header(&format!("Bearer {}", bridge.secret))?);
    headers.insert("x-offdesk-hub", header(&hub)?);
    headers.insert("x-offdesk-bridge-protocol", header(&PROTOCOL.to_string())?);
    if let Some(code) = &bridge.pairing_code {
        headers.insert("x-offdesk-pairing-code", header(code)?);
    }
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| "timed out connecting".to_string())?;
    let (mut ws, _) = connected.map_err(|error| match error {
        tungstenite::Error::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
            "the server refused this hub: the pairing code was used or expired, or the key isn't registered".to_string()
        }
        tungstenite::Error::Http(response) => format!("the server answered HTTP {}", response.status().as_u16()),
        _ => "couldn't connect".to_string(),
    })?;
    if bridge.pairing_code.is_some() {
        if let Ok(conn) = state.db.get() {
            let _ = integrations::paired(&conn, &bridge.id);
        }
    }
    {
        let mut status = status.lock().unwrap();
        status.connected = true;
        status.since_ms = Some(db::now_ms());
        status.last_error = None;
    }
    if let Ok(conn) = state.db.get() {
        let _ = integrations::record_bridge_error(&conn, &bridge.id, None);
    }
    tracing::info!("bridge {} connected", bridge.name);

    let send = |value: Value| Message::Text(value.to_string().into());
    ws.send(send(json!({
        "type": "hello",
        "hub_id": hub,
        "hub_version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL,
        "integration": bridge.name,
        "access": bridge.access,
    })))
    .await
    .map_err(|_| "the connection dropped".to_string())?;
    ws.send(send(snapshot(state, bridge).await?))
        .await
        .map_err(|_| "the connection dropped".to_string())?;

    let mut last_sent = 0i64;
    let mut heard = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut poll = tokio::time::interval(POLL_EVERY);
    loop {
        // What's queued and not sent on this connection yet
        loop {
            let pending = state
                .db
                .get()
                .map_err(|e| e.to_string())
                .and_then(|conn| integrations::unacked(&conn, &bridge.id, last_sent, 100).map_err(|e| e.to_string()))?;
            if pending.is_empty() {
                break;
            }
            for delivery in pending {
                let event: Value = serde_json::from_str(&delivery.body).unwrap_or(Value::Null);
                ws.send(send(json!({ "type": "event", "seq": delivery.id, "event": event })))
                    .await
                    .map_err(|_| "the connection dropped".to_string())?;
                last_sent = delivery.id;
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = ws.close(None).await;
                return Ok(());
            }
            _ = WAKE.notified() => {}
            _ = poll.tick() => {}
            _ = ping.tick() => {
                if heard.elapsed() > SILENT_FOR {
                    return Err("the server stopped answering".to_string());
                }
                ws.send(send(json!({ "type": "ping" })))
                    .await
                    .map_err(|_| "the connection dropped".to_string())?;
            }
            message = ws.next() => {
                heard = Instant::now();
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(reply) = handle(state, bridge, &text).await {
                            ws.send(send(reply)).await.map_err(|_| "the connection dropped".to_string())?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Err("the server closed the connection".to_string()),
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return Err("the connection dropped".to_string()),
                }
            }
        }
    }
}

/// Machines and runs as the bridge may see them: its machines (with who's online) and
/// the runs on them, open or ended in the last day, at its content level.
async fn snapshot(state: &AppState, bridge: &Integration) -> Result<Value, String> {
    let online: Vec<String> = state
        .manager
        .list_machines_for_user(&bridge.user_id)
        .await
        .into_iter()
        .map(|m| m.id)
        .collect();
    // Known machines, connected or not (a connected one may have no row yet)
    let machines: Vec<offdesk_protocol::MachineInfo> = state
        .manager
        .list_known_machines_for_user(&bridge.user_id)
        .await
        .into_iter()
        .filter(|m| bridge.access.allows_machine(&m.id, m.production))
        .collect();
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let ids: std::collections::HashSet<&str> = machines.iter().map(|m| m.id.as_str()).collect();
    let runs = db::agent_runs::list_for_user(&conn, &bridge.user_id, db::now_ms() - SNAPSHOT_RECENT_MS, None, 200)
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|row| ids.contains(row.machine_id.as_str()))
        .map(|row| {
            db::agent_runs::to_info(&conn, row)
                .map(|run| crate::routes::agent_runs::shown_run(run, Some(bridge.access.content)))
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "type": "snapshot",
        "machines": machines.iter().map(|m| json!({
            "id": m.id,
            "name": m.name,
            "os": m.os,
            "production": m.production,
            "online": online.contains(&m.id),
        })).collect::<Vec<_>>(),
        "runs": runs,
    }))
}

/// What a server may send.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    /// It has stored everything up to `seq`.
    Ack { seq: i64 },
    Answer {
        command_id: String,
        run_id: String,
        request_id: String,
        #[serde(default)]
        approve: Option<bool>,
        #[serde(default)]
        option_id: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    Start {
        command_id: String,
        machine_id: String,
        agent: RunAgent,
        cwd: String,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        external_ref: Option<String>,
        #[serde(default)]
        permission_mode: Option<AgentPermissionMode>,
    },
    Message { command_id: String, run_id: String },
    Cancel { command_id: String, run_id: String },
    Pong,
    #[serde(other)]
    Other,
}

/// Handles one message from the server; the reply to send, if any.
async fn handle(state: &AppState, bridge: &Integration, text: &str) -> Option<Value> {
    let message = match serde_json::from_str::<ServerMessage>(text) {
        Ok(message) => message,
        Err(_) => {
            // A command we can't read still gets an answer, when it says which one
            let command_id = serde_json::from_str::<Value>(text).ok()?.get("command_id")?.as_str()?.to_string();
            return Some(json!({ "type": "result", "command_id": command_id, "ok": false, "status": 400, "error": "This hub can't read that command" }));
        }
    };
    let command_id = match &message {
        ServerMessage::Ack { seq } => {
            if let Ok(conn) = state.db.get() {
                if let Err(error) = integrations::ack(&conn, &bridge.id, *seq) {
                    tracing::warn!("bridge ack: {}", error);
                }
            }
            return None;
        }
        ServerMessage::Pong | ServerMessage::Other => return None,
        ServerMessage::Answer { command_id, .. }
        | ServerMessage::Start { command_id, .. }
        | ServerMessage::Message { command_id, .. }
        | ServerMessage::Cancel { command_id, .. } => command_id.clone(),
    };
    // A command seen before gets the same result, not a second go
    if let Some(previous) = state
        .db
        .get()
        .ok()
        .and_then(|conn| integrations::command_result(&conn, &bridge.id, &command_id).ok().flatten())
    {
        return serde_json::from_str(&previous).ok();
    }
    let mut result = command(state, bridge, message).await;
    result["type"] = "result".into();
    result["command_id"] = command_id.clone().into();
    if let Ok(conn) = state.db.get() {
        let _ = integrations::save_command_result(&conn, &bridge.id, &command_id, &result.to_string());
    }
    Some(result)
}

fn refusal((status, reason): (axum::http::StatusCode, String)) -> Value {
    json!({ "ok": false, "status": status.as_u16(), "error": reason })
}

/// Carries out a command as the bridge: its access decides, and it's audited.
async fn command(state: &AppState, bridge: &Integration, message: ServerMessage) -> Value {
    let caller = AuthUser {
        user_id: bridge.user_id.clone(),
        api_token_name: Some(format!("bridge:{}", bridge.name)),
        api_token_id: Some(bridge.id.clone()),
        access: Some(bridge.access.clone()),
    };
    // The bridge types as its own device, which takes the machine's control lease as
    // the CLI does: only when it may do the thing at all
    let device = format!("bridge-{}", bridge.id.get(..8).unwrap_or(&bridge.id));
    match message {
        ServerMessage::Answer { run_id, request_id, approve, option_id, text, .. } => {
            if !caller.allows(TokenScope::RunsAnswer) && !caller.allows(TokenScope::RunsApprove) {
                let reason = "This bridge can't answer; it needs runs:answer or runs:approve";
                caller.audit(&state.db, "answer", &run_id, reason);
                return json!({ "ok": false, "status": 403, "error": reason });
            }
            let machine = state.db.get().ok().and_then(|conn| {
                db::agent_runs::find_for_user(&conn, &run_id, &bridge.user_id).ok().flatten()
            });
            if let Some(run) = machine.filter(|run| caller.may_reach_machine(&state.db, &run.machine_id)) {
                state.manager.request_control(&bridge.user_id, &run.machine_id, &device);
            }
            let answer = AgentAnswer { request_id, approve, option_id, text, device_id: Some(device) };
            match crate::routes::agent_runs::answer_as(state, &caller, &run_id, answer).await {
                Ok(run) => json!({ "ok": true, "run": run }),
                Err(refused) => refusal(refused),
            }
        }
        ServerMessage::Start { machine_id, agent, cwd, prompt, label, external_ref, permission_mode, .. } => {
            if !caller.allows(TokenScope::RunsStart) {
                let reason = "This bridge can't start agents; it needs runs:start";
                caller.audit(&state.db, "start", &machine_id, reason);
                return json!({ "ok": false, "status": 403, "error": reason });
            }
            if caller.may_reach_machine(&state.db, &machine_id) {
                state.manager.request_control(&bridge.user_id, &machine_id, &device);
            }
            let start = StartAgentRun {
                machine_id,
                agent,
                cwd,
                prompt,
                label,
                external_ref,
                permission_mode,
                device_id: Some(device),
            };
            match crate::routes::agent_runs::start_as(state, &caller, start).await {
                Ok(started) => json!({ "ok": true, "run": started.run, "terminal_id": started.terminal.id }),
                Err(refused) => refusal(refused),
            }
        }
        ServerMessage::Message { run_id, .. } | ServerMessage::Cancel { run_id, .. } => {
            let reason = "This hub can't do that yet";
            caller.audit(&state.db, "denied", &run_id, reason);
            json!({ "ok": false, "status": 501, "error": reason })
        }
        ServerMessage::Ack { .. } | ServerMessage::Pong | ServerMessage::Other => Value::Null,
    }
}

#[cfg(test)]
mod tests;
