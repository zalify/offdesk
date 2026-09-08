use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get, patch, post, put},
    Router,
};
use serde::{Deserialize, Serialize};
use offdesk_protocol::{AgentKind, AgentSessionInfo, AgentSessionStatus, HubToMachine, MachineInfo};

use crate::auth::AuthUser;
use crate::db::agent_sessions::{self, row_to_info};
use crate::db::types::AgentSessionRow;
use crate::AppState;

#[derive(Deserialize)]
pub struct CreateAgentSessionRequest {
    pub agent_kind: AgentKind,
    pub cwd: String,
    /// Defaults to `!machine.production` when omitted.
    #[serde(default)]
    pub auto_run: Option<bool>,
    #[serde(default)]
    pub workspace_group_id: Option<String>,
    /// Model to run on, applied via session/set_model once the session is
    /// ready (ACP session/new itself has no model param).
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
pub struct PromptRequest {
    pub text: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
pub struct AnswerRequest {
    pub request_id: String,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
struct EventsQuery {
    from_seq: Option<u64>,
    limit: Option<u64>,
}

const EVENTS_DEFAULT_LIMIT: u64 = 500;
const EVENTS_MAX_LIMIT: u64 = 2000;

#[derive(Serialize)]
struct AgentEventEntry {
    seq: u64,
    event: serde_json::Value,
}

#[derive(Serialize)]
struct AgentEventsPage {
    events: Vec<AgentEventEntry>,
    last_seq: u64,
}

#[derive(Deserialize)]
pub struct SeenRequest {
    pub last_seen_seq: u64,
}

#[derive(Deserialize)]
pub struct SetModelRequest {
    pub model_id: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Serialize)]
struct SeenResponse {
    last_seen_seq: u64,
}

#[derive(Deserialize)]
pub struct UpdateMachineRequest {
    pub production: bool,
    #[serde(default)]
    pub device_id: Option<String>,
}

fn db_error(e: impl std::fmt::Display) -> (StatusCode, String) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("DB error: {}", e),
    )
}

/// Mirror of the control-lease gate on mutating terminal routes.
fn ensure_control(
    state: &AppState,
    user_id: &str,
    machine_id: &str,
    device_id: Option<&str>,
) -> Result<(), (StatusCode, String)> {
    let controller_device_id = state.manager.get_controller(user_id, machine_id);
    let allowed = matches!(
        (
            controller_device_id.as_deref(),
            device_id.filter(|value| !value.is_empty()),
        ),
        (Some(controller_device_id), Some(device_id)) if controller_device_id == device_id
    );
    if !allowed {
        return Err((StatusCode::FORBIDDEN, "Control required".to_string()));
    }
    Ok(())
}

