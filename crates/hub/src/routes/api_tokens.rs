use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get},
    Router,
};
use serde::{Deserialize, Serialize};

use crate::auth::{self, AuthUser};
use crate::db;
use crate::AppState;

#[derive(Deserialize)]
struct CreateApiTokenRequest {
    name: String,
    /// What it may do; omitted: full access, as tokens always had (the CLI's login).
    #[serde(default)]
    access: Option<offdesk_protocol::TokenAccess>,
}

#[derive(Serialize)]
struct ApiTokenResponse {
    id: String,
    name: String,
    created_at: i64,
    last_used_at: Option<i64>,
    expires_at: Option<i64>,
    /// None: full access.
    access: Option<offdesk_protocol::TokenAccess>,
}

#[derive(Serialize)]
struct CreateApiTokenResponse {
    id: String,
    name: String,
    token: String,
    created_at: i64,
    access: Option<offdesk_protocol::TokenAccess>,
}

async fn list_tokens(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<ApiTokenResponse>>, (StatusCode, Json<serde_json::Value>)> {
    let conn = state.db.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;

    let tokens = db::tokens::list_api_tokens_by_user(&conn, &auth_user.user_id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;

    let response: Vec<ApiTokenResponse> = tokens
        .into_iter()
        .map(|t| ApiTokenResponse {
            id: t.id,
            name: t.name,
            created_at: t.created_at,
            last_used_at: t.last_used_at,
            expires_at: t.expires_at,
            access: t.access,
        })
        .collect();

    Ok(Json(response))
}

async fn create_token(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateApiTokenRequest>,
) -> Result<Json<CreateApiTokenResponse>, (StatusCode, Json<serde_json::Value>)> {
    // `full` among the scopes is full access, stored as none
    let access = req.access.filter(|access| !access.is_full());
    if let Some(access) = &access {
        access.validate().map_err(|reason| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": reason })),
            )
        })?;
    }
    // Generate odk_ + 2 UUIDs
    let raw_token = format!(
        "{}{}{}",
        auth::API_TOKEN_PREFIX,
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple()
    );
    let token_hash = auth::hash_token(&raw_token);
    let id = uuid::Uuid::new_v4().to_string();

    let conn = state.db.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;

    db::tokens::create_scoped_api_token(
        &conn,
        &id,
        &auth_user.user_id,
        &req.name,
        &token_hash,
        None,
        access.as_ref(),
    )
    .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("DB error: {e}")})),
            )
        })?;

    let created_at = db::now_ms();

    Ok(Json(CreateApiTokenResponse {
        id,
        name: req.name,
        token: raw_token,
        created_at,
        access,
    }))
}

#[derive(Deserialize)]
struct AuditQuery {
    token_id: Option<String>,
}

/// What API tokens did (answers, approvals, starts) or were refused, newest first.
async fn token_audit(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<db::tokens::TokenAuditEntry>>, (StatusCode, Json<serde_json::Value>)> {
    let internal = |e: rusqlite::Error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    };
    let conn = state.db.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;
    db::tokens::list_audit(&conn, &auth_user.user_id, query.token_id.as_deref(), 500)
        .map(Json)
        .map_err(internal)
}

async fn delete_token(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(token_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let conn = state.db.get().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;

    db::tokens::delete_api_token(&conn, &token_id, &auth_user.user_id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("DB error: {e}")})),
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/api-tokens", get(list_tokens).post(create_token))
        .route("/api/auth/api-tokens/audit", get(token_audit))
        .route("/api/auth/api-tokens/{id}", delete(delete_token))
}
