//! Agent browser relay: `POST /api/machines/{machine_id}/agent-browser`.
//!
//! The body is an `AgentBrowserCommand`; the hub forwards it to the node that
//! owns the headless Chromium and returns the node's reply data as JSON.
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use offdesk_protocol::{AgentBrowserCommand, AgentBrowserController, AgentBrowserInfo};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::machine_manager::{AgentBrowserError, ControlChange, ControlWait};
use crate::AppState;

/// The first `open` may download Chromium (~150 MB).
const OPEN_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const WAIT_GRACE: Duration = Duration::from_secs(15);

/// One control long-poll stays at the hub at most this long; the CLI loops.
const MAX_CONTROL_WAIT: Duration = Duration::from_secs(60);
const MAX_HANDOFF_REASON_CHARS: usize = 500;
const MAX_DEVICE_ID_CHARS: usize = 128;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/machines/{machine_id}/agent-browser",
            post(run_command),
        )
        .route(
            "/api/machines/{machine_id}/agent-browser/{browser_id}/control",
            get(wait_control).post(change_control),
        )
        .route(
            "/api/machines/{machine_id}/agent-browser/{browser_id}/handoff",
            post(request_handoff),
        )
}

/// The browser an agent command would change the page of, if it does.
fn mutated_browser(command: &AgentBrowserCommand) -> Option<&str> {
    match command {
        AgentBrowserCommand::Goto { browser_id, .. }
        | AgentBrowserCommand::Click { browser_id, .. }
        | AgentBrowserCommand::Fill { browser_id, .. }
        | AgentBrowserCommand::Login { browser_id, .. }
        | AgentBrowserCommand::Press { browser_id, .. }
        | AgentBrowserCommand::Close { browser_id } => Some(browser_id),
        _ => None,
    }
}

fn user_in_control(info: &AgentBrowserInfo) -> Response {
    let mut body = json!({
        "error": "a person is controlling this browser",
        "code": "user_in_control",
    });
    if let Some(handoff) = &info.handoff {
        body["reason"] = json!(handoff.reason);
    }
    (StatusCode::CONFLICT, Json(body)).into_response()
}

/// The response for a machine the user cannot use, `None` when they can.
async fn check_machine_access(
    state: &AppState,
    user_id: &str,
    machine_id: &str,
) -> Option<Response> {
    if state
        .manager
        .user_can_access_machine(user_id, machine_id)
        .await
    {
        return None;
    }
    // Offline machines are not "visible", but their owner should be told
    // so rather than that the machine does not exist.
    Some(
        match state.manager.offline_machine_name(user_id, machine_id) {
            Some(name) => error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("machine {name} is offline"),
            ),
            None => error_response(StatusCode::NOT_FOUND, "Machine not found"),
        },
    )
}

fn no_such_browser() -> Response {
    error_response(StatusCode::NOT_FOUND, "Agent browser not found")
}

fn control_reply(info: &AgentBrowserInfo, ready: bool) -> Response {
    Json(json!({
        "controller": info.controller,
        "ready": ready,
        "browser": info,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct ControlBody {
    action: String,
    #[serde(default)]
    device_id: Option<String>,
}

/// A person takes control of a browser or hands it back.
async fn change_control(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, browser_id)): Path<(String, String)>,
    Json(body): Json<ControlBody>,
) -> Response {
    if let Some(response) = check_machine_access(&state, &auth_user.user_id, &machine_id).await {
        return response;
    }
    let change = match body.action.as_str() {
        "take" => match body.device_id.filter(|d| !d.is_empty()) {
            Some(device_id) if device_id.chars().count() <= MAX_DEVICE_ID_CHARS => {
                ControlChange::Take { device_id }
            }
            _ => return error_response(StatusCode::BAD_REQUEST, "take needs a device_id"),
        },
        "release" => ControlChange::Release,
        _ => {
            return error_response(StatusCode::BAD_REQUEST, "action must be take or release");
        }
    };
    match state
        .manager
        .change_agent_browser_control(&machine_id, &browser_id, change)
        .await
    {
        Some(info) => Json(info).into_response(),
        None => no_such_browser(),
    }
}

#[derive(Deserialize)]
struct HandoffBody {
    reason: String,
}

/// The agent asks a person for help. It does not take control itself.
async fn request_handoff(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, browser_id)): Path<(String, String)>,
    Json(body): Json<HandoffBody>,
) -> Response {
    if let Some(response) = check_machine_access(&state, &auth_user.user_id, &machine_id).await {
        return response;
    }
    let reason = body.reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_HANDOFF_REASON_CHARS {
        return error_response(
            StatusCode::BAD_REQUEST,
            "reason must be 1 to 500 characters",
        );
    }
    match state
        .manager
        .change_agent_browser_control(
            &machine_id,
            &browser_id,
            ControlChange::Handoff {
                reason: reason.to_string(),
            },
        )
        .await
    {
        Some(info) => Json(info).into_response(),
        None => no_such_browser(),
    }
}

