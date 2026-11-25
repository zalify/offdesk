use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, patch, post},
    Router,
};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::db::vault::{
    self, derive_vault_key, NewVaultSecret, UpdateVaultSecret, VaultSecretSummary,
};
use crate::AppState;

#[derive(Deserialize)]
struct ListVaultQuery {
    project: Option<String>,
    category: Option<String>,
}

#[derive(Deserialize)]
struct CreateVaultRequest {
    name: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    project_group: String,
    #[serde(default)]
    env_var: Option<String>,
    #[serde(default)]
    username: Option<String>,
    secret_value: String,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Deserialize)]
struct UpdateVaultRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    project_group: Option<String>,
    #[serde(default)]
    env_var: Option<Option<String>>,
    #[serde(default)]
    username: Option<Option<String>>,
    #[serde(default)]
    secret_value: Option<String>,
    #[serde(default)]
    notes: Option<Option<String>>,
}

type ApiErr = (StatusCode, Json<serde_json::Value>);

fn err_resp(status: StatusCode, msg: impl Into<String>) -> ApiErr {
    (status, Json(serde_json::json!({ "error": msg.into() })))
}

async fn list_vault(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<ListVaultQuery>,
) -> Result<Json<Vec<VaultSecretSummary>>, ApiErr> {
    let conn = state
        .db
        .get()
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    let rows = vault::list_secrets(
        &conn,
        &auth_user.user_id,
        query.project.as_deref(),
        query.category.as_deref(),
    )
    .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    Ok(Json(rows))
}

async fn create_vault(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateVaultRequest>,
) -> Result<Json<VaultSecretSummary>, ApiErr> {
    if req.name.trim().is_empty() || req.secret_value.is_empty() {
        return Err(err_resp(
            StatusCode::BAD_REQUEST,
            "name and secret_value are required",
        ));
    }
    let conn = state
        .db
        .get()
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    let key = derive_vault_key(&state.jwt_secret);
    let created = vault::create_secret(
        &conn,
        &key,
        NewVaultSecret {
            user_id: &auth_user.user_id,
            name: &req.name,
            category: &req.category,
            project_group: &req.project_group,
            env_var: req.env_var.as_deref(),
            username: req.username.as_deref(),
            secret_value: &req.secret_value,
            notes: req.notes.as_deref(),
        },
    )
    .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(created))
}

async fn update_vault(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateVaultRequest>,
) -> Result<Json<VaultSecretSummary>, ApiErr> {
    let conn = state
        .db
        .get()
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    let key = derive_vault_key(&state.jwt_secret);
    let updated = vault::update_secret(
        &conn,
        &key,
        &auth_user.user_id,
        &id,
        UpdateVaultSecret {
            name: req.name.as_deref(),
            category: req.category.as_deref(),
            project_group: req.project_group.as_deref(),
            env_var: req.env_var.as_ref().map(|o| o.as_deref()),
            username: req.username.as_ref().map(|o| o.as_deref()),
            secret_value: req.secret_value.as_deref(),
            notes: req.notes.as_ref().map(|o| o.as_deref()),
        },
    )
    .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, e))?
    .ok_or_else(|| err_resp(StatusCode::NOT_FOUND, "Secret not found"))?;
    Ok(Json(updated))
}

async fn reveal_vault(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let conn = state
        .db
        .get()
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    let key = derive_vault_key(&state.jwt_secret);
    let value = vault::reveal_secret(&conn, &key, &auth_user.user_id, &id)
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| err_resp(StatusCode::NOT_FOUND, "Secret not found"))?;
    Ok(Json(serde_json::json!({ "value": value })))
}

async fn delete_vault(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiErr> {
    let conn = state
        .db
        .get()
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    let deleted = vault::delete_secret(&conn, &auth_user.user_id, &id)
        .map_err(|e| err_resp(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")))?;
    if !deleted {
        return Err(err_resp(StatusCode::NOT_FOUND, "Secret not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/vault", get(list_vault).post(create_vault))
        .route("/api/vault/{id}", patch(update_vault).delete(delete_vault))
        .route("/api/vault/{id}/reveal", post(reveal_vault))
}
