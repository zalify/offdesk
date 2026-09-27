use crate::{
    auth::AuthUser,
    db::session_handoffs::{self as store, HandoffContent, SessionHandoff},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Deserialize;

type ApiError = (StatusCode, String);
fn db_error(error: impl std::fmt::Display) -> ApiError {
    tracing::error!("handoff database error: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save or load handoff".into(),
    )
}

#[derive(Deserialize)]
struct ListQuery {
    terminal_id: String,
}
#[derive(Deserialize)]
struct SaveRequest {
    id: String,
    device_id: String,
    #[serde(flatten)]
    content: HandoffContent,
}
#[derive(Deserialize)]
struct ConfirmRequest {
    device_id: String,
}

async fn access(
    state: &AppState,
    user: &str,
    machine: &str,
    device: Option<&str>,
) -> Result<(), ApiError> {
    if !state.manager.user_can_access_machine(user, machine).await {
        if device.is_none() {
            let conn = state.db.get().map_err(db_error)?;
            if crate::db::machines::find_machine_by_id(&conn, machine)
                .map_err(db_error)?
                .is_some_and(|row| row.user_id == user)
            {
                return Ok(());
            }
        }
        return Err((StatusCode::NOT_FOUND, "Machine not found".into()));
    }
    if let Some(device) = device {
        if device.is_empty()
            || state.manager.get_controller(user, machine).as_deref() != Some(device)
        {
            return Err((StatusCode::FORBIDDEN, "Control required".into()));
        }
    }
    Ok(())
}

fn validate(request: &SaveRequest) -> Result<(), ApiError> {
    let c = &request.content;
    let agents = matches!(
        (c.source_agent.as_str(), c.target_agent.as_str()),
        ("claude", "codex") | ("codex", "claude")
    );
    let text_size = c.goal.len() + c.intent.len() + c.summary.len() + c.artifacts.len();
    if uuid::Uuid::parse_str(&request.id).is_err()
        || !agents
        || c.goal.trim().is_empty()
        || c.intent.trim().is_empty()
        || c.summary.trim().is_empty()
        || text_size > 32_000
        || c.source_terminal_id == c.target_terminal_id
        || c.cwd.is_empty()
        || c.cwd.len() > 4096
        || c.source_terminal_id.len() > 128
        || c.target_terminal_id.len() > 128
    {
        return Err((StatusCode::BAD_REQUEST, "Choose two different agents and terminals, and provide a goal, next step and summary (maximum 32 KB)".into()));
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(machine): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<SessionHandoff>>, ApiError> {
    access(&state, &user.user_id, &machine, None).await?;
    let conn = state.db.get().map_err(db_error)?;
    Ok(Json(
        store::list(&conn, &user.user_id, &machine, &query.terminal_id).map_err(db_error)?,
    ))
}

async fn save(
    State(state): State<AppState>,
    user: AuthUser,
    Path(machine): Path<String>,
    Json(request): Json<SaveRequest>,
) -> Result<Json<SessionHandoff>, ApiError> {
    access(&state, &user.user_id, &machine, Some(&request.device_id)).await?;
    validate(&request)?;
    // Resolve retries even if a terminal was closed after the successful save.
    let existing = {
        let conn = state.db.get().map_err(db_error)?;
        store::find(&conn, &user.user_id, &machine, &request.id).map_err(db_error)?
    };
    if let Some(existing) = existing {
        return same_content(existing, &request.content);
    }
    let terminals = state
        .manager
        .list_terminals_for_user(&user.user_id, Some(&machine))
        .await;
    for id in [
        &request.content.source_terminal_id,
        &request.content.target_terminal_id,
    ] {
        let terminal = terminals
            .iter()
            .find(|terminal| &terminal.id == id)
            .ok_or((
                StatusCode::NOT_FOUND,
                "Source or target terminal is no longer available".into(),
            ))?;
        if !terminal.reachable || terminal.cwd != request.content.cwd {
            return Err((
                StatusCode::CONFLICT,
                "Both terminals must be reachable and in the same working directory".into(),
            ));
        }
    }
    let conn = state.db.get().map_err(db_error)?;
    let record = store::save(
        &conn,
        &user.user_id,
        &machine,
        &request.id,
        &request.content,
    )
    .map_err(db_error)?;
    same_content(record, &request.content)
}

fn same_content(
    record: SessionHandoff,
    content: &HandoffContent,
) -> Result<Json<SessionHandoff>, ApiError> {
    if &record.content != content {
        return Err((
            StatusCode::CONFLICT,
            "This handoff ID already belongs to different instructions".into(),
        ));
    }
    Ok(Json(record))
}

async fn confirm(
    State(state): State<AppState>,
    user: AuthUser,
    Path((machine, id)): Path<(String, String)>,
    Json(request): Json<ConfirmRequest>,
) -> Result<Json<SessionHandoff>, ApiError> {
    access(&state, &user.user_id, &machine, Some(&request.device_id)).await?;
    let conn = state.db.get().map_err(db_error)?;
    store::confirm(&conn, &user.user_id, &machine, &id)
        .map_err(db_error)?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Handoff not found".into()))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/machines/{machine_id}/session-handoffs",
            get(list).post(save),
        )
        .route(
            "/api/machines/{machine_id}/session-handoffs/{id}/confirm",
            post(confirm),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> SaveRequest {
        SaveRequest {
            id: uuid::Uuid::new_v4().to_string(),
            device_id: "device".into(),
            content: HandoffContent {
                source_terminal_id: "a".into(),
                target_terminal_id: "b".into(),
                source_agent: "claude".into(),
                target_agent: "codex".into(),
                cwd: "/repo".into(),
                goal: "Goal".into(),
                intent: "Next".into(),
                summary: "Done".into(),
                artifacts: "".into(),
            },
        }
    }
    #[test]
    fn handoff_validation_rejects_empty_oversized_or_ambiguous_input() {
        let mut r = request();
        assert!(validate(&r).is_ok());
        r.content.summary.clear();
        assert!(validate(&r).is_err());
        r = request();
        r.content.goal = "x".repeat(32_001);
        assert!(validate(&r).is_err());
        r = request();
        r.content.target_agent = "shell".into();
        assert!(validate(&r).is_err());
        r = request();
        r.content.target_terminal_id = "a".into();
        assert!(validate(&r).is_err());
    }
}