#[derive(Deserialize)]
struct WaitQuery {
    /// `agent`: until the agent controls the browser; `resolved`: also until
    /// no handoff is pending. Absent: answer at once.
    #[serde(default)]
    wait_for: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// Control state, optionally long-polling (at most 60 s per request) until
/// the agent controls the browser again. `ready` says whether the condition
/// holds; a timeout is a normal reply with `ready: false`.
async fn wait_control(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((machine_id, browser_id)): Path<(String, String)>,
    Query(query): Query<WaitQuery>,
) -> Response {
    if let Some(response) = check_machine_access(&state, &auth_user.user_id, &machine_id).await {
        return response;
    }
    let wait_for = match query.wait_for.as_deref() {
        None => None,
        Some("agent") => Some(ControlWait::Agent),
        Some("resolved") => Some(ControlWait::Resolved),
        Some(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "wait_for must be agent or resolved",
            );
        }
    };
    let result = match wait_for {
        Some(wait_for) => {
            let timeout =
                Duration::from_millis(query.timeout_ms.unwrap_or(30_000)).min(MAX_CONTROL_WAIT);
            state
                .manager
                .wait_agent_browser_control(&machine_id, &browser_id, wait_for, timeout)
                .await
        }
        None => state
            .manager
            .agent_browser_info(&machine_id, &browser_id)
            .await
            .map(|info| {
                let ready = info.controller == AgentBrowserController::Agent;
                (info, ready)
            }),
    };
    match result {
        Some((info, ready)) => control_reply(&info, ready),
        None => no_such_browser(),
    }
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

/// The node does not know who controls a browser; add the hub's view.
async fn overlay_control(
    state: &AppState,
    command: &AgentBrowserCommand,
    data: &mut Value,
    machine_id: &str,
) {
    if !matches!(
        command,
        AgentBrowserCommand::Goto { .. } | AgentBrowserCommand::List
    ) {
        return;
    }
    if data.is_object() {
        if let Ok(info) = serde_json::from_value::<AgentBrowserInfo>(data.clone()) {
            let mut infos = [info];
            state
                .manager
                .overlay_agent_browser_control(machine_id, &mut infos)
                .await;
            if let Ok(value) = serde_json::to_value(&infos[0]) {
                *data = value;
            }
        }
    } else if let Ok(mut infos) = serde_json::from_value::<Vec<AgentBrowserInfo>>(data.clone()) {
        state
            .manager
            .overlay_agent_browser_control(machine_id, &mut infos)
            .await;
        if let Ok(value) = serde_json::to_value(&infos) {
            *data = value;
        }
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
    if let Some(response) = check_machine_access(&state, &auth_user.user_id, &machine_id).await {
        return response;
    }
    // While a person controls the browser the agent may look but not touch.
    if let Some(browser_id) = mutated_browser(&command) {
        if let Some(info) = state
            .manager
            .agent_browser_info(&machine_id, browser_id)
            .await
        {
            if info.controller == AgentBrowserController::Human {
                return user_in_control(&info);
            }
        }
    }

    let timeout = timeout_for(&command);
    match state
        .manager
        .agent_browser(&machine_id, command.clone(), timeout)
        .await
    {
        Ok(mut data) => {
            fill_machine_id(&command, &mut data, &machine_id);
            overlay_control(&state, &command, &mut data, &machine_id).await;
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
    async fn own_offline_machine_is_service_unavailable() {
        let state = test_state();
        {
            let conn = state.db.get().unwrap();
            crate::db::machines::create_machine(&conn, "machine-off", "user-a", "Laptop", "hash")
                .unwrap();
            crate::db::machines::create_machine(&conn, "machine-theirs", "user-b", "Theirs", "hash")
                .ok();
        }
        let (status, body) = post_command(&state, "machine-off", json!({"type": "list"})).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "machine Laptop is offline");
        // Someone else's offline machine looks like any unknown one.
        let (status, _) = post_command(&state, "machine-theirs", json!({"type": "list"})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
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
                    url: Some("https://example.com".to_string()),
                    opener_terminal_id: None,
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
            timeout_for(&AgentBrowserCommand::Open {
                url: None,
                opener_terminal_id: None
            }),
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

    async fn request(
        state: &AppState,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let token = sign_jwt("user-a", &state.jwt_secret);
        let response = super::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
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

    async fn state_with_browser() -> (AppState, tokio::sync::mpsc::Receiver<HubToMachine>) {
        let state = test_state();
        let (_conn, rx) = state
            .manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        state
            .manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::AgentBrowserCreated {
                    browser: offdesk_protocol::AgentBrowserInfo {
                        id: "b1".to_string(),
                        url: "about:blank".to_string(),
                        ..Default::default()
                    },
                },
            )
            .await;
        (state, rx)
    }

    const CONTROL: &str = "/api/machines/machine-a/agent-browser/b1/control";

    #[tokio::test]
    async fn agent_mutations_are_refused_while_a_person_controls_the_browser() {
        let (state, mut node_rx) = state_with_browser().await;
        let (status, body) = request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "take", "device_id": "dev-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["controller"], "human");
        assert_eq!(body["controller_device_id"], "dev-a");
        request(
            &state,
            Method::POST,
            "/api/machines/machine-a/agent-browser/b1/handoff",
            Some(json!({"reason": "Please log in"})),
        )
        .await;

        for command in [
            json!({"type": "goto", "browser_id": "b1", "url": "https://x.test"}),
            json!({"type": "click", "browser_id": "b1", "ref": "e1"}),
            json!({"type": "fill", "browser_id": "b1", "ref": "e1", "text": "t"}),
            json!({"type": "press", "browser_id": "b1", "key": "Enter"}),
            json!({"type": "click", "browser_id": "b1", "text": "Sign in"}),
            json!({"type": "login", "browser_id": "b1", "password": "pw", "allowed_domains": ["x.test"]}),
            json!({"type": "close", "browser_id": "b1"}),
        ] {
            let (status, body) = post_command(&state, "machine-a", command.clone()).await;
            assert_eq!(status, StatusCode::CONFLICT, "{command}");
            assert_eq!(body["code"], "user_in_control");
            assert_eq!(body["error"], "a person is controlling this browser");
            assert_eq!(body["reason"], "Please log in");
        }
        // None of the refused commands reached the node.
        assert!(node_rx.try_recv().is_err());

        // Read-only commands still go through.
        for command in [
            json!({"type": "snapshot", "browser_id": "b1"}),
            json!({"type": "screenshot", "browser_id": "b1"}),
            json!({"type": "wait", "browser_id": "b1", "text": "x", "timeout_ms": 10}),
            json!({"type": "list"}),
        ] {
            let node_state = state.clone();
            let reply = tokio::spawn(async move {
                let HubToMachine::AgentBrowser { request_id, .. } = node_rx.recv().await.unwrap()
                else {
                    panic!("expected agent browser command");
                };
                node_state
                    .manager
                    .handle_machine_message(
                        "machine-a",
                        MachineToHub::AgentBrowserResult {
                            request_id,
                            data: Some(json!([{"id": "b1", "url": "u", "title": "t"}])),
                            error: None,
                        },
                    )
                    .await;
                node_rx
            });
            let (status, body) = post_command(&state, "machine-a", command.clone()).await;
            node_rx = reply.await.unwrap();
            assert_eq!(status, StatusCode::OK, "{command}");
            if command["type"] == "list" {
                // The hub's control state is overlaid on the node's list.
                assert_eq!(body[0]["controller"], "human");
                assert_eq!(body[0]["machine_id"], "machine-a");
            }
        }

        // Once the person releases, the agent can mutate again.
        let (status, body) = request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "release"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["controller"], "agent");
        assert!(body.get("handoff").is_none());
        let node_state = state.clone();
        let reply = tokio::spawn(async move {
            let HubToMachine::AgentBrowser { request_id, .. } = node_rx.recv().await.unwrap()
            else {
                panic!("expected agent browser command");
            };
            node_state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::AgentBrowserResult {
                        request_id,
                        data: Some(json!({})),
                        error: None,
                    },
                )
                .await;
        });
        let (status, _) = post_command(
            &state,
            "machine-a",
            json!({"type": "click", "browser_id": "b1", "ref": "e1"}),
        )
        .await;
        reply.await.unwrap();
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn control_requests_are_validated() {
        let (state, _rx) = state_with_browser().await;
        let (status, _) = request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "take"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "steal", "device_id": "d"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request(
            &state,
            Method::POST,
            "/api/machines/machine-a/agent-browser/nope/control",
            Some(json!({"action": "release"})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request(
            &state,
            Method::POST,
            "/api/machines/machine-a/agent-browser/b1/handoff",
            Some(json!({"reason": "   "})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request(
            &state,
            Method::GET,
            &format!("{CONTROL}?wait_for=sideways"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn handoff_long_poll_returns_after_the_person_releases() {
        let (state, _rx) = state_with_browser().await;
        let (status, body) = request(
            &state,
            Method::POST,
            "/api/machines/machine-a/agent-browser/b1/handoff",
            Some(json!({"reason": "2FA code"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // A handoff alone does not take control.
        assert_eq!(body["controller"], "agent");
        assert_eq!(body["handoff"]["reason"], "2FA code");

        let uri = format!("{CONTROL}?wait_for=resolved&timeout_ms=60");
        let (status, body) = request(&state, Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ready"], false, "{body}");

        let waiter = {
            let state = state.clone();
            tokio::spawn(async move {
                let uri = format!("{CONTROL}?wait_for=resolved&timeout_ms=30000");
                request(&state, Method::GET, &uri, None).await
            })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "take", "device_id": "dev-a"})),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiter.is_finished(), "taking control must not resolve it");
        request(
            &state,
            Method::POST,
            CONTROL,
            Some(json!({"action": "release"})),
        )
        .await;
        let (status, body) = waiter.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ready"], true);
        assert_eq!(body["controller"], "agent");
    }
}
