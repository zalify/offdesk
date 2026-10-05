//! Personal to-dos. Any signed-in device of the user can read and edit them;
//! unlike terminal actions they need no machine control. Every change is
//! pushed to the user's other devices as a browser event.
use axum::{
    extract::{FromRequestParts, Path, State},
    http::request::Parts,
    http::StatusCode,
    response::Json,
    routing::{get, patch, post},
    Router,
};
use offdesk_protocol::relay::{RelayAgent, StartupPrompt};
use offdesk_protocol::todos::{
    normalize_notes, normalize_title, TodoInfo, TodoStatus, MAX_TODOS_PER_USER,
};
use offdesk_protocol::TerminalInfo;
use serde::{Deserialize, Deserializer, Serialize};

use super::relays::{require_relay_node, start_agent_terminal};
use super::terminals::{control_action_allowed, ensure_machine_row};
use crate::auth::AuthUser;
use crate::db::todos::{NewTodo, TodoPatch};
use crate::AppState;

type ApiError = (StatusCode, String);

const MAX_CWD_CHARS: usize = 4096;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/todos", get(list_todos).post(create_todo))
        .route("/api/todos/{id}", patch(update_todo).delete(delete_todo))
        .route("/api/todos/{id}/dispatch", post(dispatch_todo))
}

/// Who is calling a to-do route: a signed-in user, or an Offdesk machine
/// using its own credentials on behalf of its owner. The machine path lets
/// the `offdesk todo` CLI work in any terminal on that machine without an
/// API token; it reaches only the owner's to-dos, never terminal control.
struct TodoCaller {
    user_id: String,
    /// Set when the caller is a machine: new to-dos default to it.
    machine_id: Option<String>,
}

/// `X-Offdesk-Machine: <machine id>` with `Authorization: Machine <secret>`.
const MACHINE_HEADER: &str = "x-offdesk-machine";

impl FromRequestParts<AppState> for TodoCaller {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let unauthorized = || (StatusCode::UNAUTHORIZED, "Unauthorized".to_string());
        if let Some(machine_id) = parts.headers.get(MACHINE_HEADER) {
            let machine_id = machine_id.to_str().map_err(|_| unauthorized())?.to_string();
            let secret = parts
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Machine "))
                .ok_or_else(unauthorized)?;
            return match crate::ws::authenticate_machine(state, &machine_id, secret).await {
                // A machine without an owner (dev mode) has no to-do list.
                Ok(Some(user_id)) => Ok(Self {
                    user_id,
                    machine_id: Some(machine_id),
                }),
                _ => Err(unauthorized()),
            };
        }
        let user = AuthUser::from_request_parts(parts, state)
            .await
            .map_err(|_| unauthorized())?;
        Ok(Self {
            user_id: user.user_id,
            machine_id: None,
        })
    }
}

fn db_error(error: impl std::fmt::Display) -> ApiError {
    tracing::error!("to-do database error: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save the to-do".to_string(),
    )
}

fn bad_request(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, message.to_string())
}

/// `null` clears a field; an absent field leaves it unchanged.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct CreateTodoRequest {
    id: String,
    title: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    /// Adopt the agent running in this terminal (on `machine_id`): the new
    /// to-do follows its task list.
    #[serde(default)]
    terminal_id: Option<String>,
}

#[derive(Deserialize)]
struct DispatchRequest {
    agent: RelayAgent,
    #[serde(default)]
    device_id: Option<String>,
    prompt: String,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

fn default_cols() -> u16 {
    120
}

fn default_rows() -> u16 {
    40
}

#[derive(Serialize)]
struct DispatchResponse {
    todo: TodoInfo,
    terminal: TerminalInfo,
}

#[derive(Deserialize)]
struct UpdateTodoRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    status: Option<TodoStatus>,
    #[serde(default)]
    position: Option<f64>,
    #[serde(default, deserialize_with = "nullable")]
    machine_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    cwd: Option<Option<String>>,
}

