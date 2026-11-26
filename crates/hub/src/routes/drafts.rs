use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::db;
use crate::db::drafts::{DraftPatch, DraftRow};
use crate::AppState;

#[derive(Deserialize)]
struct ListDraftsQuery {
    project: Option<String>,
    #[serde(default)]
    include_archived: bool,
}

#[derive(Deserialize)]
struct UpsertDraftRequest {
    title: String,
    content: String,
    #[serde(default)]
    project_group: Option<String>,
    #[serde(default)]
    source_terminal_id: Option<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    force_new: bool,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct UpdateDraftRequest {
    title: Option<String>,
    content: Option<String>,
    project_group: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

type ApiErr = (StatusCode, Json<serde_json::Value>);

fn db_err(e: impl std::fmt::Display) -> ApiErr {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": format!("DB error: {e}")})),
    )
}

fn parse_tags(tags: Option<&[String]>) -> Result<Option<Vec<String>>, ApiErr> {
    tags.map(db::draft_tags::normalize_tags)
        .transpose()
        .map_err(|msg| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": msg})),
            )
        })
}

async fn list_drafts(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<ListDraftsQuery>,
) -> Result<Json<Vec<DraftRow>>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let rows = db::drafts::list_drafts(
        &conn,
        &auth_user.user_id,
        query.project.as_deref(),
        query.include_archived,
    )
    .map_err(db_err)?;
    Ok(Json(rows))
}

async fn create_or_upsert_draft(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<UpsertDraftRequest>,
) -> Result<Json<DraftRow>, ApiErr> {
    if req.title.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "title must not be empty"})),
        ));
    }
    let tags = parse_tags(req.tags.as_deref())?;
    let conn = state.db.get().map_err(db_err)?;
    let row = db::drafts::upsert_draft_with_tags(
        &conn,
        &auth_user.user_id,
        &req.title,
        &req.content,
        req.project_group.as_deref().unwrap_or("~"),
        req.source_terminal_id.as_deref(),
        req.pinned,
        req.force_new,
        tags.as_deref(),
    )
    .map_err(db_err)?;
    Ok(Json(row))
}

async fn get_draft(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(draft_id): Path<String>,
) -> Result<Json<DraftRow>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let row = db::drafts::get_draft(&conn, &auth_user.user_id, &draft_id)
        .map_err(db_err)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "draft not found"})),
            )
        })?;
    Ok(Json(row))
}

async fn update_draft(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(draft_id): Path<String>,
    Json(req): Json<UpdateDraftRequest>,
) -> Result<Json<DraftRow>, ApiErr> {
    let tags = parse_tags(req.tags.as_deref())?;
    let conn = state.db.get().map_err(db_err)?;
    let row = db::drafts::update_draft(
        &conn,
        &auth_user.user_id,
        &draft_id,
        DraftPatch {
            title: req.title.as_deref(),
            content: req.content.as_deref(),
            project_group: req.project_group.as_deref(),
            pinned: req.pinned,
            archived: req.archived,
            tags: tags.as_deref(),
        },
    )
    .map_err(db_err)?
    .ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "draft not found"})),
        )
    })?;
    Ok(Json(row))
}

async fn delete_draft(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(draft_id): Path<String>,
) -> Result<StatusCode, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let deleted = db::drafts::delete_draft(&conn, &auth_user.user_id, &draft_id).map_err(db_err)?;
    if !deleted {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "draft not found"})),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/drafts", get(list_drafts).post(create_or_upsert_draft))
        .route(
            "/api/drafts/{draft_id}",
            get(get_draft).patch(update_draft).delete(delete_draft),
        )
}