/// Load a session row and verify the caller owns both it and the machine in
/// the path. Ownership failures are 404, never 403 (no existence leak).
fn load_owned_session(
    state: &AppState,
    user_id: &str,
    machine_id: &str,
    session_id: &str,
) -> Result<AgentSessionRow, (StatusCode, String)> {
    let conn = state.db.get().map_err(db_error)?;
    let row = agent_sessions::find_session(&conn, session_id)
        .map_err(db_error)?
        .filter(|row| row.user_id == user_id && row.machine_id == machine_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Agent session not found".to_string()))?;
    Ok(row)
}

/// Default title: the last path segment of the cwd (falling back to the cwd
/// itself for roots like "/").
fn title_from_cwd(cwd: &str) -> String {
    cwd.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

fn not_live_error() -> (StatusCode, String) {
    (
        StatusCode::CONFLICT,
        "Agent session is not running; resume it first".to_string(),
    )
}

async fn create_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(machine_id): Path<String>,
    Json(req): Json<CreateAgentSessionRequest>,
) -> Result<Json<AgentSessionInfo>, (StatusCode, String)> {
    let conn = state.db.get().map_err(db_error)?;
    let machine = crate::db::machines::find_machine_by_id(&conn, &machine_id)
        .map_err(db_error)?
        .filter(|machine| machine.user_id == auth_user.user_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Machine not found".to_string()))?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        req.device_id.as_deref(),
    )?;

    let auto_run = req.auto_run.unwrap_or(!machine.production);
    let session_id = uuid::Uuid::new_v4().to_string();
    let title = title_from_cwd(&req.cwd);

    // The machine must be online to host the session; create nothing otherwise.
    state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionStart {
                session_id: session_id.clone(),
                agent_kind: req.agent_kind,
                cwd: req.cwd.clone(),
                auto_run,
                resume_acp_session_id: None,
                model_id: req.model_id.clone(),
            },
        )
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;

    agent_sessions::insert_session(
        &conn,
        &session_id,
        &auth_user.user_id,
        &machine_id,
        req.agent_kind,
        &req.cwd,
        &title,
        AgentSessionStatus::Starting,
        auto_run,
        req.workspace_group_id.as_deref(),
        req.model_id.as_deref(),
    )
    .map_err(db_error)?;

    let row = agent_sessions::find_session(&conn, &session_id)
        .map_err(db_error)?
        .expect("the session row was just inserted");
    let info = row_to_info(&row);
    state
        .manager
        .publish_agent_session_created(&auth_user.user_id, info.clone());
    Ok(Json(info))
}

async fn prompt_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Json(req): Json<PromptRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        req.device_id.as_deref(),
    )?;
    if matches!(row.status.as_str(), "disconnected" | "error") {
        return Err(not_live_error());
    }
    state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionPrompt {
                session_id,
                text: req.text,
            },
        )
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn answer_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Json(req): Json<AnswerRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        req.device_id.as_deref(),
    )?;
    if matches!(row.status.as_str(), "disconnected" | "error") {
        return Err(not_live_error());
    }
    state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionAnswer {
                session_id,
                request_id: req.request_id,
                option_id: req.option_id,
                text: req.text,
            },
        )
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Switch the session's model; the machine answers session/set_model and the
/// confirmed model lands via the agent_session_update relay. Lease-gated like
/// prompt.
async fn set_agent_session_model(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Json(req): Json<SetModelRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        req.device_id.as_deref(),
    )?;
    if matches!(row.status.as_str(), "disconnected" | "error") {
        return Err(not_live_error());
    }
    state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionSetModel {
                session_id,
                model_id: req.model_id,
            },
        )
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        params.get("device_id").map(String::as_str),
    )?;
    if matches!(row.status.as_str(), "disconnected" | "error") {
        return Err(not_live_error());
    }
    state
        .manager
        .send_to_machine(&machine_id, HubToMachine::AgentSessionCancel { session_id })
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<AgentSessionInfo>, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        params.get("device_id").map(String::as_str),
    )?;
    if !matches!(row.status.as_str(), "disconnected" | "error") {
        return Err((
            StatusCode::CONFLICT,
            "Agent session is still running".to_string(),
        ));
    }

    state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionStart {
                session_id: session_id.clone(),
                agent_kind: agent_sessions::kind_from_name(&row.agent_kind),
                cwd: row.cwd.clone(),
                auto_run: row.auto_run,
                resume_acp_session_id: row.acp_session_id.clone(),
                model_id: None,
            },
        )
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;

    {
        let conn = state.db.get().map_err(db_error)?;
        agent_sessions::set_status(&conn, &session_id, AgentSessionStatus::Starting)
            .map_err(db_error)?;
    }
    let conn = state.db.get().map_err(db_error)?;
    let row = agent_sessions::find_session(&conn, &session_id)
        .map_err(db_error)?
        .expect("the session row exists");
    let info = row_to_info(&row);
    state
        .manager
        .publish_agent_session_updated(&auth_user.user_id, info.clone());
    Ok(Json(info))
}

