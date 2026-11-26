//! Public, unauthenticated share surface (`/s/...`).
//!
//! The token is the only credential and the only client input that selects
//! data: handlers resolve token -> share -> owner -> target on the server. No
//! handler here takes `AuthUser`, and no route accepts a draft, database or
//! user id (only a row id, which is checked against the shared view).

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Router,
};
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db::draft_databases::DdError;
use crate::db::draft_shares::{self as shares, PublicQuery, ShareRow};
use crate::AppState;

const MAX_BODY_BYTES: usize = 64 * 1024;

const VIEWER_HTML: &str = include_str!("../../assets/share/index.html");
const VIEWER_JS: &str = include_str!("../../assets/share/viewer.js");
const VIEWER_CSS: &str = include_str!("../../assets/share/viewer.css");
const MARKED_JS: &[u8] = include_bytes!("../../assets/share/marked.min.js");
const PURIFY_JS: &[u8] = include_bytes!("../../assets/share/purify.min.js");
const MERMAID_JS: &[u8] = include_bytes!("../../assets/share/mermaid.min.js");

/// Headers carried by every response from `/s/...`.
const SECURITY_HEADERS: [(&str, &str); 5] = [
    (
        "content-security-policy",
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    ),
    ("x-content-type-options", "nosniff"),
    ("x-robots-tag", "noindex, nofollow"),
    ("referrer-policy", "no-referrer"),
    ("access-control-allow-origin", "*"),
];

/// The one layer over the whole public router: every response (success,
/// error, asset, preflight) gets the same headers. `Cache-Control: no-store`
/// is the default; static assets set their own before this runs.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = if req.method() == Method::OPTIONS {
        // Preflight for the viewer's JSON POST (it runs in a sandboxed origin).
        let mut r = StatusCode::NO_CONTENT.into_response();
        let h = r.headers_mut();
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type"),
        );
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        r
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        h.insert(
            header::HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

/// The single "not found" answer for unknown, revoked and expired tokens (and
/// for anything else that does not resolve). Identical bytes in every case.
fn not_found_json() -> Response {
    let mut res = (
        StatusCode::NOT_FOUND,
        r#"{"error":"not found"}"#,
    )
        .into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

fn not_found_page() -> Response {
    let mut res = (
        StatusCode::NOT_FOUND,
        "<!doctype html><meta charset=utf-8><title>Not found</title><p>This link is not available.</p>",
    )
        .into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    res
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn error_response(e: DdError) -> Response {
    match e {
        DdError::BadRequest(m) => json_response(StatusCode::BAD_REQUEST, json!({ "error": m })),
        DdError::NotFound(_) | DdError::Conflict { .. } => not_found_json(),
        DdError::Internal(m) => {
            // Never includes the token: nothing here has it.
            tracing::warn!("public share request failed: {m}");
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "internal error" }),
            )
        }
    }
}

/// Resolve the token and run `f` on the blocking pool. `Ok(None)` means "404"
/// whatever the reason (bad token shape, unknown, revoked, expired, or the
/// target is gone).
async fn with_share<T, F>(state: &AppState, token: String, f: F) -> Result<Option<T>, Response>
where
    T: Send + 'static,
    F: FnOnce(&Connection, ShareRow) -> Result<Option<T>, DdError> + Send + 'static,
{
    if !shares::token_shape_ok(&token) {
        return Ok(None);
    }
    let pool = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| DdError::Internal(format!("DB error: {e}")))?;
        let Some(share) = shares::resolve_token(&conn, &token)? else {
            return Ok(None);
        };
        f(&conn, share)
    })
    .await
    .map_err(|e| error_response(DdError::Internal(format!("task error: {e}"))))?
    .map_err(error_response)
}

fn html_ok() -> Response {
    let mut res = VIEWER_HTML.into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    res
}

async fn viewer_page(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    match with_share(&state, token, |_, _| Ok(Some(()))).await {
        Ok(Some(())) => html_ok(),
        Ok(None) => not_found_page(),
        Err(r) => r,
    }
}

