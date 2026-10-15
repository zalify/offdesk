//! Agent runs over HTTP (docs/plans/2026-10-14-agent-runs.md): what coding agents are
//! doing in the caller's terminals, answering them, and starting one. Live changes come
//! over /ws/events as `agent_run_updated`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use std::collections::HashSet;

use offdesk_protocol::{
    AgentAnswer, AgentRequestKind, AgentRunInfo, ContentLevel, InstalledAgent, StartAgentRun,
    StartedAgentRun, TokenScope,
};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthUser;
use crate::db::agent_runs;
use crate::AppState;

/// The machines a scoped token may reach; None: any of the caller's (full access).
fn reachable_machines(
    db: &rusqlite::Connection,
    auth_user: &AuthUser,
) -> rusqlite::Result<Option<HashSet<String>>> {
    let Some(access) = &auth_user.access else {
        return Ok(None);
    };
    Ok(Some(
        crate::db::machines::find_machines_by_user(db, &auth_user.user_id)?
            .into_iter()
            .filter(|machine| access.allows_machine(&machine.id, machine.production))
            .map(|machine| machine.id)
            .collect(),
    ))
}

/// A run as a scoped token sees it: no request text below `requests`, no notes or
/// current step below `notes`. Full access sees everything.
fn shown_run(mut run: AgentRunInfo, level: Option<ContentLevel>) -> AgentRunInfo {
    let Some(level) = level else {
        return run;
    };
    if level < ContentLevel::Requests {
        if let Some(request) = run.request.as_mut() {
            request.prompt = None;
            request.options.clear();
        }
    }
    if level < ContentLevel::Notes {
        if let Some(progress) = run.progress.as_mut() {
            progress.current = None;
        }
        if let Some(report) = run.report.as_mut() {
            report.text.clear();
            report.link = None;
        }
    }
    run
}

/// A history entry at the same content level as `shown_run`.
fn shown_event(mut event: Value, level: Option<ContentLevel>) -> Value {
    let Some(level) = level else {
        return event;
    };
    let kind = event["kind"].as_str().unwrap_or_default().to_string();
    if let Some(body) = event.get_mut("event").and_then(Value::as_object_mut) {
        if level < ContentLevel::Requests && (kind == "request" || kind == "answer") {
            body.remove("prompt");
            body.remove("options");
            if let Some(answer) = body.get_mut("answer").and_then(Value::as_object_mut) {
                answer.remove("text");
                answer.remove("option_id");
            }
        }
        if level < ContentLevel::Notes && kind == "report" {
            body.remove("text");
            body.remove("link");
        }
    }
    event
}

fn forbidden(auth_user: &AuthUser, state: &AppState, action: &str, target: &str, reason: &str) -> Response {
    auth_user.audit(&state.db, action, target, reason);
    (StatusCode::FORBIDDEN, reason.to_string()).into_response()
}

/// A token's hourly limit for `actions`: refused once it did that many in the last hour.
fn over_limit(state: &AppState, auth_user: &AuthUser, actions: &[&str], limit: Option<u32>) -> bool {
    let (Some(limit), Some(token_id)) = (limit, auth_user.api_token_id.as_deref()) else {
        return false;
    };
    let since = crate::db::now_ms() - 3600 * 1000;
    state
        .db
        .get()
        .ok()
        .and_then(|db| crate::db::tokens::count_audit(&db, token_id, actions, since).ok())
        .is_some_and(|done| done >= i64::from(limit))
}

/// How far back ended runs are listed by default.
const RECENT_MS: i64 = 24 * 3600 * 1000;
const LIST_LIMIT: i64 = 200;

#[derive(Deserialize)]
struct ListQuery {
    /// Only runs that haven't ended.
    #[serde(default)]
    active: bool,
    /// Only runs on this machine.
    machine: Option<String>,
}