async fn validate_location(
    state: &AppState,
    user_id: &str,
    machine_id: Option<&str>,
    cwd: Option<&str>,
) -> Result<(), ApiError> {
    if let Some(machine_id) = machine_id {
        // A to-do may name a machine that is offline right now: ownership
        // comes from the machines table, not only from a live connection.
        let owned = {
            let conn = state.db.get().map_err(db_error)?;
            crate::db::machines::find_machine_by_id(&conn, machine_id)
                .map_err(db_error)?
                .is_some_and(|machine| machine.user_id == user_id)
        };
        if !owned
            && !state
                .manager
                .user_can_access_machine(user_id, machine_id)
                .await
        {
            return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
        }
    }
    if let Some(cwd) = cwd {
        if cwd.trim().is_empty()
            || cwd.chars().count() > MAX_CWD_CHARS
            || cwd.chars().any(char::is_control)
        {
            return Err(bad_request("Invalid folder"));
        }
    }
    Ok(())
}

async fn list_todos(
    State(state): State<AppState>,
    caller: TodoCaller,
) -> Result<Json<Vec<TodoInfo>>, ApiError> {
    let conn = state.db.get().map_err(db_error)?;
    crate::db::todos::list(&conn, &caller.user_id)
        .map(Json)
        .map_err(db_error)
}

async fn create_todo(
    State(state): State<AppState>,
    caller: TodoCaller,
    Json(req): Json<CreateTodoRequest>,
) -> Result<Json<TodoInfo>, ApiError> {
    let user_id = caller.user_id.as_str();
    if uuid::Uuid::parse_str(&req.id).is_err() {
        return Err(bad_request("Invalid to-do id"));
    }
    let title = normalize_title(&req.title).map_err(bad_request)?;
    let notes = normalize_notes(&req.notes).map_err(bad_request)?;
    // A machine adding a to-do means "on this machine" unless told otherwise.
    let machine_id = req
        .machine_id
        .filter(|id| !id.is_empty())
        .or_else(|| caller.machine_id.clone());
    let mut cwd = req.cwd.filter(|cwd| !cwd.is_empty());
    let adopted = match req.terminal_id.as_deref().filter(|id| !id.is_empty()) {
        Some(terminal_id) => {
            let machine = machine_id
                .as_deref()
                .ok_or_else(|| bad_request("Choose the machine that runs this agent"))?;
            let terminal = state
                .manager
                .terminal_for_user(user_id, machine, terminal_id)
                .await
                .ok_or_else(|| (StatusCode::NOT_FOUND, "Terminal not found".to_string()))?;
            let agent = terminal
                .agent
                .clone()
                .ok_or_else(|| bad_request("No Claude or Codex session runs in that terminal"))?;
            cwd = cwd.or_else(|| Some(terminal.cwd.clone()));
            Some((terminal.id, agent))
        }
        None => None,
    };
    validate_location(&state, user_id, machine_id.as_deref(), cwd.as_deref()).await?;

    let conn = state.db.get().map_err(db_error)?;
    if let Some(existing) = crate::db::todos::find(&conn, user_id, &req.id).map_err(db_error)? {
        // A retried create returns what the first one stored; a different
        // to-do reusing the id is a client bug.
        let same = existing.title == title
            && existing.notes == notes
            && existing.machine_id == machine_id
            && existing.cwd == cwd;
        return if same {
            Ok(Json(existing))
        } else {
            Err((
                StatusCode::CONFLICT,
                "This to-do id already belongs to another to-do".to_string(),
            ))
        };
    }
    if crate::db::todos::count(&conn, user_id).map_err(db_error)? >= MAX_TODOS_PER_USER {
        return Err(bad_request(
            "The to-do list is full; delete finished items first",
        ));
    }
    let todo = crate::db::todos::create(
        &conn,
        user_id,
        NewTodo {
            id: &req.id,
            title: &title,
            notes: &notes,
            machine_id: machine_id.as_deref(),
            cwd: cwd.as_deref(),
        },
    )
    .map_err(db_error)?;
    let todo = match adopted {
        Some((terminal_id, agent)) => crate::db::todos::link_agent(
            &conn,
            user_id,
            &todo.id,
            agent.kind,
            &terminal_id,
            agent.tasks.as_ref(),
        )
        .map_err(db_error)?
        .unwrap_or(todo),
        None => todo,
    };
    drop(conn);
    state.manager.publish_todo_upserted(user_id, todo.clone());
    Ok(Json(todo))
}

