use crate::{auth::AuthUser, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use offdesk_protocol::session_history::{ConversationHistory, CAPABILITY};

async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(machine_id): Path<String>,
) -> Result<Json<ConversationHistory>, (StatusCode, String)> {
    if !state
        .manager
        .user_can_access_machine(&auth.user_id, &machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".into()));
    }
    if !state
        .manager
        .machine_supports(&machine_id, CAPABILITY)
        .await
    {
        return Err((
            StatusCode::CONFLICT,
            "Connect this machine and update Offdesk Node to load agent history".into(),
        ));
    }
    state
        .manager
        .conversation_history(&machine_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))
}
pub fn router() -> Router<AppState> {
    Router::new().route("/api/machines/{machine_id}/conversation-history", get(list))
}