async fn static_asset(Path(name): Path<String>) -> Response {
    let (content_type, body): (&'static str, Body) = match name.as_str() {
        "viewer.js" => ("text/javascript; charset=utf-8", VIEWER_JS.into()),
        "viewer.css" => ("text/css; charset=utf-8", VIEWER_CSS.into()),
        "marked.min.js" => ("text/javascript; charset=utf-8", Body::from(MARKED_JS)),
        "purify.min.js" => ("text/javascript; charset=utf-8", Body::from(PURIFY_JS)),
        "mermaid.min.js" => ("text/javascript; charset=utf-8", Body::from(MERMAID_JS)),
        _ => return not_found_json(),
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    (StatusCode::OK, headers, body).into_response()
}

async fn data(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    let url_token = token.clone();
    let out = with_share(&state, token, move |conn, share| {
        if share.kind == "draft" {
            let Some((title, content, updated_at)) = shares::public_draft(conn, &share)? else {
                return Ok(None);
            };
            let assets: serde_json::Map<String, Value> = shares::asset_map(conn, &share.id)?
                .into_iter()
                .map(|(source, idx)| (source, Value::String(format!("/s/{url_token}/assets/{idx}"))))
                .collect();
            return Ok(Some(json!({
                "kind": "draft",
                "mode": share.mode,
                "title": title,
                "content": content,
                "updated_at": updated_at,
                "assets": assets,
            })));
        }
        let Some(ctx) = shares::load_db_context(conn, &share)? else {
            return Ok(None);
        };
        let row_count = shares::public_row_count(conn, &share, &ctx)?;
        let visible_ids: Vec<&str> = ctx.visible.iter().map(|c| c.id.as_str()).collect();
        // Sorts / group_by on hidden columns are not exposed to the viewer.
        let sorts: Vec<_> = ctx
            .view
            .sorts
            .iter()
            .filter(|s| visible_ids.contains(&s.column.as_str()) || is_pseudo(&s.column))
            .collect();
        let group_by = ctx
            .view
            .group_by
            .as_ref()
            .filter(|g| visible_ids.contains(&g.as_str()));
        Ok(Some(json!({
            "kind": "database",
            "title": ctx.name,
            "columns": ctx.visible,
            "view": { "type": ctx.view.ty, "group_by": group_by, "sorts": sorts },
            "row_count": row_count,
        })))
    })
    .await;
    respond(out)
}

fn is_pseudo(col: &str) -> bool {
    matches!(col, "title" | "created_at" | "updated_at")
}

fn respond(out: Result<Option<Value>, Response>) -> Response {
    match out {
        Ok(Some(v)) => json_response(StatusCode::OK, v),
        Ok(None) => not_found_json(),
        Err(r) => r,
    }
}

async fn query(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Bytes,
) -> Response {
    // The body is parsed only after the token resolved, so an unknown token
    // answers 404 whatever was posted.
    let out = with_share(&state, token, move |conn, share| {
        if share.kind != "database" {
            return Ok(None);
        }
        let q: PublicQuery = if body.iter().all(u8::is_ascii_whitespace) {
            PublicQuery::default()
        } else {
            serde_json::from_slice(&body)
                .map_err(|_| DdError::BadRequest("invalid request body".into()))?
        };
        let Some(ctx) = shares::load_db_context(conn, &share)? else {
            return Ok(None);
        };
        let res = shares::public_query(conn, &share, &ctx, &q)?;
        Ok(Some(serde_json::to_value(res).unwrap_or(Value::Null)))
    })
    .await;
    respond(out)
}

async fn row(
    State(state): State<AppState>,
    Path((token, row_id)): Path<(String, String)>,
) -> Response {
    let out = with_share(&state, token, move |conn, share| {
        let Some(ctx) = shares::load_db_context(conn, &share)? else {
            return Ok(None);
        };
        let Some((row, content)) = shares::public_row(conn, &share, &ctx, &row_id)? else {
            return Ok(None);
        };
        Ok(Some(json!({
            "id": row.id,
            "title": row.title,
            "properties": row.properties,
            "content": content,
        })))
    })
    .await;
    respond(out)
}

async fn asset(
    State(state): State<AppState>,
    Path((token, idx)): Path<(String, String)>,
) -> Response {
    let Ok(idx) = idx.parse::<i64>() else {
        return not_found_json();
    };
    let out = with_share(&state, token, move |conn, share| {
        if share.kind != "draft" {
            return Ok(None);
        }
        Ok(shares::get_asset(conn, &share.id, idx)?)
    })
    .await;
    match out {
        Ok(Some((mime, bytes))) => {
            let mut res = (StatusCode::OK, bytes).into_response();
            // The stored mime was sniffed from the bytes at snapshot time.
            if let Ok(v) = HeaderValue::from_str(&mime) {
                res.headers_mut().insert(header::CONTENT_TYPE, v);
            }
            res
        }
        Ok(None) => not_found_json(),
        Err(r) => r,
    }
}

async fn not_found_fallback() -> Response {
    not_found_json()
}

/// The public router, already carrying its state. Merge it into the top-level
/// app OUTSIDE the permissive CORS layer: it sets its own headers.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/s/_assets/{name}", get(static_asset))
        .route("/s/{token}", get(viewer_page))
        .route("/s/{token}/data", get(data))
        .route("/s/{token}/query", post(query))
        .route("/s/{token}/rows/{row_id}", get(row))
        .route("/s/{token}/assets/{idx}", get(asset))
        .route("/s", any(not_found_fallback))
        .route("/s/", any(not_found_fallback))
        .route("/s/{token}/{*rest}", any(not_found_fallback))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach_router::HubRouter;
    use crate::db::draft_databases::{
        self as dd, ColumnInput, ColumnType, ConflictMode, DatabasePatch, Filter, RowInput, View,
    };
    use crate::db::drafts::{update_draft, upsert_draft, DraftPatch};
    use crate::db::draft_shares::{
        create_share, prepare_share, revoke_share, StoredAsset,
    };
    use crate::machine_manager::MachineManager;
    use axum::http::Request as HttpRequest;
    use http_body_util::BodyExt;
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        // A shared in-memory DB across pooled connections.
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        for u in ["u1", "u2"] {
            crate::db::users::create_user(&conn, u, "test", u, u, None, "admin").unwrap();
        }
        drop(conn);
        AppState {
            manager: Arc::new(MachineManager::new(pool.clone())),
            router: Arc::new(HubRouter::new()),
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

    struct Resp {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    impl Resp {
        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap()
        }
    }

    async fn call(state: &AppState, method: &str, uri: &str, body: &str) -> Resp {
        let req = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = router(state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Resp { status, headers, body }
    }

    fn assert_security_headers(r: &Resp) {
        let get = |n: &str| r.headers.get(n).map(|v| v.to_str().unwrap().to_string());
        assert_eq!(
            get("content-security-policy").as_deref(),
            Some("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
        );
        assert_eq!(get("x-content-type-options").as_deref(), Some("nosniff"));
        assert_eq!(get("x-robots-tag").as_deref(), Some("noindex, nofollow"));
        assert_eq!(get("referrer-policy").as_deref(), Some("no-referrer"));
        assert_eq!(get("access-control-allow-origin").as_deref(), Some("*"));
        assert!(get("cache-control").is_some());
        assert_eq!(r.headers.get_all("access-control-allow-origin").iter().count(), 1);
    }

    fn draft_share(state: &AppState, user: &str, title: &str, content: &str, mode: Option<&str>) -> (String, String, String) {
        let mut conn = state.db.get().unwrap();
        let d = upsert_draft(&conn, user, title, content, "p", None, false, false).unwrap();
        let p = prepare_share(&conn, user, "draft", &d.id, mode, None).unwrap();
        let s = create_share(&mut conn, user, &p, None, &[]).unwrap();
        (d.id, s.row.id, s.row.token)
    }

    #[tokio::test]
    async fn headers_on_success_404_and_asset_responses() {
        let state = test_state();
        let (_, _, token) = draft_share(&state, "u1", "T", "hello", None);

        let ok = call(&state, "GET", &format!("/s/{token}/data"), "").await;
        assert_eq!(ok.status, StatusCode::OK);
        assert_security_headers(&ok);
        assert_eq!(ok.headers["cache-control"], "no-store");

        let page = call(&state, "GET", &format!("/s/{token}"), "").await;
        assert_eq!(page.status, StatusCode::OK);
        assert_security_headers(&page);
        assert!(!String::from_utf8_lossy(&page.body).contains(&token));
        assert!(String::from_utf8_lossy(&page.body).contains("/s/_assets/viewer.js"));

        let unknown = call(&state, "GET", "/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/data", "").await;
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        assert_security_headers(&unknown);
        assert_eq!(unknown.headers["cache-control"], "no-store");

        let asset = call(&state, "GET", "/s/_assets/viewer.js", "").await;
        assert_eq!(asset.status, StatusCode::OK);
        assert_security_headers(&asset);
        assert_eq!(asset.headers["cache-control"], "public, max-age=3600");
        assert!(asset.headers["content-type"].to_str().unwrap().starts_with("text/javascript"));

        let missing_asset = call(&state, "GET", "/s/_assets/evil.js", "").await;
        assert_eq!(missing_asset.status, StatusCode::NOT_FOUND);
        assert_security_headers(&missing_asset);

        // Wrong method, odd paths and preflight carry them too.
        for (m, uri) in [
            ("POST", format!("/s/{token}/data")),
            ("GET", "/s".to_string()),
            ("GET", format!("/s/{token}/nope/more")),
            ("OPTIONS", format!("/s/{token}/query")),
        ] {
            let r = call(&state, m, &uri, "").await;
            assert_security_headers(&r);
        }
        // A bad body on an unknown token still answers 404 (not 400), also with headers.
        let q = call(&state, "POST", "/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/query", "not json").await;
        assert_eq!(q.status, StatusCode::NOT_FOUND);
        assert_security_headers(&q);
    }

    #[tokio::test]
    async fn public_routes_work_without_authentication() {
        let state = test_state();
        let (_, _, token) = draft_share(&state, "u1", "T", "hello **world**", None);
        // No Authorization header is sent anywhere in `call`.
        let r = call(&state, "GET", &format!("/s/{token}/data"), "").await;
        assert_eq!(r.status, StatusCode::OK);
        let j = r.json();
        assert_eq!(j["kind"], "draft");
        assert_eq!(j["mode"], "snapshot");
        assert_eq!(j["title"], "T");
        assert_eq!(j["content"], "hello **world**");
    }

    #[tokio::test]
    async fn unknown_revoked_and_expired_are_indistinguishable() {
        let state = test_state();
        let (did, share_id, revoked) = draft_share(&state, "u1", "T", "x", None);
        let expired = {
            let mut conn = state.db.get().unwrap();
            let p = prepare_share(&conn, "u1", "draft", &did, None, None).unwrap();
            create_share(&mut conn, "u1", &p, Some(crate::db::now_ms() - 5), &[]).unwrap().row.token
        };
        {
            let mut conn = state.db.get().unwrap();
            assert!(revoke_share(&mut conn, "u1", &share_id).unwrap());
        }
        let unknown = shares::generate_token().unwrap();
        for suffix in ["", "/data", "/assets/0", "/rows/x"] {
            let mut seen = Vec::new();
            for t in [&revoked, &expired, &unknown] {
                let r = call(&state, "GET", &format!("/s/{t}{suffix}"), "").await;
                assert_eq!(r.status, StatusCode::NOT_FOUND, "{suffix}");
                let mut hs: Vec<_> = r
                    .headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
                    .collect();
                hs.sort();
                seen.push((r.body, hs));
            }
            assert_eq!(seen[0], seen[1], "{suffix}");
            assert_eq!(seen[1], seen[2], "{suffix}");
        }
        let q = |t: String| {
            let state = state.clone();
            async move { call(&state, "POST", &format!("/s/{t}/query"), "{}").await }
        };
        let (a, b) = (q(revoked.clone()).await, q(unknown.clone()).await);
        assert_eq!((a.status, a.body), (b.status, b.body));
    }

    #[tokio::test]
    async fn snapshot_is_immutable_and_live_follows_edits() {
        let state = test_state();
        let (did, _, snap) = draft_share(&state, "u1", "T", "v1", Some("snapshot"));
        let live = {
            let mut conn = state.db.get().unwrap();
            let p = prepare_share(&conn, "u1", "draft", &did, Some("live"), None).unwrap();
            create_share(&mut conn, "u1", &p, None, &[]).unwrap().row.token
        };
        {
            let conn = state.db.get().unwrap();
            update_draft(
                &conn,
                "u1",
                &did,
                DraftPatch { title: Some("T2"), content: Some("v2"), ..Default::default() },
            )
            .unwrap();
        }
        let s = call(&state, "GET", &format!("/s/{snap}/data"), "").await.json();
        assert_eq!((s["title"].as_str(), s["content"].as_str()), (Some("T"), Some("v1")));
        let l = call(&state, "GET", &format!("/s/{live}/data"), "").await.json();
        assert_eq!((l["title"].as_str(), l["content"].as_str()), (Some("T2"), Some("v2")));
        // Deleting the draft: snapshot still served, live 404.
        {
            let conn = state.db.get().unwrap();
            crate::db::drafts::delete_draft(&conn, "u1", &did).unwrap();
        }
        assert_eq!(call(&state, "GET", &format!("/s/{snap}/data"), "").await.status, StatusCode::OK);
        assert_eq!(call(&state, "GET", &format!("/s/{live}/data"), "").await.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn assets_are_served_with_the_stored_mime_and_only_for_draft_shares() {
        let state = test_state();
        let token = {
            let mut conn = state.db.get().unwrap();
            let d = upsert_draft(&conn, "u1", "T", "![x](file://m/a.png)", "p", None, false, false).unwrap();
            let p = prepare_share(&conn, "u1", "draft", &d.id, None, None).unwrap();
            let a = StoredAsset { source: "file://m/a.png".into(), mime: "image/png".into(), bytes: vec![0x89, b'P', b'N', b'G'] };
            create_share(&mut conn, "u1", &p, None, &[a]).unwrap().row.token
        };
        let data = call(&state, "GET", &format!("/s/{token}/data"), "").await.json();
        assert_eq!(data["assets"]["file://m/a.png"], format!("/s/{token}/assets/0"));
        let r = call(&state, "GET", &format!("/s/{token}/assets/0"), "").await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.headers["content-type"], "image/png");
        assert_security_headers(&r);
        assert_eq!(r.body, vec![0x89, b'P', b'N', b'G']);
        assert_eq!(call(&state, "GET", &format!("/s/{token}/assets/1"), "").await.status, StatusCode::NOT_FOUND);
        assert_eq!(call(&state, "GET", &format!("/s/{token}/assets/abc"), "").await.status, StatusCode::NOT_FOUND);
    }

    fn database_share(state: &AppState) -> (String, String, Vec<String>) {
        let mut conn = state.db.get().unwrap();
        let cols = vec![
            ColumnInput { id: None, name: "Status".into(), ty: Some(ColumnType::Select), options: vec![] },
            ColumnInput { id: None, name: "Secret".into(), ty: Some(ColumnType::Text), options: vec![] },
        ];
        let (db, _) = dd::create_database(&conn, "u1", "tasks", None, &cols, false).unwrap();
        let mk = |t: &str, s: &str| RowInput {
            title: t.into(),
            properties: json!({"status": s, "secret": format!("s-{t}")}).as_object().cloned(),
            content: Some(format!("body {t}")),
        };
        let res = dd::upsert_rows(
            &mut conn,
            "u1",
            &db.id,
            vec![mk("a", "todo"), mk("b", "done"), mk("c", "todo")],
            ConflictMode::Create,
        )
        .unwrap();
        let views = vec![View {
            id: "pub".into(),
            name: "Public".into(),
            ty: "table".into(),
            filters: vec![Filter { column: "status".into(), op: "eq".into(), value: Some(json!("todo")) }],
            sorts: vec![],
            group_by: None,
            hidden_columns: Some(vec!["secret".into()]),
        }];
        dd::patch_database(&mut conn, "u1", &db.id, DatabasePatch { views: Some(views), ..Default::default() }).unwrap();
        let p = prepare_share(&conn, "u1", "database", &db.id, None, None).unwrap();
        let s = create_share(&mut conn, "u1", &p, None, &[]).unwrap();
        (s.row.token, db.id, res.rows.into_iter().map(|r| r.id).collect())
    }

    #[tokio::test]
    async fn database_share_enforces_view_filters_hidden_columns_and_ignores_client_filters() {
        let state = test_state();
        let (token, _, ids) = database_share(&state);

        let d = call(&state, "GET", &format!("/s/{token}/data"), "").await;
        assert_eq!(d.status, StatusCode::OK);
        let d = d.json();
        assert_eq!(d["kind"], "database");
        assert_eq!(d["title"], "tasks · Public");
        assert_eq!(d["row_count"], 2);
        let cols: Vec<_> = d["columns"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(cols, vec!["status"]);

        // Client-supplied filters (trying to see the 'done' row) are ignored.
        let body = r#"{"filters":[{"column":"status","op":"eq","value":"done"}],"limit":5000}"#;
        let q = call(&state, "POST", &format!("/s/{token}/query"), body).await;
        assert_eq!(q.status, StatusCode::OK);
        assert_security_headers(&q);
        let q = q.json();
        assert_eq!(q["total"], 2);
        assert_eq!(q["limit"], 200);
        let titles: Vec<_> = q["rows"].as_array().unwrap().iter().map(|r| r["title"].as_str().unwrap()).collect();
        assert_eq!(titles, vec!["a", "c"]);
        for r in q["rows"].as_array().unwrap() {
            assert!(r["properties"].get("secret").is_none());
            assert!(r["properties"].get("status").is_some());
        }
        // Sorting by the hidden column is refused without naming it as valid.
        let bad = call(&state, "POST", &format!("/s/{token}/query"), r#"{"sorts":[{"column":"secret"}]}"#).await;
        assert_eq!(bad.status, StatusCode::BAD_REQUEST);
        let bad = call(&state, "POST", &format!("/s/{token}/query"), r#"{"sorts":[{"column":"nope"}]}"#).await;
        assert_eq!(bad.status, StatusCode::BAD_REQUEST);
        assert!(!String::from_utf8_lossy(&bad.body).contains("secret"));
        // Garbage body -> 400; non-database routes -> 404.
        assert_eq!(call(&state, "POST", &format!("/s/{token}/query"), "nope").await.status, StatusCode::BAD_REQUEST);
        assert_eq!(call(&state, "GET", &format!("/s/{token}/assets/0"), "").await.status, StatusCode::NOT_FOUND);

        // Row access: inside the filter ok (no hidden props); outside 404.
        let ok = call(&state, "GET", &format!("/s/{token}/rows/{}", ids[0]), "").await;
        assert_eq!(ok.status, StatusCode::OK);
        assert_security_headers(&ok);
        let ok = ok.json();
        assert_eq!(ok["title"], "a");
        assert_eq!(ok["content"], "body a");
        assert!(ok["properties"].get("secret").is_none());
        assert_eq!(call(&state, "GET", &format!("/s/{token}/rows/{}", ids[1]), "").await.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rows_endpoint_refuses_rows_of_other_databases_and_draft_shares_have_no_rows() {
        let state = test_state();
        let (token, _, _) = database_share(&state);
        let other_row = {
            let mut conn = state.db.get().unwrap();
            let (db2, _) = dd::create_database(&conn, "u1", "other", None, &[], false).unwrap();
            dd::upsert_rows(
                &mut conn,
                "u1",
                &db2.id,
                vec![RowInput { title: "x".into(), properties: None, content: Some("s".into()) }],
                ConflictMode::Create,
            )
            .unwrap()
            .rows[0]
                .id
                .clone()
        };
        assert_eq!(call(&state, "GET", &format!("/s/{token}/rows/{other_row}"), "").await.status, StatusCode::NOT_FOUND);
        // A plain draft id is not a row of the shared database either.
        let (did, _, dtoken) = draft_share(&state, "u1", "T", "x", None);
        assert_eq!(call(&state, "GET", &format!("/s/{token}/rows/{did}"), "").await.status, StatusCode::NOT_FOUND);
        assert_eq!(call(&state, "GET", &format!("/s/{dtoken}/rows/{did}"), "").await.status, StatusCode::NOT_FOUND);
        assert_eq!(call(&state, "POST", &format!("/s/{dtoken}/query"), "{}").await.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn public_body_limit_is_64kb() {
        let state = test_state();
        let (token, _, _) = database_share(&state);
        let big = format!(r#"{{"search":"{}"}}"#, "a".repeat(70 * 1024));
        let r = call(&state, "POST", &format!("/s/{token}/query"), &big).await;
        assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_security_headers(&r);
    }

    #[tokio::test]
    async fn live_database_share_404s_when_database_or_view_is_gone() {
        let state = test_state();
        let (token, db_id, _) = database_share(&state);
        assert_eq!(call(&state, "GET", &format!("/s/{token}/data"), "").await.status, StatusCode::OK);
        {
            let mut conn = state.db.get().unwrap();
            dd::delete_database(&mut conn, "u1", &db_id).unwrap();
        }
        assert_eq!(call(&state, "GET", &format!("/s/{token}/data"), "").await.status, StatusCode::NOT_FOUND);
        assert_eq!(call(&state, "POST", &format!("/s/{token}/query"), "{}").await.status, StatusCode::NOT_FOUND);
    }
}
