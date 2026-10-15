use crate::{auth, auth::AuthUser, AppState};
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize)]
struct ModeResponse {
    controller_device_id: Option<String>,
}

#[derive(Deserialize)]
struct ModeRequest {
    machine_id: String,
    device_id: String,
}

async fn get_mode(
    user: AuthUser,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<Json<ModeResponse>, (StatusCode, String)> {
    let machine_id = params.get("machine_id").ok_or((
        StatusCode::BAD_REQUEST,
        "machine_id is required".to_string(),
    ))?;

    if !state
        .manager
        .user_can_access_machine(&user.user_id, machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }

    Ok(Json(ModeResponse {
        controller_device_id: state.manager.get_controller(&user.user_id, machine_id),
    }))
}

async fn request_control(
    user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ModeRequest>,
) -> Result<Json<ModeResponse>, (StatusCode, String)> {
    if !state
        .manager
        .user_can_access_machine(&user.user_id, &body.machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }
    if !user.may_reach_machine(&state.db, &body.machine_id) {
        return Err((StatusCode::FORBIDDEN, "This token can't reach that machine".to_string()));
    }

    state
        .manager
        .request_control(&user.user_id, &body.machine_id, &body.device_id);
    Ok(Json(ModeResponse {
        controller_device_id: Some(body.device_id),
    }))
}

async fn release_control(
    user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ModeRequest>,
) -> Result<Json<ModeResponse>, (StatusCode, String)> {
    if !state
        .manager
        .user_can_access_machine(&user.user_id, &body.machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }
    if !user.may_reach_machine(&state.db, &body.machine_id) {
        return Err((StatusCode::FORBIDDEN, "This token can't reach that machine".to_string()));
    }

    state
        .manager
        .release_control(&user.user_id, &body.machine_id, &body.device_id);
    Ok(Json(ModeResponse {
        controller_device_id: state
            .manager
            .get_controller(&user.user_id, &body.machine_id),
    }))
}

async fn release_control_beacon(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let token = params
        .get("token")
        .ok_or((StatusCode::BAD_REQUEST, "token is required".to_string()))?;

    let user_id = auth::verify_bearer_token(token, &state.db, &state.jwt_secret)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid token".to_string()))?;

    let body: ModeRequest = serde_json::from_slice(&body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "request body is invalid".to_string(),
        )
    })?;

    if !state
        .manager
        .user_can_access_machine(&user_id, &body.machine_id)
        .await
    {
        return Err((StatusCode::NOT_FOUND, "Machine not found".to_string()));
    }

    state
        .manager
        .release_control(&user_id, &body.machine_id, &body.device_id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mode", get(get_mode))
        .route("/api/mode/control", post(request_control))
        .route("/api/mode/release", post(release_control))
        .route("/api/mode/release-beacon", post(release_control_beacon))
}
