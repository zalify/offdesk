use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::db;
use crate::db::messages::{AgentMessageRow, ListMessagesFilter, NewAgentMessage};
use crate::AppState;

#[derive(Deserialize)]
struct ListMessagesQuery {
    to: Option<String>,
    to_label: Option<String>,
    channel: Option<String>,
    thread: Option<String>,
    #[serde(default)]
    unread: bool,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    50
}

#[derive(Deserialize)]
struct PostMessageRequest {
    body: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    from_terminal_id: Option<String>,
    #[serde(default)]
    from_label: Option<String>,
    #[serde(default)]
    to_terminal_id: Option<String>,
    #[serde(default)]
    to_label: Option<String>,
    #[serde(default)]
    draft_id: Option<String>,
}

#[derive(Deserialize)]
struct MarkReadRequest {
    ids: Vec<String>,
}

type ApiErr = (StatusCode, Json<serde_json::Value>);

fn db_err(e: impl std::fmt::Display) -> ApiErr {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": format!("DB error: {e}")})),
    )
}

async fn list_messages(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Vec<AgentMessageRow>>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let rows = db::messages::list_messages(
        &conn,
        &auth_user.user_id,
        ListMessagesFilter {
            to_terminal_id: query.to.as_deref(),
            to_label: query.to_label.as_deref(),
            channel: query.channel.as_deref(),
            thread_id: query.thread.as_deref(),
            unread_only: query.unread,
            limit: query.limit,
        },
    )
    .map_err(db_err)?;
    Ok(Json(rows))
}

async fn post_message(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<PostMessageRequest>,
) -> Result<Json<AgentMessageRow>, ApiErr> {
    if req.body.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "message body must not be empty"})),
        ));
    }
    let conn = state.db.get().map_err(db_err)?;
    let row = db::messages::post_message(
        &conn,
        NewAgentMessage {
            user_id: &auth_user.user_id,
            thread_id: req.thread_id.as_deref(),
            channel: req.channel.as_deref(),
            from_terminal_id: req.from_terminal_id.as_deref(),
            from_label: req.from_label.as_deref().unwrap_or("agent"),
            to_terminal_id: req.to_terminal_id.as_deref(),
            to_label: req.to_label.as_deref(),
            body: &req.body,
            draft_id: req.draft_id.as_deref(),
        },
    )
    .map_err(db_err)?;
    Ok(Json(row))
}

async fn mark_read(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<MarkReadRequest>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let updated = db::messages::mark_messages_read(&conn, &auth_user.user_id, &req.ids)
        .map_err(db_err)?;
    Ok(Json(serde_json::json!({ "marked": updated })))
}

#[derive(Deserialize)]
struct SendChannelMessageRequest {
    body: String,
    #[serde(default)]
    from_label: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
}

fn normalize_channel(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('#') {
        trimmed.to_string()
    } else {
        format!("#{trimmed}")
    }
}

async fn list_channels(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<String>>, ApiErr> {
    let conn = state.db.get().map_err(db_err)?;
    let mut channels: Vec<String> = Vec::new();
    let mut push_unique = |ch: String| {
        if !ch.is_empty() && !channels.iter().any(|c| c.eq_ignore_ascii_case(&ch)) {
            channels.push(ch);
        }
    };

    if let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT channel FROM agent_messages
         WHERE user_id = ?1 AND channel IS NOT NULL AND channel != ''
         ORDER BY channel ASC",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![&auth_user.user_id], |r| {
            r.get::<_, String>(0)
        }) {
            for ch in rows.flatten() {
                push_unique(normalize_channel(&ch));
            }
        }
    }

    if let Ok(sessions) = crate::db::agent_sessions::find_sessions_by_user(&conn, &auth_user.user_id)
    {
        for s in sessions {
            if let Some(proj) = s
                .cwd
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|seg| !seg.is_empty())
            {
                push_unique(format!("#{proj}"));
            }
        }
    }

    if channels.is_empty() {
        channels.push("#general".to_string());
    }
    Ok(Json(channels))
}

async fn send_channel_message(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(channel): Path<String>,
    Json(req): Json<SendChannelMessageRequest>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    if req.body.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "message body must not be empty"})),
        ));
    }
    let channel = normalize_channel(&channel);
    let from_label = req.from_label.as_deref().unwrap_or("you");
    let row = {
        let conn = state.db.get().map_err(db_err)?;
        db::messages::post_message(
            &conn,
            NewAgentMessage {
                user_id: &auth_user.user_id,
                thread_id: req.thread_id.as_deref(),
                channel: Some(&channel),
                from_terminal_id: None,
                from_label,
                to_terminal_id: None,
                to_label: None,
                body: &req.body,
                draft_id: None,
            },
        )
        .map_err(db_err)?
    };

    let routed_bots = state
        .manager
        .route_channel_message(
            &auth_user.user_id,
            &channel,
            &row.thread_id,
            from_label,
            &req.body,
            0,
        )
        .await;

    Ok(Json(serde_json::json!({
        "message": row,
        "routed_bots": routed_bots,
    })))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/messages", get(list_messages).post(post_message))
        .route("/api/messages/read", post(mark_read))
        .route("/api/chat/channels", get(list_channels))
        .route("/api/chat/channels/{channel}/send", post(send_channel_message))
}