/// Hand a to-do to Claude or Codex: start the agent in a new terminal in the
/// to-do's folder with `prompt` as its first message, and link the two so
/// the to-do follows the agent's task list. Retrying returns the agent that
/// is already running instead of starting another.
async fn dispatch_todo(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, ApiError> {
    let user_id = auth_user.user_id.as_str();
    let todo = {
        let conn = state.db.get().map_err(db_error)?;
        crate::db::todos::find(&conn, user_id, &id).map_err(db_error)?
    }
    .ok_or_else(|| (StatusCode::NOT_FOUND, "To-do not found".to_string()))?;
    let (Some(machine_id), Some(cwd)) = (todo.machine_id.clone(), todo.cwd.clone()) else {
        return Err(bad_request(
            "Choose the machine and folder for this to-do first",
        ));
    };
    if !state
        .manager
        .user_can_access_machine(user_id, &machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }
    ensure_machine_row(&state, user_id, &machine_id).await?;
    let controller = state.manager.get_controller(user_id, &machine_id);
    if !control_action_allowed(controller.as_deref(), req.device_id.as_deref()) {
        return Err((StatusCode::FORBIDDEN, "Control required".to_string()));
    }
    if todo.agent == Some(req.agent) {
        if let Some(terminal_id) = todo.terminal_id.as_deref() {
            if let Some(terminal) = state
                .manager
                .terminal_for_user(user_id, &machine_id, terminal_id)
                .await
            {
                return Ok(Json(DispatchResponse { todo, terminal }));
            }
        }
    }
    let prompt = StartupPrompt::normalized(req.agent, &req.prompt)
        .map_err(|message| bad_request(message))?;
    require_relay_node(&state, &machine_id).await?;
    let terminal = start_agent_terminal(
        &state,
        user_id,
        &machine_id,
        &cwd,
        (req.cols, req.rows),
        prompt,
        None,
    )
    .await?;
    let todo = {
        let conn = state.db.get().map_err(db_error)?;
        crate::db::todos::link_agent(&conn, user_id, &id, req.agent, &terminal.id, None)
            .map_err(db_error)?
    }
    .ok_or_else(|| (StatusCode::NOT_FOUND, "To-do not found".to_string()))?;
    state.manager.publish_todo_upserted(user_id, todo.clone());
    Ok(Json(DispatchResponse { todo, terminal }))
}

async fn update_todo(
    State(state): State<AppState>,
    caller: TodoCaller,
    Path(id): Path<String>,
    Json(req): Json<UpdateTodoRequest>,
) -> Result<Json<TodoInfo>, ApiError> {
    let user_id = caller.user_id.as_str();
    let title = req
        .title
        .as_deref()
        .map(normalize_title)
        .transpose()
        .map_err(bad_request)?;
    let notes = req
        .notes
        .as_deref()
        .map(normalize_notes)
        .transpose()
        .map_err(bad_request)?;
    let machine_id = req.machine_id.map(|id| id.filter(|id| !id.is_empty()));
    let cwd = req.cwd.map(|cwd| cwd.filter(|cwd| !cwd.is_empty()));
    validate_location(
        &state,
        user_id,
        machine_id.as_ref().and_then(|id| id.as_deref()),
        cwd.as_ref().and_then(|cwd| cwd.as_deref()),
    )
    .await?;
    if req.position.is_some_and(|position| !position.is_finite()) {
        return Err(bad_request("Invalid position"));
    }

    let conn = state.db.get().map_err(db_error)?;
    let todo = crate::db::todos::update(
        &conn,
        user_id,
        &id,
        TodoPatch {
            title,
            notes,
            status: req.status,
            position: req.position,
            machine_id,
            cwd,
        },
    )
    .map_err(db_error)?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "To-do not found".to_string()))?;
    drop(conn);
    state.manager.publish_todo_upserted(user_id, todo.clone());
    Ok(Json(todo))
}

