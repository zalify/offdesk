//! Integrations over HTTP (docs/plans/2026-10-14-agent-runs-external-access.md, B2):
//! webhooks that get agent run events. People and full tokens only; a scoped token
//! can't reach these routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use offdesk_protocol::{ContentLevel, TokenAccess, TokenScope};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::db::integrations::{self, Delivery, Integration};
use crate::AppState;

#[derive(Deserialize)]
struct CreateIntegration {
    name: String,
    url: String,
    /// The event types it gets (`run.request`, `run.ended`, …); none: all.
    #[serde(default)]
    events: Vec<String>,
    /// Only these machines; none: every machine except production ones.
    #[serde(default)]
    machines: Option<Vec<String>>,
    #[serde(default)]
    include_production: bool,
    /// What it sees of a run; default `metadata` (no request text).
    #[serde(default)]
    content: ContentLevel,
}

#[derive(Serialize)]
struct CreatedIntegration {
    integration: Integration,
    /// The signing secret, shown this once.
    secret: String,
}

#[derive(Deserialize)]
struct UpdateIntegration {
    enabled: bool,
}

fn bad(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, reason.to_string()).into_response()
}

fn internal(error: impl std::fmt::Display) -> Response {
    tracing::warn!("integrations: {}", error);
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Integration not found").into_response()
}

async fn list(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<Integration>>, Response> {
    let db = state.db.get().map_err(internal)?;
    integrations::list_for_user(&db, &auth_user.user_id)
        .map(Json)
        .map_err(internal)
}

async fn create(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateIntegration>,
) -> Result<(StatusCode, Json<CreatedIntegration>), Response> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(bad("Give it a name of one line, at most 80 characters"));
    }
    let url = reqwest::Url::parse(req.url.trim()).map_err(|_| bad("That isn't a URL"))?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err(bad("The URL starts with https:// (or http:// on your own network)"));
    }
    if let Some(unknown) = req
        .events
        .iter()
        .find(|e| !crate::webhooks::EVENT_TYPES.contains(&e.as_str()))
    {
        return Err(bad(&format!(
            "No event {unknown}; the events are {}",
            crate::webhooks::EVENT_TYPES.join(", ")
        )));
    }
    let integration = Integration {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: auth_user.user_id.clone(),
        kind: "webhook".into(),
        name: name.to_string(),
        url: url.to_string(),
        secret: crate::webhooks::new_secret(),
        events: req.events,
        access: TokenAccess {
            scopes: vec![TokenScope::RunsRead],
            machines: req.machines,
            include_production: req.include_production,
            content: req.content,
            ..Default::default()
        },
        enabled: true,
        created_at: crate::db::now_ms(),
        last_delivery_at: None,
        last_error: None,
    };
    let db = state.db.get().map_err(internal)?;
    integrations::insert(&db, &integration).map_err(internal)?;
    let secret = integration.secret.clone();
    Ok((
        StatusCode::CREATED,
        Json(CreatedIntegration {
            integration,
            secret,
        }),
    ))
}

/// Turn it off (events stop going into its outbox; what waits stays) or back on.
async fn update(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateIntegration>,
) -> Result<Json<Integration>, Response> {
    let db = state.db.get().map_err(internal)?;
    if !integrations::set_enabled(&db, &id, &auth_user.user_id, req.enabled).map_err(internal)? {
        return Err(not_found());
    }
    integrations::find_for_user(&db, &id, &auth_user.user_id)
        .map_err(internal)?
        .map(Json)
        .ok_or_else(not_found)
}

/// Removes it and every event still waiting for it, at once.
async fn remove(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, Response> {
    let db = state.db.get().map_err(internal)?;
    if integrations::delete(&db, &id, &auth_user.user_id).map_err(internal)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found())
    }
}

