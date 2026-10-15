//! Agent runs over HTTP (docs/plans/2026-10-14-agent-runs.md): what coding agents are
//! doing in the caller's terminals. Read-only for now; live changes come over
//! /ws/events as `agent_run_updated`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use offdesk_protocol::AgentRunInfo;
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

fn internal(error: impl std::fmt::Display) -> Response {
    tracing::warn!("agent runs: {}", error);
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent-runs", get(list_runs))
        .route("/api/agent-runs/{run_id}", get(get_run))
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
