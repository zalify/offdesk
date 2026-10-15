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
use offdesk_protocol::{AgentAnswer, AgentRunInfo, InstalledAgent, StartAgentRun, StartedAgentRun};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::db::agent_runs;
use crate::AppState;

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
    let runs = rows
        .iter()
        .map(|row| agent_runs::to_info(&db, row))
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(Json(runs))
}

async fn get_run(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
) -> Result<Json<AgentRunInfo>, Response> {
    let db = state.db.get().map_err(internal)?;
    let Some(row) =
        agent_runs::find_for_user(&db, &run_id, &auth_user.user_id).map_err(internal)?
    else {
        return Err((StatusCode::NOT_FOUND, "Agent run not found").into_response());
    };
    Ok(Json(agent_runs::to_info(&db, &row).map_err(internal)?))
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
    if agent_runs::find_for_user(&db, &run_id, &auth_user.user_id)
        .map_err(internal)?
        .is_none()
    {
        return Err((StatusCode::NOT_FOUND, "Agent run not found").into_response());
    }
    Ok(Json(
        agent_runs::list_events(&db, &run_id, query.after_seq, 500).map_err(internal)?,
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
    match state
        .manager
        .answer_agent_run(&auth_user.user_id, &run_id, answer)
        .await
    {
        Ok(run) => Ok((StatusCode::ACCEPTED, Json(run))),
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
    let controller = state.manager.get_controller(&user_id, &machine_id);
    if !crate::routes::terminals::control_action_allowed(
        controller.as_deref(),
        start.device_id.as_deref(),
    ) {
        return Err((StatusCode::FORBIDDEN, "Take control of the machine first").into_response());
    }
    let opened_by = crate::routes::terminals::opener_for(&auth_user, None);
    let (run, terminal) = match state
        .manager
        .start_agent_run(&user_id, start, opened_by)
        .await
    {
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
