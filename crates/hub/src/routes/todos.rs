//! Personal to-dos. Any signed-in device of the user can read and edit them;
//! unlike terminal actions they need no machine control. Every change is
//! pushed to the user's other devices as a browser event.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, patch},
    Router,
};
use offdesk_protocol::todos::{
    normalize_notes, normalize_title, TodoInfo, TodoStatus, MAX_TODOS_PER_USER,
};
use serde::{Deserialize, Deserializer};

use crate::auth::AuthUser;
use crate::db::todos::{NewTodo, TodoPatch};
use crate::AppState;

type ApiError = (StatusCode, String);

const MAX_CWD_CHARS: usize = 4096;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/todos", get(list_todos).post(create_todo))
        .route("/api/todos/{id}", patch(update_todo).delete(delete_todo))
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
        if !state
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
    auth_user: AuthUser,
) -> Result<Json<Vec<TodoInfo>>, ApiError> {
    let conn = state.db.get().map_err(db_error)?;
    crate::db::todos::list(&conn, &auth_user.user_id)
        .map(Json)
        .map_err(db_error)
}

async fn create_todo(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateTodoRequest>,
) -> Result<Json<TodoInfo>, ApiError> {
    let user_id = auth_user.user_id.as_str();
    if uuid::Uuid::parse_str(&req.id).is_err() {
        return Err(bad_request("Invalid to-do id"));
    }
    let title = normalize_title(&req.title).map_err(bad_request)?;
    let notes = normalize_notes(&req.notes).map_err(bad_request)?;
    let machine_id = req.machine_id.filter(|id| !id.is_empty());
    let cwd = req.cwd.filter(|cwd| !cwd.is_empty());
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
    drop(conn);
    state.manager.publish_todo_upserted(user_id, todo.clone());
    Ok(Json(todo))
}

async fn update_todo(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateTodoRequest>,
) -> Result<Json<TodoInfo>, ApiError> {
    let user_id = auth_user.user_id.as_str();
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
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.get().map_err(db_error)?;
    let deleted = crate::db::todos::delete(&conn, &auth_user.user_id, &id).map_err(db_error)?;
    drop(conn);
    // Deleting twice (a retry) succeeds without a second event.
    if deleted {
        state.manager.publish_todo_deleted(&auth_user.user_id, id);
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
}