async fn list_runs(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<AgentRunInfo>>, Response> {
    let db = state.db.get().map_err(internal)?;
    let ended_since = if query.active {
        i64::MAX
    } else {
        crate::db::now_ms() - RECENT_MS
    };
    let rows = agent_runs::list_for_user(
        &db,
        &auth_user.user_id,
        ended_since,
        query.machine.as_deref(),
        LIST_LIMIT,
    )
    .map_err(internal)?;
    let reachable = reachable_machines(&db, &auth_user).map_err(internal)?;
    let level = auth_user.access.as_ref().map(|access| access.content);
    let runs = rows
        .iter()
        .filter(|row| reachable.as_ref().is_none_or(|ids| ids.contains(&row.machine_id)))
        .map(|row| agent_runs::to_info(&db, row).map(|run| shown_run(run, level)))
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(Json(runs))
}

/// A run of the caller's that a scoped token may see, or None.
fn visible_run(
    db: &rusqlite::Connection,
    auth_user: &AuthUser,
    run_id: &str,
) -> rusqlite::Result<Option<agent_runs::AgentRunRow>> {
    let Some(row) = agent_runs::find_for_user(db, run_id, &auth_user.user_id)? else {
        return Ok(None);
    };
    let reachable = reachable_machines(db, auth_user)?;
    Ok(reachable
        .is_none_or(|ids| ids.contains(&row.machine_id))
        .then_some(row))
}

async fn get_run(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
) -> Result<Json<AgentRunInfo>, Response> {
    let db = state.db.get().map_err(internal)?;
    let Some(row) = visible_run(&db, &auth_user, &run_id).map_err(internal)? else {
        return Err((StatusCode::NOT_FOUND, "Agent run not found").into_response());
    };
    let level = auth_user.access.as_ref().map(|access| access.content);
    Ok(Json(shown_run(
        agent_runs::to_info(&db, &row).map_err(internal)?,
        level,
    )))
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after_seq: i64,
}

/// A run's history (requests, reports, status changes from its hooks), oldest first.
/// Never terminal output.
async fn run_events(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Vec<serde_json::Value>>, Response> {
    let db = state.db.get().map_err(internal)?;
    if visible_run(&db, &auth_user, &run_id)
        .map_err(internal)?
        .is_none()
    {
        return Err((StatusCode::NOT_FOUND, "Agent run not found").into_response());
    }
    let level = auth_user.access.as_ref().map(|access| access.content);
    Ok(Json(
        agent_runs::list_events(&db, &run_id, query.after_seq, 500)
            .map_err(internal)?
            .into_iter()
            .map(|event| shown_event(event, level))
            .collect(),
    ))
}

/// Answer the run's open request: the node types it into the terminal. 202 means it was
/// sent, not that the agent took it; the run's next update says that.
async fn answer_run(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
    Json(answer): Json<AgentAnswer>,
) -> Result<(StatusCode, Json<AgentRunInfo>), Response> {
    use crate::machine_manager::AnswerError;
    // Approvals and answers are separate scopes: saying yes to a command is another thing
    let kind = {
        let db = state.db.get().map_err(internal)?;
        let Some(run) = visible_run(&db, &auth_user, &run_id).map_err(internal)? else {
            return Err((StatusCode::NOT_FOUND, "Agent run not found").into_response());
        };
        agent_runs::open_request(&db, &run.id)
            .map_err(internal)?
            .filter(|request| request.id == answer.request_id)
            .map(|request| request.kind)
    };
    let action = if kind == Some(AgentRequestKind::Approval) { "approve" } else { "answer" };
    let scope = if action == "approve" { TokenScope::RunsApprove } else { TokenScope::RunsAnswer };
    if !auth_user.allows(scope) {
        let reason = format!("This token can't {action}; it needs {}", scope.as_str());
        return Err(forbidden(&auth_user, &state, action, &run_id, &reason));
    }
    let limit = auth_user.access.as_ref().and_then(|access| access.max_answers_per_hour);
    if over_limit(&state, &auth_user, &["answer", "approve"], limit) {
        auth_user.audit(&state.db, action, &run_id, "hourly limit reached");
        return Err((StatusCode::TOO_MANY_REQUESTS, "This token reached its hourly limit of answers").into_response());
    }
    let level = auth_user.access.as_ref().map(|access| access.content);
    let result = state
        .manager
        .answer_agent_run(&auth_user.user_id, &run_id, answer)
        .await;
    auth_user.audit(
        &state.db,
        action,
        &run_id,
        match &result {
            Ok(_) => "ok",
            Err(AnswerError::Conflict(reason) | AnswerError::BadRequest(reason) | AnswerError::Unavailable(reason)) => reason,
            Err(AnswerError::NotFound) => "not found",
            Err(AnswerError::Internal) => "failed",
        },
    );
    match result {
        Ok(run) => Ok((StatusCode::ACCEPTED, Json(shown_run(run, level)))),
        Err(AnswerError::NotFound) => {
            Err((StatusCode::NOT_FOUND, "Agent run not found").into_response())
        }
        Err(AnswerError::Conflict(reason)) => Err((StatusCode::CONFLICT, reason).into_response()),
        Err(AnswerError::BadRequest(reason)) => {
            Err((StatusCode::BAD_REQUEST, reason).into_response())
        }
        Err(AnswerError::Unavailable(reason)) => {
            Err((StatusCode::SERVICE_UNAVAILABLE, reason).into_response())
        }
        Err(AnswerError::Internal) => Err(internal("answer failed")),
    }
}

/// Start a coding agent (claude or codex) in a new terminal with its first message. The
/// hub builds the command from the fields; there's no way to pass a command line, nor
/// to skip the agent's permission prompts. 201: the run is Starting until the agent
/// shows up in the terminal, and an Error if it hasn't within a minute.
async fn start_run(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(start): Json<StartAgentRun>,
) -> Result<(StatusCode, Json<StartedAgentRun>), Response> {
    use crate::machine_manager::StartError;
    let user_id = auth_user.user_id.clone();
    let machine_id = start.machine_id.clone();
    if !state
        .manager
        .user_can_access_machine(&user_id, &machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found").into_response());
    }
    crate::routes::terminals::ensure_machine_row(&state, &user_id, &machine_id)
        .await
        .map_err(IntoResponse::into_response)?;
    // A scoped token: its machines, agents and folders, and its hourly limit
    let mut allowed_dirs = None;
    if let Some(access) = &auth_user.access {
        if !auth_user.may_reach_machine(&state.db, &machine_id) {
            return Err(forbidden(&auth_user, &state, "start", &machine_id, "This token can't reach that machine"));
        }
        if !access.allows_agent(start.agent) {
            return Err(forbidden(&auth_user, &state, "start", &machine_id, "This token can't start that agent"));
        }
        if !access.allows_dir(start.cwd.trim()) {
            return Err(forbidden(&auth_user, &state, "start", &machine_id, "That folder isn't one this token may start in"));
        }
        if over_limit(&state, &auth_user, &["start"], access.max_starts_per_hour) {
            auth_user.audit(&state.db, "start", &machine_id, "hourly limit reached");
            return Err((StatusCode::TOO_MANY_REQUESTS, "This token reached its hourly limit of starts").into_response());
        }
        allowed_dirs = access.dirs.clone();
    }
    let controller = state.manager.get_controller(&user_id, &machine_id);
    if !crate::routes::terminals::control_action_allowed(
        controller.as_deref(),
        start.device_id.as_deref(),
    ) {
        return Err((StatusCode::FORBIDDEN, "Take control of the machine first").into_response());
    }
    let opened_by = crate::routes::terminals::opener_for(&auth_user, None);
    let result = state
        .manager
        .start_agent_run(&user_id, start, opened_by, allowed_dirs)
        .await;
    let outcome = match &result {
        Ok((run, _)) => format!("ok: run {}", run.id),
        Err(StartError::BadRequest(reason) | StartError::Unavailable(reason) | StartError::Machine(reason)) => reason.clone(),
        Err(StartError::Internal) => "failed".to_string(),
    };
    let target = outcome.strip_prefix("ok: run ").unwrap_or(&machine_id).to_string();
    auth_user.audit(&state.db, "start", &target, if outcome.starts_with("ok") { "ok" } else { &outcome });
    let (run, terminal) = match result {
        Ok(started) => started,
        Err(StartError::BadRequest(reason)) => {
            return Err((StatusCode::BAD_REQUEST, reason).into_response())
        }
        Err(StartError::Unavailable(reason)) => {
            return Err((StatusCode::SERVICE_UNAVAILABLE, reason).into_response())
        }
        Err(StartError::Machine(reason)) => {
            return Err((StatusCode::BAD_GATEWAY, reason).into_response())
        }
        Err(StartError::Internal) => return Err(internal("start failed")),
    };

    // Like any new terminal, it gets its own tab
    let group_id = crate::routes::terminals::auto_create_workspace_group(
        &state,
        &user_id,
        &machine_id,
        &terminal.cwd,
    )
    .await
    .map_err(IntoResponse::into_response)?;
    let terminal = state
        .manager
        .set_terminal_workspace_group(&user_id, &machine_id, &terminal.id, Some(group_id))
        .await
        .map_err(internal)?;

    let manager = state.manager.clone();
    let run_id = run.id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(crate::machine_manager::START_TIMEOUT).await;
        manager.expire_start(&user_id, &run_id);
    });
    Ok((StatusCode::CREATED, Json(StartedAgentRun { run, terminal })))
}

