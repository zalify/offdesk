//! Getting started (OFF-7): what a person has done so far and what they've dismissed, so
//! the Mac and the phone show the same list. What's done is read from what the hub
//! already knows, never recorded, so it can't disagree with the real state; only what
//! was dismissed is stored.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::db::{self, onboarding};
use crate::AppState;

const HIDDEN: &str = "hidden";
const TIP: &str = "tip:";

#[derive(Debug, Serialize)]
struct Done {
    phone: bool,
    session: bool,
    machine: bool,
    remote: bool,
}

#[derive(Debug, Serialize)]
struct Onboarding {
    done: Done,
    hidden: bool,
    tips_seen: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateOnboarding {
    hidden: Option<bool>,
    tip_seen: Option<String>,
}

fn internal(error: impl std::fmt::Display) -> Response {
    tracing::warn!("onboarding: {}", error);
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
}

fn valid_tip(tip: &str) -> bool {
    (1..=64).contains(&tip.len())
        && tip.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn read(
    conn: &rusqlite::Connection,
    user_id: &str,
    remote: bool,
) -> rusqlite::Result<Onboarding> {
    let marks = onboarding::marks(conn, user_id)?;
    Ok(Onboarding {
        done: Done {
            phone: crate::secure::store::list(conn, user_id)?
                .iter()
                .any(|device| device.revoked_at.is_none()),
            session: onboarding::has_started_a_session(conn, user_id)?,
            machine: db::machines::find_machines_by_user(conn, user_id)?.len() > 1,
            remote,
        },
        hidden: marks.iter().any(|mark| mark == HIDDEN),
        tips_seen: marks
            .iter()
            .filter_map(|mark| mark.strip_prefix(TIP).map(str::to_string))
            .collect(),
    })
}

fn update(
    conn: &rusqlite::Connection,
    user_id: &str,
    change: &UpdateOnboarding,
) -> rusqlite::Result<()> {
    match change.hidden {
        Some(true) => onboarding::add_mark(conn, user_id, HIDDEN)?,
        Some(false) => onboarding::remove_mark(conn, user_id, HIDDEN)?,
        None => {}
    }
    if let Some(tip) = &change.tip_seen {
        onboarding::add_mark(conn, user_id, &format!("{TIP}{tip}"))?;
    }
    Ok(())
}

pub fn router(remote_url: Option<String>, database: String) -> Router<AppState> {
    let has_remote = move |base_url: &str| {
        crate::connections::has_remote_route(remote_url.as_ref(), base_url, &database)
    };
    let has_remote_after_update = has_remote.clone();
    Router::new().route(
        "/api/onboarding",
        get(move |State(state): State<AppState>, auth_user: AuthUser| {
            let remote = has_remote(&state.base_url);
            async move {
                let conn = state.db.get().map_err(internal)?;
                read(&conn, &auth_user.user_id, remote).map(Json).map_err(internal)
            }
        })
        .patch(
            move |State(state): State<AppState>, auth_user: AuthUser, Json(change): Json<UpdateOnboarding>| {
                let remote = has_remote_after_update(&state.base_url);
                async move {
                    if change.tip_seen.as_deref().is_some_and(|tip| !valid_tip(tip)) {
                        return Err((StatusCode::BAD_REQUEST, "That isn't a tip").into_response());
                    }
                    let conn = state.db.get().map_err(internal)?;
                    update(&conn, &auth_user.user_id, &change).map_err(internal)?;
                    read(&conn, &auth_user.user_id, remote).map(Json).map_err(internal)
                }
            },
        ),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use rusqlite::params;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::attach_router::HubRouter;
    use crate::auth::sign_jwt;
    use crate::machine_manager::MachineManager;

    fn test_state(base_url: &str) -> AppState {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        db::init_db(&conn).unwrap();
        for user in ["user-a", "user-b"] {
            db::users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
            add_machine(&conn, &format!("{user}-mac"), user);
        }
        drop(conn);
        AppState {
            manager: Arc::new(MachineManager::new(pool.clone())),
            router: Arc::new(HubRouter::new()),
            web_previews: Arc::new(crate::web_preview::registry::Registry::default()),
            db: pool,
            jwt_secret: "test-secret".to_string(),
            base_url: base_url.to_string(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        }
    }

    fn add_machine(conn: &rusqlite::Connection, id: &str, user: &str) {
        db::machines::ensure_machine_for_user(conn, id, user, id, Some("linux"), Some("/tmp"))
            .unwrap();
    }

    fn add_device(conn: &rusqlite::Connection, id: &str, user: &str, revoked_at: Option<i64>) {
        conn.execute(
            "INSERT INTO secure_devices(id,user_id,public_key,name,created_at,last_seen_at,revoked_at)
             VALUES (?1,?2,?1,'phone',1,1,?3)",
            params![id, user, revoked_at],
        )
        .unwrap();
    }

    async fn call(state: &AppState, user: &str, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let token = sign_jwt(user, &state.jwt_secret);
        let mut request = Request::builder()
            .method(method)
            .uri("/api/onboarding")
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let response = router(None, "/nonexistent/hub.db".into())
            .with_state(state.clone())
            .oneshot(request.body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn a_new_person_has_done_nothing_yet() {
        let state = test_state("http://localhost:4317");
        let (status, onboarding) = call(&state, "user-a", "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            onboarding,
            json!({
                "done": { "phone": false, "session": false, "machine": false, "remote": false },
                "hidden": false,
                "tips_seen": [],
            })
        );
    }

    #[tokio::test]
    async fn what_is_done_comes_from_the_real_state() {
        let state = test_state("https://hub.example");
        {
            let conn = state.db.get().unwrap();
            add_machine(&conn, "user-a-nas", "user-a");
            add_device(&conn, "phone", "user-a", None);
            db::terminal_sessions::insert(&conn, "t1", "user-a-mac", "zsh", "/tmp", 80, 24).unwrap();
            db::terminal_sessions::mark_destroyed(&conn, "t1").unwrap();
        }
        let (_, onboarding) = call(&state, "user-a", "GET", None).await;
        assert_eq!(
            onboarding["done"],
            json!({ "phone": true, "session": true, "machine": true, "remote": true })
        );
        // Someone else's phone and terminals aren't theirs
        let (_, other) = call(&state, "user-b", "GET", None).await;
        assert_eq!(other["done"]["phone"], json!(false));
        assert_eq!(other["done"]["session"], json!(false));
        assert_eq!(other["done"]["machine"], json!(false));
    }

    #[tokio::test]
    async fn a_revoked_phone_no_longer_counts() {
        let state = test_state("http://localhost:4317");
        add_device(&state.db.get().unwrap(), "phone", "user-a", Some(2));
        let (_, onboarding) = call(&state, "user-a", "GET", None).await;
        assert_eq!(onboarding["done"]["phone"], json!(false));
    }

    #[tokio::test]
    async fn hiding_and_tips_stay_with_the_person() {
        let state = test_state("http://localhost:4317");
        call(&state, "user-a", "PATCH", Some(json!({ "tip_seen": "tab-is-tmux" }))).await;
        let (status, onboarding) = call(&state, "user-a", "PATCH", Some(json!({ "hidden": true, "tip_seen": "tab-is-tmux" }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(onboarding["hidden"], json!(true));
        assert_eq!(onboarding["tips_seen"], json!(["tab-is-tmux"]));

        // Bringing the list back leaves the tips dismissed
        let (_, onboarding) = call(&state, "user-a", "PATCH", Some(json!({ "hidden": false }))).await;
        assert_eq!(onboarding["hidden"], json!(false));
        assert_eq!(onboarding["tips_seen"], json!(["tab-is-tmux"]));

        let (_, other) = call(&state, "user-b", "GET", None).await;
        assert_eq!(other["tips_seen"], json!([]));
    }

    #[tokio::test]
    async fn a_tip_id_must_be_a_plain_name() {
        let state = test_state("http://localhost:4317");
        for tip in ["", "Tab Tip", &"a".repeat(65)] {
            let (status, _) = call(&state, "user-a", "PATCH", Some(json!({ "tip_seen": tip }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{tip}");
        }
    }
}