async fn delete_agent_session(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<StatusCode, (StatusCode, String)> {
    load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        params.get("device_id").map(String::as_str),
    )?;

    // Best-effort kill: an offline machine makes the row cleanup no less valid.
    let _ = state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::AgentSessionKill {
                session_id: session_id.clone(),
            },
        )
        .await;

    let conn = state.db.get().map_err(db_error)?;
    agent_sessions::delete_session(&conn, &session_id).map_err(db_error)?;
    state
        .manager
        .publish_agent_session_destroyed(&auth_user.user_id, &session_id);
    Ok(StatusCode::NO_CONTENT)
}

/// The browser's backfill path: ordered event pages out of the persisted log.
async fn get_agent_session_events(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, session_id)): Path<(String, String)>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<AgentEventsPage>, (StatusCode, String)> {
    let row = load_owned_session(&state, &auth_user.user_id, &machine_id, &session_id)?;
    let limit = query
        .limit
        .unwrap_or(EVENTS_DEFAULT_LIMIT)
        .clamp(1, EVENTS_MAX_LIMIT);
    let conn = state.db.get().map_err(db_error)?;
    let events =
        agent_sessions::events_page(&conn, &session_id, query.from_seq.unwrap_or(0), limit)
            .map_err(db_error)?
            .into_iter()
            .map(|(seq, event_json)| AgentEventEntry {
                seq,
                // Stored by the hub itself from validated AgentEvents; fall back to
                // null rather than failing the page if a row is somehow malformed.
                event: serde_json::from_str(&event_json).unwrap_or(serde_json::Value::Null),
            })
            .collect();
    Ok(Json(AgentEventsPage {
        events,
        last_seq: row.last_event_seq.max(0) as u64,
    }))
}