/// The coding agents a machine found installed, for choosing what to start. Empty when
/// its node doesn't report them yet.
async fn machine_agents(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(machine_id): Path<String>,
) -> Result<Json<Vec<InstalledAgent>>, Response> {
    if !state
        .manager
        .user_can_access_machine(&auth_user.user_id, &machine_id)
        .await
        || !auth_user.may_reach_machine(&state.db, &machine_id)
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found").into_response());
    }
    Ok(Json(
        state
            .manager
            .installed_agents(&machine_id)
            .await
            .unwrap_or_default(),
    ))
}

fn internal(error: impl std::fmt::Display) -> Response {
    tracing::warn!("agent runs: {}", error);
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent-runs", get(list_runs).post(start_run))
        .route("/api/machines/{machine_id}/agents", get(machine_agents))
        .route("/api/agent-runs/{run_id}", get(get_run))
        .route("/api/agent-runs/{run_id}/events", get(run_events))
        .route("/api/agent-runs/{run_id}/answer", post(answer_run))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use offdesk_protocol::{AgentRunStatus, RunAgent};
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::attach_router::HubRouter;
    use crate::auth::sign_jwt;
    use crate::machine_manager::MachineManager;

    fn test_state() -> AppState {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        for (user, machine) in [("user-a", "machine-a"), ("user-b", "machine-b")] {
            crate::db::users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
            crate::db::machines::ensure_machine_for_user(
                &conn,
                machine,
                user,
                machine,
                Some("linux"),
                Some("/tmp"),
            )
            .unwrap();
        }
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

    async fn get_json(state: &AppState, user: &str, uri: &str) -> (StatusCode, Value) {
        let token = sign_jwt(user, &state.jwt_secret);
        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post_json(state: &AppState, user: &str, uri: &str, body: Value) -> (StatusCode, String) {
        let token = sign_jwt(user, &state.jwt_secret);
        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn starting_needs_the_machine_and_its_control() {
        let state = test_state();
        let machine = offdesk_protocol::MachineInfo {
            id: "machine-a".into(),
            name: "machine-a".into(),
            os: "linux".into(),
            home_dir: "/tmp".into(),
            production: false,
        };
        let (_, _commands) = state
            .manager
            .register_machine_with_capabilities(
                machine,
                Some("user-a".into()),
                vec![offdesk_protocol::AGENT_START_CAPABILITY.into()],
            )
            .await;
        let body = |device: &str, prompt: &str| {
            serde_json::json!({ "machine_id": "machine-a", "agent": "claude", "cwd": "/tmp", "prompt": prompt, "device_id": device })
        };
        let (status, _) = post_json(&state, "user-b", "/api/agent-runs", body("phone", "Hi")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = post_json(&state, "user-a", "/api/agent-runs", body("phone", "Hi")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        state.manager.request_control("user-a", "machine-a", "phone");
        let (status, reason) =
            post_json(&state, "user-a", "/api/agent-runs", body("phone", "-p hi")).await;
        assert_eq!((status, reason.as_str()), (StatusCode::BAD_REQUEST, "The prompt can't start with '-'"));
        // There's no field for a command, nor one to skip permissions
        let mut sneaky = body("phone", "Hi");
        sneaky["permission_mode"] = "bypass_permissions".into();
        let (status, _) = post_json(&state, "user-a", "/api/agent-runs", sneaky).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        let (status, agents) = get_json(&state, "user-a", "/api/machines/machine-a/agents").await;
        assert_eq!((status, agents), (StatusCode::OK, serde_json::json!([])));
        let (status, _) = get_json(&state, "user-b", "/api/machines/machine-a/agents").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// A request through every route, as the hub serves them, with a raw bearer token.
    async fn call(state: &AppState, token: &str, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, String) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let response = crate::routes::router()
            .with_state(state.clone())
            .oneshot(request.body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    fn token(state: &AppState, raw: &str, access: Option<offdesk_protocol::TokenAccess>) {
        let db = state.db.get().unwrap();
        crate::db::tokens::create_scoped_api_token(
            &db,
            raw,
            "user-a",
            raw,
            &crate::auth::hash_token(raw),
            None,
            access.as_ref(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn scoped_tokens_reach_only_agent_runs_within_their_limits() {
        use offdesk_protocol::{AgentRequestKind, ContentLevel, TokenAccess, TokenScope};
        let state = test_state();
        let (waiting, approval, on_production) = {
            let db = state.db.get().unwrap();
            crate::db::machines::ensure_machine_for_user(&db, "machine-p", "user-a", "prod", Some("linux"), Some("/tmp")).unwrap();
            crate::db::machines::set_machine_production(&db, "machine-p", true).unwrap();
            let run = |machine: &str, terminal: &str| {
                agent_runs::insert(&db, machine, terminal, RunAgent::Claude, "/w", AgentRunStatus::Working).unwrap()
            };
            let waiting = run("machine-a", "t1");
            agent_runs::insert_request(&db, &waiting.id, AgentRequestKind::Question, Some("Which plan?"), &[], "hooks").unwrap();
            let approval = run("machine-a", "t2");
            agent_runs::insert_request(&db, &approval.id, AgentRequestKind::Approval, Some("Bash: psql $PROD"), &[], "hooks").unwrap();
            (waiting, approval, run("machine-p", "t3"))
        };
        let machine = offdesk_protocol::MachineInfo {
            id: "machine-a".into(),
            name: "machine-a".into(),
            os: "linux".into(),
            home_dir: "/tmp".into(),
            production: false,
        };
        let (_, _commands) = state
            .manager
            .register_machine_with_capabilities(machine, Some("user-a".into()), vec![offdesk_protocol::AGENT_START_CAPABILITY.into()])
            .await;
        token(&state, "odk_full", None);
        token(&state, "odk_read", Some(TokenAccess { scopes: vec![TokenScope::RunsRead], ..Default::default() }));
        token(
            &state,
            "odk_answer",
            Some(TokenAccess { scopes: vec![TokenScope::RunsAnswer], content: ContentLevel::Requests, ..Default::default() }),
        );
        token(
            &state,
            "odk_start",
            Some(TokenAccess {
                scopes: vec![TokenScope::RunsStart],
                dirs: Some(vec!["/w/allowed".into()]),
                agents: Some(vec![RunAgent::Claude]),
                ..Default::default()
            }),
        );

        // Terminals, input, machines' settings, tokens and files are closed to runs:read
        for (method, uri) in [
            ("GET", "/api/machines/machine-a/terminals"),
            ("POST", "/api/machines/machine-a/terminals"),
            ("DELETE", "/api/machines/machine-a/terminals/t1"),
            ("GET", "/api/machines/machine-a/fs/list?path=/"),
            ("GET", "/api/auth/api-tokens"),
            ("POST", "/api/auth/api-tokens"),
            ("POST", &format!("/api/agent-runs/{}/answer", waiting.id)),
            ("POST", "/api/agent-runs"),
        ] {
            let body = (method == "POST").then(|| serde_json::json!({}));
            let (status, _) = call(&state, "odk_read", method, uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        }
        // ...and so are the WebSockets and the beacon, which take full access only
        assert!(crate::auth::verify_bearer_token("odk_read", &state.db, &state.jwt_secret).is_err());
        assert!(crate::auth::verify_bearer_token("odk_full", &state.db, &state.jwt_secret).is_ok());
        // A full token works as before
        let (status, _) = call(&state, "odk_full", "GET", "/api/machines/machine-a/terminals", None).await;
        assert_ne!(status, StatusCode::FORBIDDEN);

        // runs:read sees runs off production machines, without what they ask
        let (status, body) = call(&state, "odk_read", "GET", "/api/agent-runs", None).await;
        assert_eq!(status, StatusCode::OK);
        let runs: Vec<AgentRunInfo> = serde_json::from_str(&body).unwrap();
        assert!(runs.iter().all(|run| run.id != on_production.id), "production machines are left out");
        let question = runs.iter().find(|run| run.id == waiting.id).unwrap();
        assert_eq!(question.request.as_ref().unwrap().prompt, None);
        let (status, _) = call(&state, "odk_read", "GET", &format!("/api/agent-runs/{}", on_production.id), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // At the requests level the question shows
        let (_, body) = call(&state, "odk_answer", "GET", &format!("/api/agent-runs/{}", waiting.id), None).await;
        assert!(body.contains("Which plan?"), "{body}");

        // runs:answer can't approve: that's runs:approve
        let request_id = |run: &str| {
            agent_runs::open_request(&state.db.get().unwrap(), run).unwrap().unwrap().id
        };
        let answer = serde_json::json!({ "request_id": request_id(&approval.id), "approve": true, "device_id": "d" });
        let (status, body) = call(&state, "odk_answer", "POST", &format!("/api/agent-runs/{}/answer", approval.id), Some(answer)).await;
        assert_eq!((status, body.as_str()), (StatusCode::FORBIDDEN, "This token can't approve; it needs runs:approve"));

        // runs:start stays in its folders and agents; `..` doesn't get out
        let start = |cwd: &str, agent: &str| {
            serde_json::json!({ "machine_id": "machine-a", "agent": agent, "cwd": cwd, "prompt": "Hi", "device_id": "d" })
        };
        for (cwd, agent, reason) in [
            ("/w/allowed/../secret", "claude", "That folder isn't one this token may start in"),
            ("/w/allowed-not", "claude", "That folder isn't one this token may start in"),
            ("relative/path", "claude", "That folder isn't one this token may start in"),
            ("/w/allowed/shop", "codex", "This token can't start that agent"),
        ] {
            let (status, body) = call(&state, "odk_start", "POST", "/api/agent-runs", Some(start(cwd, agent))).await;
            assert_eq!((status, body.as_str()), (StatusCode::FORBIDDEN, reason), "{cwd}");
        }

        // Every refusal is on record, newest first
        let (status, body) = call(&state, "odk_full", "GET", "/api/auth/api-tokens/audit", None).await;
        assert_eq!(status, StatusCode::OK);
        let audit: Vec<Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(audit[0]["token_name"], "odk_start");
        assert_eq!(audit[0]["result"], "This token can't start that agent");
        assert!(audit.iter().any(|e| e["token_name"] == "odk_answer" && e["action"] == "approve"));
        assert!(audit.iter().any(|e| e["token_name"] == "odk_read" && e["action"] == "denied" && e["target"] == "GET /api/auth/api-tokens"));
        // A scoped token can't read the audit, nor make itself a broader token
        let (status, _) = call(&state, "odk_read", "GET", "/api/auth/api-tokens/audit", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // An hourly limit counts what the token did in the last hour
        token(
            &state,
            "odk_limited",
            Some(TokenAccess { scopes: vec![TokenScope::RunsAnswer], max_answers_per_hour: Some(1), ..Default::default() }),
        );
        crate::db::tokens::insert_audit(&state.db.get().unwrap(), "user-a", "odk_limited", "odk_limited", "answer", "earlier", "ok").unwrap();
        let answer = serde_json::json!({ "request_id": request_id(&waiting.id), "text": "Pro", "device_id": "d" });
        let (status, _) = call(&state, "odk_limited", "POST", &format!("/api/agent-runs/{}/answer", waiting.id), Some(answer)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

        // Access stored by a newer hub that this one can't read allows nothing, never everything
        state
            .db
            .get()
            .unwrap()
            .execute("UPDATE api_tokens SET access = '{\"scopes\":[\"runs:everything\"]}' WHERE id = 'odk_read'", [])
            .unwrap();
        let (status, _) = call(&state, "odk_read", "GET", "/api/agent-runs", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(crate::auth::verify_bearer_token("odk_read", &state.db, &state.jwt_secret).is_err());
    }

    #[tokio::test]
    async fn tokens_are_full_unless_made_narrow() {
        let state = test_state();
        let jwt = sign_jwt("user-a", &state.jwt_secret);
        let create = |body: Value| call(&state, &jwt, "POST", "/api/auth/api-tokens", Some(body));
        // As before: no access given, full access (the CLI's login)
        let (status, body) = create(serde_json::json!({ "name": "cli" })).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["access"], Value::Null);
        // Starting needs folders, and they can't climb out
        let (status, _) = create(serde_json::json!({ "name": "bot", "access": { "scopes": ["runs:start"] } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = create(serde_json::json!({ "name": "bot", "access": { "scopes": ["runs:start"], "dirs": ["/w/../etc"] } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = create(serde_json::json!({ "name": "bot", "access": { "scopes": ["runs:read", "runs:start"], "dirs": ["~/work"], "content": "requests" } })).await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = call(&state, &jwt, "GET", "/api/auth/api-tokens", None).await;
        let tokens: Vec<Value> = serde_json::from_str(&body).unwrap();
        let bot = tokens.iter().find(|t| t["name"] == "bot").unwrap();
        assert_eq!(bot["access"]["scopes"], serde_json::json!(["runs:read", "runs:start"]));
        assert_eq!(bot["access"]["content"], "requests");
        // A scope this hub doesn't know is refused, never read as full
        let (status, _) = create(serde_json::json!({ "name": "x", "access": { "scopes": ["runs:everything"] } })).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn runs_are_listed_for_their_machine_owner_and_filtered() {
        let state = test_state();
        let (working, done) = {
            let db = state.db.get().unwrap();
            let working = agent_runs::insert(
                &db,
                "machine-a",
                "t1",
                RunAgent::Claude,
                "/w",
                AgentRunStatus::Working,
            )
            .unwrap();
            let done = agent_runs::insert(
                &db,
                "machine-a",
                "t2",
                RunAgent::Codex,
                "/w",
                AgentRunStatus::Working,
            )
            .unwrap();
            agent_runs::set_status(&db, &done.id, AgentRunStatus::Done).unwrap();
            agent_runs::insert(
                &db,
                "machine-b",
                "t3",
                RunAgent::Claude,
                "/w",
                AgentRunStatus::Working,
            )
            .unwrap();
            (working, done)
        };

        let (status, all) = get_json(&state, "user-a", "/api/agent-runs").await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = all
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec![done.id.as_str(), working.id.as_str()]);
        assert_eq!(all[0]["status"], "done");
        assert_eq!(all[1]["agent"], "claude");

        let (_, active) = get_json(&state, "user-a", "/api/agent-runs?active=true").await;
        assert_eq!(active.as_array().unwrap().len(), 1);
        let (_, other_machine) =
            get_json(&state, "user-a", "/api/agent-runs?machine=machine-b").await;
        assert_eq!(other_machine.as_array().unwrap().len(), 0);

        let (status, one) =
            get_json(&state, "user-a", &format!("/api/agent-runs/{}", working.id)).await;
        assert_eq!(
            (status, one["terminal_id"].as_str()),
            (StatusCode::OK, Some("t1"))
        );
        let (status, _) =
            get_json(&state, "user-b", &format!("/api/agent-runs/{}", working.id)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
