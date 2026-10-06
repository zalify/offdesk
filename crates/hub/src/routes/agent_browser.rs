//! Agent browser relay: `POST /api/machines/{machine_id}/agent-browser`.
//!
//! The body is an `AgentBrowserCommand`; the hub forwards it to the node that
//! owns the headless Chromium and returns the node's reply data as JSON.
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use offdesk_protocol::AgentBrowserCommand;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::machine_manager::AgentBrowserError;
use crate::AppState;

/// The first `open` may download Chromium (~150 MB).
const OPEN_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const WAIT_GRACE: Duration = Duration::from_secs(15);

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/machines/{machine_id}/agent-browser",
        post(run_command),
    )
}

fn timeout_for(command: &AgentBrowserCommand) -> Duration {
    match command {
        AgentBrowserCommand::Open { .. } => OPEN_TIMEOUT,
        AgentBrowserCommand::Wait { timeout_ms, .. } => {
            Duration::from_millis(*timeout_ms) + WAIT_GRACE
        }
        _ => DEFAULT_TIMEOUT,
    }
}

/// The node does not know its machine id; fill it in on the infos it returns.
fn fill_machine_id(command: &AgentBrowserCommand, data: &mut Value, machine_id: &str) {
    let fill = |info: &mut Value| {
        if let Some(object) = info.as_object_mut() {
            object.insert("machine_id".to_string(), json!(machine_id));
        }
    };
    match command {
        AgentBrowserCommand::Open { .. } | AgentBrowserCommand::Goto { .. } => fill(data),
        AgentBrowserCommand::List => {
            if let Some(items) = data.as_array_mut() {
                items.iter_mut().for_each(fill);
            }
        }
        _ => {}
    }
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn run_command(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(machine_id): Path<String>,
    Json(command): Json<AgentBrowserCommand>,
) -> Response {
    if !state
        .manager
        .user_can_access_machine(&auth_user.user_id, &machine_id)
        .await
    {
        return error_response(StatusCode::NOT_FOUND, "Machine not found");
    }

    let timeout = timeout_for(&command);
    match state
        .manager
        .agent_browser(&machine_id, command.clone(), timeout)
        .await
    {
        Ok(mut data) => {
            fill_machine_id(&command, &mut data, &machine_id);
            Json(data).into_response()
        }
        Err(AgentBrowserError::Offline(message)) => {
            error_response(StatusCode::SERVICE_UNAVAILABLE, &message)
        }
        Err(AgentBrowserError::Node(message)) => {
            error_response(StatusCode::UNPROCESSABLE_ENTITY, &message)
        }
        Err(AgentBrowserError::Timeout) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "Timed out waiting for the machine's agent browser",
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, StatusCode},
    };
    use offdesk_protocol::{AgentBrowserCommand, HubToMachine, MachineInfo, MachineToHub};
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::{timeout_for, Duration};
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

    async fn post_command(state: &AppState, machine_id: &str, body: Value) -> (StatusCode, Value) {
        let token = sign_jwt("user-a", &state.jwt_secret);
        let response = super::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/machines/{machine_id}/agent-browser"))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
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
    async fn unknown_machine_is_not_found() {
        let state = test_state();
        let (status, body) = post_command(&state, "nope", json!({"type": "list"})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Machine not found");
    }

    #[tokio::test]
    async fn other_users_machine_is_not_found() {
        let state = test_state();
        let (_conn, _rx) = state
            .manager
            .register_machine(machine("machine-b"), Some("user-b".to_string()))
            .await;
        let (status, _) = post_command(&state, "machine-b", json!({"type": "list"})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn open_result_gets_machine_id() {
        let state = test_state();
        let (_conn, mut cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        let node_state = state.clone();
        let node = tokio::spawn(async move {
            let HubToMachine::AgentBrowser {
                request_id,
                command,
            } = cmd_rx.recv().await.unwrap()
            else {
                panic!("expected agent browser command");
            };
            assert_eq!(
                command,
                AgentBrowserCommand::Open {
                    url: Some("https://example.com".to_string())
                }
            );
            node_state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentBrowserResult {
                        request_id,
                        data: Some(
                            json!({"id": "b1", "url": "https://example.com", "title": "Ex"}),
                        ),
                        error: None,
                    },
                )
                .await;
        });
        let (status, body) = post_command(
            &state,
            "machine-a",
            json!({"type": "open", "url": "https://example.com"}),
        )
        .await;
        node.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], "b1");
        assert_eq!(body["machine_id"], "machine-a");
    }

    #[tokio::test]
    async fn list_result_fills_every_machine_id() {
        let state = test_state();
        let (_conn, mut cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        let node_state = state.clone();
        let node = tokio::spawn(async move {
            let HubToMachine::AgentBrowser { request_id, .. } = cmd_rx.recv().await.unwrap() else {
                panic!("expected agent browser command");
            };
            node_state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentBrowserResult {
                        request_id,
                        data: Some(json!([
                            {"id": "b1", "url": "u", "title": "t"},
                            {"id": "b2", "url": "u", "title": "t"}
                        ])),
                        error: None,
                    },
                )
                .await;
        });
        let (status, body) = post_command(&state, "machine-a", json!({"type": "list"})).await;
        node.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["machine_id"], "machine-a");
        assert_eq!(body[1]["machine_id"], "machine-a");
    }

    #[tokio::test]
    async fn node_error_is_unprocessable() {
        let state = test_state();
        let (_conn, mut cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        let node_state = state.clone();
        let node = tokio::spawn(async move {
            let HubToMachine::AgentBrowser { request_id, .. } = cmd_rx.recv().await.unwrap() else {
                panic!("expected agent browser command");
            };
            node_state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentBrowserResult {
                        request_id,
                        data: None,
                        error: Some("no such browser".to_string()),
                    },
                )
                .await;
        });
        let (status, body) = post_command(
            &state,
            "machine-a",
            json!({"type": "snapshot", "browser_id": "zzz"}),
        )
        .await;
        node.await.unwrap();
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "no such browser");
    }

    #[tokio::test]
    async fn manager_times_out_and_forgets_the_request() {
        let state = test_state();
        let (_conn, mut cmd_rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        let result = state
            .manager
            .agent_browser(
                "machine-a",
                AgentBrowserCommand::List,
                Duration::from_millis(50),
            )
            .await;
        assert_eq!(
            result,
            Err(crate::machine_manager::AgentBrowserError::Timeout)
        );
        // A late reply for the forgotten request is ignored without panicking.
        let HubToMachine::AgentBrowser { request_id, .. } = cmd_rx.recv().await.unwrap() else {
            panic!("expected agent browser command");
        };
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentBrowserResult {
                    request_id,
                    data: Some(json!([])),
                    error: None,
                },
            )
            .await;
    }

    #[test]
    fn timeouts_per_command() {
        assert_eq!(
            timeout_for(&AgentBrowserCommand::Open { url: None }),
            Duration::from_secs(300)
        );
        assert_eq!(
            timeout_for(&AgentBrowserCommand::List),
            Duration::from_secs(60)
        );
        assert_eq!(
            timeout_for(&AgentBrowserCommand::Wait {
                browser_id: "b".into(),
                text: None,
                url_regex: None,
                idle_ms: None,
                timeout_ms: 30_000,
            }),
            Duration::from_secs(45)
        );
    }
}
