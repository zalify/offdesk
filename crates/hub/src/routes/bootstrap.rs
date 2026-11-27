use axum::{
    extract::{Query, State},
    response::Json,
    routing::get,
    Router,
};
use offdesk_protocol::BrowserStateSnapshot;
use serde::Deserialize;

use crate::{auth::AuthUser, AppState};

#[derive(Deserialize, Default)]
struct BootstrapQuery {
    device_id: Option<String>,
}

async fn get_bootstrap(
    auth_user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<BootstrapQuery>,
) -> Json<BrowserStateSnapshot> {
    if let Some(device_id) = query.device_id.as_deref() {
        state
            .manager
            .restore_released_leases_for_device(&auth_user.user_id, device_id);
    }
    Json(state.manager.snapshot_for_user(&auth_user.user_id).await)
}

/// First-run diagnostics must distinguish a registered machine from a live
/// node. The regular snapshot intentionally also includes offline machines.
async fn get_setup_status(auth_user: AuthUser, State(state): State<AppState>) -> Json<serde_json::Value> {
    let machines = state.manager.list_machines_for_user(&auth_user.user_id).await;
    Json(serde_json::json!({"online_machine_ids": machines.iter().map(|m| &m.id).collect::<Vec<_>>() }))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/bootstrap", get(get_bootstrap))
        .route("/api/setup/status", get(get_setup_status))
}