async fn delete_todo(
    State(state): State<AppState>,
    caller: TodoCaller,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.get().map_err(db_error)?;
    let deleted = crate::db::todos::delete(&conn, &caller.user_id, &id).map_err(db_error)?;
    drop(conn);
    // Deleting twice (a retry) succeeds without a second event.
    if deleted {
        state.manager.publish_todo_deleted(&caller.user_id, id);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, StatusCode},
    };
    use offdesk_protocol::BrowserEvent;
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::{
        attach_router::HubRouter, auth::sign_jwt, machine_manager::MachineManager, AppState,
    };

    const ID: &str = "55555555-5555-4555-8555-555555555555";

    fn test_state() -> AppState {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        for user in ["user-a", "user-b"] {
            crate::db::users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
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

    async fn call(
        state: &AppState,
        user: &str,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let token = sign_jwt(user, &state.jwt_secret);
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = super::router()
            .with_state(state.clone())
            .oneshot(request.body(body).unwrap())
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
    async fn to_dos_are_created_once_edited_and_pushed_to_the_owner_only() {
        let state = test_state();
        let mut events = state.manager.subscribe_events();

        let (status, todo) = call(
            &state,
            "user-a",
            Method::POST,
            "/api/todos",
            Some(json!({"id": ID, "title": "  Renew the certificate "})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(todo["title"], "Renew the certificate");
        assert_eq!(todo["status"], "open");
        let event = events.recv().await.unwrap();
        assert_eq!(event.target_user_id.as_deref(), Some("user-a"));
        assert!(matches!(event.event, BrowserEvent::TodoUpserted { todo } if todo.id == ID));

        // A retry returns the stored to-do; a different one with the id is refused.
        let (status, again) = call(
            &state,
            "user-a",
            Method::POST,
            "/api/todos",
            Some(json!({"id": ID, "title": "Renew the certificate"})),
        )
        .await;
        assert_eq!((status, again["id"].as_str()), (StatusCode::OK, Some(ID)));
        let (status, _) = call(
            &state,
            "user-a",
            Method::POST,
            "/api/todos",
            Some(json!({"id": ID, "title": "Something else"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, done) = call(
            &state,
            "user-a",
            Method::PATCH,
            &format!("/api/todos/{ID}"),
            Some(json!({"status": "done", "notes": "Expires on the 9th"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(done["status"], "done");
        assert!(done["completed_at"].is_i64());
        assert_eq!(done["notes"], "Expires on the 9th");

        // Another user sees nothing and cannot change it.
        let (_, others) = call(&state, "user-b", Method::GET, "/api/todos", None).await;
        assert_eq!(others, json!([]));
        let (status, _) = call(
            &state,
            "user-b",
            Method::PATCH,
            &format!("/api/todos/{ID}"),
            Some(json!({"title": "x"})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let snapshot = state.manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.todos.len(), 1);

        let (status, _) = call(
            &state,
            "user-a",
            Method::DELETE,
            &format!("/api/todos/{ID}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(
            &state,
            "user-a",
            Method::DELETE,
            &format!("/api/todos/{ID}"),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "a retried delete still succeeds"
        );
        let (_, mine) = call(&state, "user-a", Method::GET, "/api/todos", None).await;
        assert_eq!(mine, json!([]));
    }

    #[tokio::test]
    async fn invalid_to_dos_and_foreign_machines_are_rejected() {
        let state = test_state();
        for body in [
            json!({"id": "not-a-uuid", "title": "x"}),
            json!({"id": ID, "title": "   "}),
            json!({"id": ID, "title": "two\nlines"}),
            json!({"id": ID, "title": "x", "cwd": "   "}),
        ] {
            let (status, _) = call(
                &state,
                "user-a",
                Method::POST,
                "/api/todos",
                Some(body.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
        let (status, _) = call(
            &state,
            "user-a",
            Method::POST,
            "/api/todos",
            Some(json!({"id": ID, "title": "x", "machine_id": "someone-else"})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    async fn machine_call(
        state: &AppState,
        secret: &str,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-offdesk-machine", "machine-m")
            .header(header::AUTHORIZATION, format!("Machine {secret}"));
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = super::router()
            .with_state(state.clone())
            .oneshot(request.body(body).unwrap())
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
    async fn a_machine_adds_to_dos_for_its_owner_with_its_own_credentials() {
        let state = test_state();
        {
            let conn = state.db.get().unwrap();
            let hash = crate::auth::hash_password("machine-secret").unwrap();
            crate::db::machines::create_machine(&conn, "machine-m", "user-a", "Mac", &hash)
                .unwrap();
        }
        let (status, todo) = machine_call(
            &state,
            "machine-secret",
            Method::POST,
            "/api/todos",
            Some(json!({
                "id": ID, "title": "Ship the CLI", "cwd": "/Users/a/repo"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{todo}");
        assert_eq!(
            todo["machine_id"], "machine-m",
            "defaults to the calling machine"
        );
        assert_eq!(todo["cwd"], "/Users/a/repo");

        // It is the owner's list: the user sees it, and the machine can list and finish it.
        let (_, mine) = call(&state, "user-a", Method::GET, "/api/todos", None).await;
        assert_eq!(mine[0]["title"], "Ship the CLI");
        let (status, done) = machine_call(
            &state,
            "machine-secret",
            Method::PATCH,
            &format!("/api/todos/{ID}"),
            Some(json!({"status": "done"})),
        )
        .await;
        assert_eq!(
            (status, done["status"].as_str()),
            (StatusCode::OK, Some("done"))
        );

        // Wrong secrets and machine-started hand-offs are refused.
        let (status, _) = machine_call(&state, "wrong", Method::GET, "/api/todos", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = machine_call(
            &state,
            "machine-secret",
            Method::POST,
            &format!("/api/todos/{ID}/dispatch"),
            Some(json!({"agent": "codex", "prompt": "x"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    mod agents {
        use super::*;
        use offdesk_protocol::relay::{
            AgentTasks, RelayAgent, RelayTask, RelayTaskStatus, TerminalAgent,
        };
        use offdesk_protocol::{HubToMachine, MachineInfo, MachineToHub, TerminalInfo};
        use tokio::sync::mpsc::Receiver;

        fn tasks(done: usize, total: usize) -> AgentTasks {
            let list: Vec<_> = (0..total)
                .map(|i| RelayTask {
                    subject: format!("Task {i}"),
                    status: if i < done {
                        RelayTaskStatus::Completed
                    } else {
                        RelayTaskStatus::Pending
                    },
                })
                .collect();
            AgentTasks::summarize(&list).unwrap()
        }

        fn agent_message(done: usize, total: usize) -> MachineToHub {
            MachineToHub::TerminalAgent {
                terminal_id: "claude-term".into(),
                agent: Some(TerminalAgent {
                    kind: RelayAgent::Claude,
                    session_id: None,
                    usage_limit: None,
                    activity: None,
                    tasks: Some(tasks(done, total)),
                }),
            }
        }

        async fn connected() -> (AppState, Receiver<HubToMachine>) {
            let state = test_state();
            {
                let conn = state.db.get().unwrap();
                crate::db::machines::ensure_machine_for_user(
                    &conn,
                    "machine-a",
                    "user-a",
                    "Machine A",
                    Some("linux"),
                    Some("/root"),
                )
                .unwrap();
            }
            let info = MachineInfo {
                id: "machine-a".into(),
                name: "Machine A".into(),
                os: "linux".into(),
                home_dir: "/root".into(),
                production: false,
            };
            let (_, cmd_rx) = state
                .manager
                .register_machine_with_capabilities(
                    info,
                    Some("user-a".into()),
                    vec![offdesk_protocol::relay::CAPABILITY.into()],
                )
                .await;
            let terminal = TerminalInfo {
                id: "claude-term".into(),
                machine_id: "machine-a".into(),
                title: "Backfill".into(),
                cwd: "/root/repo".into(),
                title_source: Default::default(),
                workspace_group_id: None,
                cols: 80,
                rows: 24,
                attention: None,
                agent: None,
                relay_source: None,
                reachable: true,
            };
            state
                .manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::ExistingTerminals {
                        terminals: vec![terminal],
                    },
                )
                .await;
            state
                .manager
                .handle_machine_message("machine-a", agent_message(1, 2))
                .await;
            state
                .manager
                .request_control("user-a", "machine-a", "device-a");
            (state, cmd_rx)
        }

        #[tokio::test]
        async fn adopted_agents_keep_their_to_do_up_to_date() {
            let (state, _cmd_rx) = connected().await;
            let (status, todo) = call(&state, "user-a", Method::POST, "/api/todos", Some(json!({
                "id": ID, "title": "Backfill orders", "machine_id": "machine-a", "terminal_id": "claude-term"
            }))).await;
            assert_eq!(status, StatusCode::OK, "{todo}");
            assert_eq!(todo["agent"], "claude");
            assert_eq!(todo["terminal_id"], "claude-term");
            assert_eq!(
                todo["cwd"], "/root/repo",
                "the folder comes from the terminal"
            );
            assert_eq!(
                (
                    todo["progress"]["done"].as_u64(),
                    todo["progress"]["total"].as_u64()
                ),
                (Some(1), Some(2))
            );

            let mut events = state.manager.subscribe_events();
            state
                .manager
                .handle_machine_message("machine-a", agent_message(2, 2))
                .await;
            let mut saw_progress = false;
            while let Ok(Ok(envelope)) =
                tokio::time::timeout(std::time::Duration::from_secs(1), events.recv()).await
            {
                if let BrowserEvent::TodoUpserted { todo } = envelope.event {
                    let progress = todo.progress.unwrap();
                    assert_eq!((progress.done, progress.total), (2, 2));
                    saw_progress = true;
                    break;
                }
            }
            assert!(saw_progress, "the to-do follows the agent's task list");

            let (status, _) = call(&state, "user-a", Method::POST, "/api/todos", Some(json!({
                "id": "66666666-6666-4666-8666-666666666666", "title": "x", "machine_id": "machine-a", "terminal_id": "missing"
            }))).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
        }

        #[tokio::test]
        async fn handing_off_starts_the_agent_once_in_the_to_dos_folder() {
            let (state, mut cmd_rx) = connected().await;
            let (status, _) = call(
                &state,
                "user-a",
                Method::POST,
                "/api/todos",
                Some(json!({
                    "id": ID, "title": "Write release notes"
                })),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let dispatch =
                json!({"agent": "codex", "device_id": "device-a", "prompt": "Write release notes"});
            let uri = format!("/api/todos/{ID}/dispatch");
            let (status, message) =
                call(&state, "user-a", Method::POST, &uri, Some(dispatch.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{message}");

            call(
                &state,
                "user-a",
                Method::PATCH,
                &format!("/api/todos/{ID}"),
                Some(json!({"machine_id": "machine-a", "cwd": "/root/repo"})),
            )
            .await;
            let mut viewer = dispatch.clone();
            viewer["device_id"] = json!("device-b");
            assert_eq!(
                call(&state, "user-a", Method::POST, &uri, Some(viewer))
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );

            let request = tokio::spawn({
                let state = state.clone();
                let uri = uri.clone();
                let dispatch = dispatch.clone();
                async move { call(&state, "user-a", Method::POST, &uri, Some(dispatch)).await }
            });
            match cmd_rx.recv().await.unwrap() {
                HubToMachine::CreateTerminal {
                    request_id,
                    cwd,
                    startup_command,
                    startup_prompt,
                    ..
                } => {
                    assert_eq!(cwd, "/root/repo");
                    assert_eq!(startup_command, None);
                    let prompt = startup_prompt.unwrap();
                    assert_eq!(
                        (prompt.agent, prompt.text.as_str()),
                        (RelayAgent::Codex, "Write release notes")
                    );
                    state
                        .manager
                        .handle_machine_message(
                            "machine-a",
                            MachineToHub::TerminalCreated {
                                request_id,
                                terminal_id: "codex-term".into(),
                                title: "zsh".into(),
                                cwd,
                                cols: 120,
                                rows: 40,
                            },
                        )
                        .await;
                }
                other => panic!("unexpected machine command: {other:?}"),
            }
            let (status, body) = request.await.unwrap();
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["todo"]["agent"], "codex");
            assert_eq!(body["todo"]["terminal_id"], "codex-term");
            assert_eq!(body["terminal"]["id"], "codex-term");

            // A retry returns the running agent; no second terminal starts.
            let (status, again) = call(&state, "user-a", Method::POST, &uri, Some(dispatch)).await;
            assert_eq!(
                (status, again["terminal"]["id"].as_str()),
                (StatusCode::OK, Some("codex-term"))
            );
            assert!(cmd_rx.try_recv().is_err());
        }
    }
}