/// Sends it an `integration.test` event, whatever its filter.
async fn test(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, Response> {
    let db = state.db.get().map_err(internal)?;
    let Some(hook) = integrations::find_for_user(&db, &id, &auth_user.user_id).map_err(internal)?
    else {
        return Err(not_found());
    };
    if !hook.enabled {
        return Err((StatusCode::CONFLICT, "Turn it on first").into_response());
    }
    crate::webhooks::enqueue_test(&db, &hook).map_err(internal)?;
    Ok(StatusCode::ACCEPTED)
}

/// Its recent deliveries, newest first: delivered, waiting for a retry, or given up on.
async fn deliveries(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Vec<Delivery>>, Response> {
    let db = state.db.get().map_err(internal)?;
    if integrations::find_for_user(&db, &id, &auth_user.user_id)
        .map_err(internal)?
        .is_none()
    {
        return Err(not_found());
    }
    integrations::recent_deliveries(&db, &id, 100)
        .map(Json)
        .map_err(internal)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/integrations", get(list).post(create))
        .route(
            "/api/integrations/{id}",
            axum::routing::patch(update).delete(remove),
        )
        .route("/api/integrations/{id}/test", post(test))
        .route("/api/integrations/{id}/deliveries", get(deliveries))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::attach_router::HubRouter;
    use crate::auth::sign_jwt;
    use crate::machine_manager::MachineManager;

    fn test_state() -> AppState {
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        for user in ["user-a", "user-b"] {
            crate::db::users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
        }
        crate::db::tokens::create_scoped_api_token(
            &conn,
            "odk_read",
            "user-a",
            "reader",
            &crate::auth::hash_token("odk_read"),
            None,
            Some(&TokenAccess { scopes: vec![TokenScope::RunsRead], ..Default::default() }),
        )
        .unwrap();
        drop(conn);
        AppState {
            manager: Arc::new(MachineManager::new(pool.clone())),
            router: Arc::new(HubRouter::new()),
            web_previews: Arc::new(crate::web_preview::registry::Registry::default()),
            db: pool,
            jwt_secret: "test-secret".to_string(),
            base_url: "http://localhost:4317".to_string(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        }
    }

    async fn call(state: &AppState, token: &str, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, String) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let response = crate::routes::router()
            .with_state(state.clone())
            .oneshot(request.body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn webhooks_are_made_listed_without_secrets_and_removed() {
        let state = test_state();
        let me = sign_jwt("user-a", &state.jwt_secret);
        let other = sign_jwt("user-b", &state.jwt_secret);

        for (body, reason) in [
            (json!({ "name": "", "url": "https://x.dev/h" }), "Give it a name"),
            (json!({ "name": "n", "url": "ftp://x.dev/h" }), "The URL starts"),
            (json!({ "name": "n", "url": "https://x.dev/h", "events": ["run.everything"] }), "No event run.everything"),
        ] {
            let (status, text) = call(&state, &me, "POST", "/api/integrations", Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(text.starts_with(reason), "{text}");
        }
        let (status, text) = call(
            &state,
            &me,
            "POST",
            "/api/integrations",
            Some(json!({ "name": "phone", "url": "https://ntfy.example/runs", "events": ["run.request", "run.ended"], "content": "requests" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let created: Value = serde_json::from_str(&text).unwrap();
        assert!(created["secret"].as_str().unwrap().starts_with("whsec_"));
        let id = created["integration"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["integration"]["access"]["content"], "requests");

        // Listed without its secret; someone else's list is empty
        let (_, text) = call(&state, &me, "GET", "/api/integrations", None).await;
        assert!(!text.contains("whsec_"), "{text}");
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()[0]["name"], "phone");
        let (_, text) = call(&state, &other, "GET", "/api/integrations", None).await;
        assert_eq!(text, "[]");
        let (status, _) = call(&state, &other, "DELETE", &format!("/api/integrations/{id}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // A scoped token can't see or make them
        let (status, _) = call(&state, "odk_read", "GET", "/api/integrations", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // Test, off, on, deliveries, gone
        let (status, _) = call(&state, &me, "POST", &format!("/api/integrations/{id}/test"), None).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (_, text) = call(&state, &me, "GET", &format!("/api/integrations/{id}/deliveries"), None).await;
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()[0]["event_type"], "integration.test");
        let (status, text) = call(&state, &me, "PATCH", &format!("/api/integrations/{id}"), Some(json!({ "enabled": false }))).await;
        assert_eq!((status, serde_json::from_str::<Value>(&text).unwrap()["enabled"].clone()), (StatusCode::OK, json!(false)));
        let (status, _) = call(&state, &me, "POST", &format!("/api/integrations/{id}/test"), None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(&state, &me, "DELETE", &format!("/api/integrations/{id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(&state, &me, "GET", &format!("/api/integrations/{id}/deliveries"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
