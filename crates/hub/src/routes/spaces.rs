use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use offdesk_protocol::{SpaceInfo, WorkspaceGroupInfo};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::db;
use crate::db::spaces::SpacePatch;
use crate::db::types::SpaceRow;
use crate::AppState;

type ApiErr = (StatusCode, Json<serde_json::Value>);

fn db_err(e: impl std::fmt::Display) -> ApiErr {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": format!("DB error: {e}")})),
    )
}

fn bad_req(msg: impl Into<String>) -> ApiErr {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": msg.into()})),
    )
}

fn not_found() -> ApiErr {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "space not found"})),
    )
}

pub(crate) fn space_info(row: SpaceRow) -> SpaceInfo {
    SpaceInfo {
        id: row.id,
        name: row.name,
        icon: row.icon,
        color: row.color,
        default_cwd: row.default_cwd,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct CreateSpaceRequest {
    name: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    default_cwd: Option<String>,
    #[serde(default)]
    sort_order: Option<i64>,
}

#[derive(Deserialize, Default)]
struct UpdateSpaceRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    default_cwd: Option<Option<String>>,
    #[serde(default)]
    sort_order: Option<i64>,
}

async fn list_spaces(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<SpaceInfo>>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let rows = db::spaces::list_spaces(&conn, &auth_user.user_id).map_err(db_err)?;
    Ok(Json(rows.into_iter().map(space_info).collect()))
}

async fn create_space(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateSpaceRequest>,
) -> Result<Json<SpaceInfo>, ApiErr> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(bad_req("name must not be empty"));
    }
    let conn = state.db.get().map_err(db_err)?;
    let sort_order = match req.sort_order {
        Some(order) => order,
        None => db::spaces::next_sort_order(&conn, &auth_user.user_id).map_err(db_err)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let row = db::spaces::create_space(
        &conn,
        &id,
        &auth_user.user_id,
        name,
        req.icon.as_deref(),
        req.color.as_deref(),
        req.default_cwd.as_deref(),
        sort_order,
    )
    .map_err(db_err)?;
    let info = space_info(row);
    state
        .manager
        .publish_space_created(&auth_user.user_id, info.clone());
    Ok(Json(info))
}

async fn update_space(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(space_id): Path<String>,
    Json(req): Json<UpdateSpaceRequest>,
) -> Result<Json<SpaceInfo>, ApiErr> {
    if let Some(ref name) = req.name {
        if name.trim().is_empty() {
            return Err(bad_req("name must not be empty"));
        }
    }
    let conn = state.db.get().map_err(db_err)?;
    let row = db::spaces::update_space(
        &conn,
        &auth_user.user_id,
        &space_id,
        SpacePatch {
            name: req.name.as_deref(),
            icon: req.icon.as_ref().map(|v| v.as_deref()),
            color: req.color.as_ref().map(|v| v.as_deref()),
            default_cwd: req.default_cwd.as_ref().map(|v| v.as_deref()),
            sort_order: req.sort_order,
        },
    )
    .map_err(db_err)?
    .ok_or_else(not_found)?;
    let info = space_info(row);
    state
        .manager
        .publish_space_updated(&auth_user.user_id, info.clone());
    Ok(Json(info))
}

async fn delete_space(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(space_id): Path<String>,
) -> Result<StatusCode, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let affected_groups =
        db::workspace_groups::find_workspace_groups_by_space(&conn, &auth_user.user_id, &space_id)
            .map_err(db_err)?;
    let deleted = db::spaces::delete_space(&conn, &auth_user.user_id, &space_id).map_err(db_err)?;
    if !deleted {
        return Err(not_found());
    }
    for group in affected_groups {
        state.manager.publish_workspace_group_updated(
            &auth_user.user_id,
            WorkspaceGroupInfo {
                id: group.id,
                machine_id: group.machine_id,
                name: group.name,
                sort_order: group.sort_order,
                space_id: None,
            },
        );
    }
    state
        .manager
        .publish_space_deleted(&auth_user.user_id, &space_id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/spaces", get(list_spaces).post(create_space))
        .route(
            "/api/spaces/{space_id}",
            axum::routing::patch(update_space).delete(delete_space),
        )
}