async fn mark_agent_session_seen(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(session_id): Path<String>,
    Json(req): Json<SeenRequest>,
) -> Result<Json<SeenResponse>, (StatusCode, String)> {
    let conn = state.db.get().map_err(db_error)?;
    agent_sessions::find_session(&conn, &session_id)
        .map_err(db_error)?
        .filter(|row| row.user_id == auth_user.user_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Agent session not found".to_string()))?;
    let last_seen_seq =
        agent_sessions::upsert_seen(&conn, &auth_user.user_id, &session_id, req.last_seen_seq)
            .map_err(db_error)?;
    state
        .manager
        .publish_agent_session_seen(&auth_user.user_id, &session_id, last_seen_seq);
    Ok(Json(SeenResponse { last_seen_seq }))
}

async fn update_machine(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(machine_id): Path<String>,
    Json(req): Json<UpdateMachineRequest>,
) -> Result<Json<MachineInfo>, (StatusCode, String)> {
    let conn = state.db.get().map_err(db_error)?;
    let machine = crate::db::machines::find_machine_by_id(&conn, &machine_id)
        .map_err(db_error)?
        .filter(|machine| machine.user_id == auth_user.user_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Machine not found".to_string()))?;
    ensure_control(
        &state,
        &auth_user.user_id,
        &machine_id,
        req.device_id.as_deref(),
    )?;

    crate::db::machines::set_machine_production(&conn, &machine_id, req.production)
        .map_err(db_error)?;
    state
        .manager
        .set_machine_production(&machine_id, req.production)
        .await;

    // There is no machine-updated browser event; the flag reaches browsers
    // via the next bootstrap snapshot.
    let info = MachineInfo {
        id: machine.id,
        name: machine.name,
        os: machine.os.unwrap_or_default(),
        home_dir: machine.home_dir.unwrap_or_default(),
        production: req.production,
    };
    Ok(Json(info))
}

async fn delete_machine(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(machine_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let removed = state
        .manager
        .remove_machine(&auth_user.user_id, &machine_id)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {error}"),
            )
        })?;
    if !removed {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }
    state.router.drop_machine(&machine_id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/machines/{machine_id}/agent-sessions",
            post(create_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/prompt",
            post(prompt_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/answer",
            post(answer_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/cancel",
            post(cancel_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/model",
            post(set_agent_session_model),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/resume",
            post(resume_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}",
            delete(delete_agent_session),
        )
        .route(
            "/api/machines/{machine_id}/agent-sessions/{session_id}/events",
            get(get_agent_session_events),
        )
        .route(
            "/api/agent-sessions/{session_id}/seen",
            put(mark_agent_session_seen),
        )
        .route(
            "/api/machines/{machine_id}",
            patch(update_machine).delete(delete_machine),
        )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, StatusCode},
    };
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::{json, Value};
    use offdesk_protocol::{AgentEvent, HubToMachine, MachineInfo, MachineToHub};
    use tokio::sync::mpsc;
    use tower::ServiceExt;

    use crate::{
        attach_router::HubRouter, auth::sign_jwt, machine_manager::MachineManager, AppState,
    };

    fn test_state() -> AppState {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin")
            .unwrap();
        drop(conn);

        AppState {
            manager: Arc::new(MachineManager::new(pool.clone())),
            router: Arc::new(HubRouter::new()),
            web_previews: Arc::new(crate::web_preview::registry::Registry::default()),
            db: pool,
            jwt_secret: "test-secret".to_string(),
            base_url: "http://localhost:4317".to_string(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        }
    }

    fn machine(id: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_string(),
            name: format!("machine-{id}"),
            os: "linux".to_string(),
            home_dir: "/tmp".to_string(),
            production: false,
        }
    }

    /// A state with user-a, machine-a registered (online) and the control
    /// lease held by device-a.
    async fn state_with_machine() -> (AppState, mpsc::Receiver<HubToMachine>) {
        let state = test_state();
        {
            let conn = state.db.get().unwrap();
            crate::db::machines::ensure_machine_for_user(
                &conn,
                "machine-a",
                "user-a",
                "Machine A",
                Some("linux"),
                Some("/tmp"),
            )
            .unwrap();
        }
        let (_conn_id, cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        state
            .manager
            .request_control("user-a", "machine-a", "device-a");
        (state, cmd_rx)
    }

    async fn request(
        state: &AppState,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let token = sign_jwt("user-a", &state.jwt_secret);
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        let body = match body {
            Some(value) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = super::router()
            .with_state(state.clone())
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()))
        };
        (status, body)
    }

    async fn create_session(
        state: &AppState,
        cmd_rx: &mut mpsc::Receiver<HubToMachine>,
        extra: Value,
    ) -> (Value, HubToMachine) {
        let mut payload = json!({
            "agent_kind": "kimi",
            "cwd": "/work/repo",
            "device_id": "device-a",
        });
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, body) = request(
            state,
            Method::POST,
            "/api/machines/machine-a/agent-sessions",
            Some(payload),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create failed: {body}");
        let cmd = cmd_rx.recv().await.expect("AgentSessionStart command");
        (body, cmd)
    }

    #[tokio::test]
    async fn create_starts_the_session_on_the_machine_and_broadcasts() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let mut events = state.manager.subscribe_events();

        let (body, cmd) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();
        assert_eq!(body["status"], "starting");
        assert_eq!(body["title"], "repo", "title defaults to the cwd basename");
        assert_eq!(body["auto_run"], true, "non-production machines auto-run");
        assert_eq!(body["last_event_seq"], 0);

        match cmd {
            HubToMachine::AgentSessionStart {
                session_id: cmd_session_id,
                agent_kind,
                cwd,
                auto_run,
                resume_acp_session_id,
                model_id,
            } => {
                assert_eq!(cmd_session_id, session_id);
                assert_eq!(agent_kind, offdesk_protocol::AgentKind::Kimi);
                assert_eq!(cwd, "/work/repo");
                assert!(auto_run);
                assert_eq!(resume_acp_session_id, None);
                assert_eq!(model_id, None);
            }
            other => panic!("unexpected machine command: {other:?}"),
        }

        let broadcast = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            broadcast.event,
            offdesk_protocol::BrowserEvent::AgentSessionCreated { ref session }
                if session.id == session_id
        ));

        let conn = state.db.get().unwrap();
        let row = crate::db::agent_sessions::find_session(&conn, &session_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.user_id, "user-a");
        assert_eq!(row.status, "starting");
    }

    #[tokio::test]
    async fn production_machine_defaults_auto_run_to_false() {
        let (state, mut cmd_rx) = state_with_machine().await;

        let (status, body) = request(
            &state,
            Method::PATCH,
            "/api/machines/machine-a",
            Some(json!({"production": true, "device_id": "device-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["production"], true);

        let (body, cmd) = create_session(&state, &mut cmd_rx, json!({})).await;
        assert_eq!(body["auto_run"], false);
        match cmd {
            HubToMachine::AgentSessionStart { auto_run, .. } => assert!(!auto_run),
            other => panic!("unexpected machine command: {other:?}"),
        }

        // An explicit auto_run still wins over the machine default.
        let (body, _) = create_session(&state, &mut cmd_rx, json!({"auto_run": true})).await;
        assert_eq!(body["auto_run"], true);
    }

    #[tokio::test]
    async fn delete_machine_returns_204_and_forgets_the_row() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let mut events = state.manager.subscribe_events();

        let (status, body) = request(&state, Method::DELETE, "/api/machines/machine-a", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "delete failed: {body}");
        assert!(cmd_rx.recv().await.is_none());

        let broadcast = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            broadcast.event,
            offdesk_protocol::BrowserEvent::MachineRemoved { ref machine_id }
                if machine_id == "machine-a"
        ));

        {
            let conn = state.db.get().unwrap();
            assert!(crate::db::machines::find_machine_by_id(&conn, "machine-a")
                .unwrap()
                .is_none());
        }

        let (status, _) = request(&state, Method::DELETE, "/api/machines/machine-a", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_machine_is_404_for_another_users_host() {
        let state = test_state();
        {
            let conn = state.db.get().unwrap();
            crate::db::users::create_user(
                &conn, "user-b", "test", "user-b", "User B", None, "user",
            )
            .unwrap();
            crate::db::machines::ensure_machine_for_user(
                &conn,
                "machine-b",
                "user-b",
                "Machine B",
                Some("linux"),
                Some("/tmp"),
            )
            .unwrap();
        }

        let (status, _) = request(&state, Method::DELETE, "/api/machines/machine-b", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let conn = state.db.get().unwrap();
        assert!(crate::db::machines::find_machine_by_id(&conn, "machine-b")
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn machine_events_are_persisted_and_page_correctly() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();

        for seq in 1..=3 {
            state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentSessionEvent {
                        session_id: session_id.clone(),
                        seq,
                        event: AgentEvent::AgentMessageChunk {
                            text: format!("chunk {seq}"),
                        },
                    },
                )
                .await;
        }
        // Stale seqs (e.g. a resumed session replaying) are ignored.
        for seq in 1..=2 {
            state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentSessionEvent {
                        session_id: session_id.clone(),
                        seq,
                        event: AgentEvent::AgentMessageChunk {
                            text: "stale".to_string(),
                        },
                    },
                )
                .await;
        }

        let uri = format!("/api/machines/machine-a/agent-sessions/{session_id}/events");
        let (status, body) = request(&state, Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["last_seq"], 3);
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["seq"], 1);
        assert_eq!(events[0]["event"]["type"], "agent_message_chunk");
        assert_eq!(events[0]["event"]["text"], "chunk 1");

        let (status, body) = request(
            &state,
            Method::GET,
            &format!("{uri}?from_seq=2&limit=10"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["seq"], 3);

        let (status, body) = request(&state, Method::GET, &format!("{uri}?limit=2"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["events"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn seen_is_monotonic_and_reaches_the_bootstrap_snapshot() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();

        let uri = format!("/api/agent-sessions/{session_id}/seen");
        let (status, body) =
            request(&state, Method::PUT, &uri, Some(json!({"last_seen_seq": 5}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["last_seen_seq"], 5);

        let (status, body) =
            request(&state, Method::PUT, &uri, Some(json!({"last_seen_seq": 2}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["last_seen_seq"], 5, "the cursor never regresses");

        let snapshot = state.manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.agent_session_seen.get(&session_id), Some(&5));
        assert!(snapshot
            .agent_sessions
            .iter()
            .any(|session| session.id == session_id));
    }

    #[tokio::test]
    async fn resume_only_when_down_and_passes_the_stored_acp_session_id() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();
        let uri = format!(
            "/api/machines/machine-a/agent-sessions/{session_id}/resume?device_id=device-a"
        );

        // Still running: resume is a conflict.
        let (status, _) = request(&state, Method::POST, &uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT);

        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionUpdate {
                    session_id: session_id.clone(),
                    status: None,
                    title: None,
                    acp_session_id: Some("acp-9".to_string()),
                    available_models: None,
                    current_model_id: None,
                },
            )
            .await;
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionExited {
                    session_id: session_id.clone(),
                    reason: "process died".to_string(),
                },
            )
            .await;

        let (status, body) = request(&state, Method::POST, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "starting");
        match cmd_rx.recv().await.unwrap() {
            HubToMachine::AgentSessionStart {
                resume_acp_session_id,
                ..
            } => assert_eq!(resume_acp_session_id.as_deref(), Some("acp-9")),
            other => panic!("unexpected machine command: {other:?}"),
        }
    }

    #[tokio::test]
    async fn machine_disconnect_marks_live_sessions_disconnected() {
        let state = test_state();
        {
            let conn = state.db.get().unwrap();
            crate::db::machines::ensure_machine_for_user(
                &conn,
                "machine-a",
                "user-a",
                "Machine A",
                Some("linux"),
                Some("/tmp"),
            )
            .unwrap();
        }
        let (conn_id, mut cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        state
            .manager
            .request_control("user-a", "machine-a", "device-a");

        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();

        state
            .manager
            .unregister_machine("machine-a", &conn_id)
            .await;

        let conn = state.db.get().unwrap();
        let row = crate::db::agent_sessions::find_session(&conn, &session_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "disconnected");
    }

    #[tokio::test]
    async fn mutating_routes_require_the_control_lease() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();

        let (status, _) = request(
            &state,
            Method::POST,
            &format!("/api/machines/machine-a/agent-sessions/{session_id}/prompt"),
            Some(json!({"text": "hi"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // A stranger's session is a 404, not a 403.
        let (status, _) = request(
            &state,
            Method::POST,
            "/api/machines/machine-a/agent-sessions/nope/prompt?device_id=device-a",
            Some(json!({"text": "hi", "device_id": "device-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_kills_the_agent_and_removes_all_rows() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionEvent {
                    session_id: session_id.clone(),
                    seq: 1,
                    event: AgentEvent::UserMessage {
                        text: "hi".to_string(),
                    },
                },
            )
            .await;
        request(
            &state,
            Method::PUT,
            &format!("/api/agent-sessions/{session_id}/seen"),
            Some(json!({"last_seen_seq": 1})),
        )
        .await;

        let (status, _) = request(
            &state,
            Method::DELETE,
            &format!("/api/machines/machine-a/agent-sessions/{session_id}?device_id=device-a"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(matches!(
            cmd_rx.recv().await.unwrap(),
            HubToMachine::AgentSessionKill { session_id: id } if id == session_id
        ));

        let conn = state.db.get().unwrap();
        assert!(crate::db::agent_sessions::find_session(&conn, &session_id)
            .unwrap()
            .is_none());
        assert!(
            crate::db::agent_sessions::events_page(&conn, &session_id, 0, 10)
                .unwrap()
                .is_empty()
        );
        assert!(crate::db::agent_sessions::seen_by_user(&conn, "user-a")
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn create_with_model_forwards_it_and_stores_it_as_requested() {
        let (state, mut cmd_rx) = state_with_machine().await;

        let (body, cmd) =
            create_session(&state, &mut cmd_rx, json!({"model_id": "kimi-code/k3"})).await;
        let session_id = body["id"].as_str().unwrap().to_string();
        match cmd {
            HubToMachine::AgentSessionStart { model_id, .. } => {
                assert_eq!(model_id.as_deref(), Some("kimi-code/k3"))
            }
            other => panic!("unexpected machine command: {other:?}"),
        }

        let conn = state.db.get().unwrap();
        let row = crate::db::agent_sessions::find_session(&conn, &session_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.requested_model_id.as_deref(), Some("kimi-code/k3"));
        // The requested model is not the current one until the machine
        // confirms it.
        assert_eq!(row.current_model_id, None);
    }

    #[tokio::test]
    async fn model_route_is_lease_gated_and_relays_set_model() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();
        let uri = format!("/api/machines/machine-a/agent-sessions/{session_id}/model");

        // No lease → 403.
        let (status, _) = request(
            &state,
            Method::POST,
            &uri,
            Some(json!({"model_id": "fake-model-b"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &state,
            Method::POST,
            &uri,
            Some(json!({"model_id": "fake-model-b", "device_id": "device-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(matches!(
            cmd_rx.recv().await.unwrap(),
            HubToMachine::AgentSessionSetModel { session_id: id, model_id }
                if id == session_id && model_id == "fake-model-b"
        ));

        // A disconnected session refuses with 409, like prompt.
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionExited {
                    session_id: session_id.clone(),
                    reason: "gone".to_string(),
                },
            )
            .await;
        let (status, _) = request(
            &state,
            Method::POST,
            &uri,
            Some(json!({"model_id": "fake-model-b", "device_id": "device-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn machine_model_updates_persist_and_reach_the_bootstrap_snapshot() {
        let (state, mut cmd_rx) = state_with_machine().await;
        let (body, _) = create_session(&state, &mut cmd_rx, json!({})).await;
        let session_id = body["id"].as_str().unwrap().to_string();

        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionUpdate {
                    session_id: session_id.clone(),
                    status: Some(offdesk_protocol::AgentSessionStatus::Idle),
                    title: None,
                    acp_session_id: Some("acp-1".to_string()),
                    available_models: Some(vec![
                        offdesk_protocol::AgentModelInfo {
                            model_id: "fake-model-a".to_string(),
                            name: "Fake Model A".to_string(),
                            description: None,
                        },
                        offdesk_protocol::AgentModelInfo {
                            model_id: "fake-model-b".to_string(),
                            name: "Fake Model B".to_string(),
                            description: Some("the other one".to_string()),
                        },
                    ]),
                    current_model_id: Some("fake-model-a".to_string()),
                },
            )
            .await;

        let snapshot = state.manager.snapshot_for_user("user-a").await;
        let session = snapshot
            .agent_sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("the session is in the snapshot");
        assert_eq!(session.current_model_id.as_deref(), Some("fake-model-a"));
        assert_eq!(session.available_models.len(), 2);
        assert_eq!(session.available_models[1].model_id, "fake-model-b");

        // A model-only update (no status) changes just the current model.
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentSessionUpdate {
                    session_id: session_id.clone(),
                    status: None,
                    title: None,
                    acp_session_id: None,
                    available_models: None,
                    current_model_id: Some("fake-model-b".to_string()),
                },
            )
            .await;
        let snapshot = state.manager.snapshot_for_user("user-a").await;
        let session = snapshot
            .agent_sessions
            .iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert_eq!(session.current_model_id.as_deref(), Some("fake-model-b"));
        assert_eq!(session.available_models.len(), 2, "list untouched by None");
        assert_eq!(session.status, offdesk_protocol::AgentSessionStatus::Idle);
    }
}
