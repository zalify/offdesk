use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::auth::AuthUser;
use crate::db::draft_databases::{
    self as dd, ColumnInput, ConflictMode, Database, DatabasePatch, DbRowFull, DdError,
    GroupsRequest, QueryRequest, RowInput, View,
};
use crate::AppState;

type ApiErr = (StatusCode, Json<Value>);

fn to_api_err(e: DdError) -> ApiErr {
    match e {
        DdError::BadRequest(m) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))),
        DdError::NotFound(m) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": m}))),
        DdError::Conflict { message, id } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": message, "id": id})),
        ),
        DdError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": m})),
        ),
    }
}

/// Run rusqlite work on the blocking pool; batches can be large.
async fn blocking<T, F>(state: &AppState, f: F) -> Result<T, ApiErr>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, DdError> + Send + 'static,
{
    let pool = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool
            .get()
            .map_err(|e| DdError::Internal(format!("DB error: {e}")))?;
        f(&mut conn)
    })
    .await
    .map_err(|e| to_api_err(DdError::Internal(format!("task error: {e}"))))?
    .map_err(to_api_err)
}

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct ListQuery {
    project: Option<String>,
    space_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateDatabaseRequest {
    name: String,
    #[serde(default)]
    project_group: Option<String>,
    #[serde(default)]
    columns: Vec<ColumnInput>,
    #[serde(default)]
    if_not_exists: bool,
    #[serde(default)]
    space_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchDatabaseRequest {
    name: Option<String>,
    columns: Option<Vec<ColumnInput>>,
    views: Option<Vec<View>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    space_id: Option<Option<String>>,
}

#[derive(Deserialize)]
struct UpsertRowsRequest {
    rows: Vec<RowInput>,
    #[serde(default)]
    on_conflict: Option<String>,
}

#[derive(Deserialize)]
struct PatchRowRequest {
    title: Option<String>,
    properties: Option<Map<String, Value>>,
    content: Option<String>,
}

#[derive(Deserialize)]
struct DeleteRowsRequest {
    ids: Vec<String>,
}

async fn list_databases(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Database>>, ApiErr> {
    let out = blocking(&state, move |c| {
        dd::list_databases_in_space(c, &auth.user_id, q.project.as_deref(), q.space_id.as_deref())
    })
    .await?;
    Ok(Json(out))
}

async fn create_database(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateDatabaseRequest>,
) -> Result<Json<Database>, ApiErr> {
    let (db, _created) = blocking(&state, move |c| {
        dd::create_database_in_space(
            c,
            &auth.user_id,
            &req.name,
            req.project_group.as_deref(),
            &req.columns,
            req.if_not_exists,
            req.space_id.as_deref(),
        )
    })
    .await?;
    Ok(Json(db))
}

async fn get_database(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Database>, ApiErr> {
    Ok(Json(
        blocking(&state, move |c| dd::get_database(c, &auth.user_id, &id)).await?,
    ))
}

async fn patch_database(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<PatchDatabaseRequest>,
) -> Result<Json<Database>, ApiErr> {
    Ok(Json(
        blocking(&state, move |c| {
            dd::patch_database(
                c,
                &auth.user_id,
                &id,
                DatabasePatch {
                    name: req.name,
                    columns: req.columns,
                    views: req.views,
                    space_id: req.space_id,
                },
            )
        })
        .await?,
    ))
}

async fn delete_database(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiErr> {
    blocking(&state, move |c| dd::delete_database(c, &auth.user_id, &id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn query_rows(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<QueryRequest>,
) -> Result<Json<dd::QueryResult>, ApiErr> {
    Ok(Json(
        blocking(&state, move |c| dd::query_rows(c, &auth.user_id, &id, &req)).await?,
    ))
}

async fn group_rows(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<GroupsRequest>,
) -> Result<Json<Value>, ApiErr> {
    let groups = blocking(&state, move |c| dd::group_rows(c, &auth.user_id, &id, &req)).await?;
    Ok(Json(serde_json::json!({ "groups": groups })))
}

async fn upsert_rows(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpsertRowsRequest>,
) -> Result<Json<dd::UpsertResult>, ApiErr> {
    let mode = ConflictMode::parse(req.on_conflict.as_deref()).map_err(to_api_err)?;
    Ok(Json(
        blocking(&state, move |c| dd::upsert_rows(c, &auth.user_id, &id, req.rows, mode)).await?,
    ))
}

async fn get_row(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, row_id)): Path<(String, String)>,
) -> Result<Json<DbRowFull>, ApiErr> {
    Ok(Json(
        blocking(&state, move |c| dd::get_row(c, &auth.user_id, &id, &row_id)).await?,
    ))
}

async fn patch_row(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, row_id)): Path<(String, String)>,
    Json(req): Json<PatchRowRequest>,
) -> Result<Json<DbRowFull>, ApiErr> {
    Ok(Json(
        blocking(&state, move |c| {
            dd::patch_row(
                c,
                &auth.user_id,
                &id,
                &row_id,
                req.title.as_deref(),
                req.properties.as_ref(),
                req.content.as_deref(),
            )
        })
        .await?,
    ))
}

async fn delete_row(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((id, row_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiErr> {
    blocking(&state, move |c| dd::delete_row(c, &auth.user_id, &id, &row_id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_rows(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<DeleteRowsRequest>,
) -> Result<Json<Value>, ApiErr> {
    let n = blocking(&state, move |c| dd::delete_rows(c, &auth.user_id, &id, &req.ids)).await?;
    Ok(Json(serde_json::json!({ "deleted": n })))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/draft-databases", get(list_databases).post(create_database))
        .route(
            "/api/draft-databases/{id}",
            get(get_database).patch(patch_database).delete(delete_database),
        )
        .route("/api/draft-databases/{id}/rows/query", post(query_rows))
        .route("/api/draft-databases/{id}/rows/groups", post(group_rows))
        .route("/api/draft-databases/{id}/rows/delete", post(delete_rows))
        .route(
            "/api/draft-databases/{id}/rows",
            post(upsert_rows).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/draft-databases/{id}/rows/{row_id}",
            get(get_row).patch(patch_row).delete(delete_row),
        )
}
