use crate::{auth::AuthUser, AppState};
use axum::{extract::State, http::StatusCode, routing::put, Json, Router};
use serde::Deserialize;

#[derive(Deserialize)]
struct FocusRequest {
    terminal_id: String,
    machine_id: String,
}

async fn set_focus(
    user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<FocusRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !state
        .manager
        .user_can_access_terminal(&user.user_id, &body.machine_id, &body.terminal_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string()));
    }

    let db = state.db.clone();
    let user_id = user.user_id;
    let terminal_id = body.terminal_id;
    let machine_id = body.machine_id;
    tokio::task::spawn_blocking(move || {
        let conn = db.get().map_err(|error| {
            tracing::error!("Failed to get DB connection while setting user focus: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to save focus".to_string(),
            )
        })?;
        crate::db::user_focus::set_user_focus(&conn, &user_id, &terminal_id, &machine_id).map_err(
            |error| {
                tracing::error!("Failed to save user focus: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to save focus".to_string(),
                )
            },
        )
    })
    .await
    .map_err(|error| {
        tracing::error!("Focus DB task failed: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to save focus".to_string(),
        )
    })??;

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/focus", put(set_focus))
}
