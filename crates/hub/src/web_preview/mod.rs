mod proxy;
pub mod registry;
#[cfg(test)]
mod tests;
mod transport;

use crate::{auth::AuthUser, AppState};
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use offdesk_protocol::preview::AddressFamily;
use registry::SYSTEM_PATH;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize)]
struct CreateRequest {
    port: u16,
    #[serde(default)]
    address_family: AddressFamily,
    terminal_id: Option<String>,
    #[serde(default = "root")]
    target: String,
}
fn root() -> String {
    "/".into()
}
#[derive(Serialize)]
struct PreviewInfo {
    id: String,
    machine_id: String,
    port: u16,
    url: String,
    expires_at: i64,
}
fn info(l: &registry::Lease) -> PreviewInfo {
    PreviewInfo {
        id: l.id.clone(),
        machine_id: l.machine.clone(),
        port: l.port,
        url: format!("{}{}", l.origin, l.target),
        expires_at: l.expires_at,
    }
}

fn valid_target(target: &str) -> bool {
    if !target.starts_with('/')
        || target.starts_with("//")
        || target.contains('\\')
        || target.len() > 8192
        || target.chars().any(char::is_control)
    {
        return false;
    }
    let Ok(url) = url::Url::parse(&format!("https://preview.invalid{target}")) else {
        return false;
    };
    url.host_str() == Some("preview.invalid") && !url.path().starts_with(SYSTEM_PATH)
}

async fn create(
    AuthUser { user_id }: AuthUser,
    State(state): State<AppState>,
    Path(machine): Path<String>,
    Json(body): Json<CreateRequest>,
) -> Response {
    if state.web_previews.config.is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Web previews are not configured on this Hub",
        )
            .into_response();
    }
    if body.port == 0 || !valid_target(&body.target) {
        return (StatusCode::BAD_REQUEST, "Invalid local preview address").into_response();
    }
    if !state
        .manager
        .user_can_access_machine(&user_id, &machine)
        .await
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(terminal) = &body.terminal_id {
        if !state
            .manager
            .user_can_access_terminal(&user_id, &machine, terminal)
            .await
        {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    if state
        .manager
        .preview_connection(&user_id, &machine)
        .await
        .is_none()
    {
        return (
            StatusCode::CONFLICT,
            "Update this machine's offdesk-node to enable web previews",
        )
            .into_response();
    }
    match state.web_previews.create(
        user_id,
        machine,
        body.port,
        body.address_family,
        body.target,
    ) {
        Ok((lease, code)) => {
            let mut response = Json(serde_json::json!({ "preview": info(&lease), "launch_url": format!("{}{SYSTEM_PATH}bootstrap#code={code}", lease.origin) })).into_response();
            private(&mut response);
            response
        }
        Err(error) => (StatusCode::TOO_MANY_REQUESTS, error).into_response(),
    }
}
async fn list(AuthUser { user_id }: AuthUser, State(state): State<AppState>) -> Response {
    let previews: Vec<_> = state
        .web_previews
        .leases
        .lock()
        .unwrap()
        .values()
        .filter(|l| l.user == user_id && l.live())
        .map(|l| info(l))
        .collect();
    let mut response = Json(serde_json::json!({ "configured": state.web_previews.config.is_some(), "previews": previews })).into_response();
    private(&mut response);
    response
}
async fn revoke(
    AuthUser { user_id }: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    if state.web_previews.revoke(&user_id, &id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

fn private(response: &mut Response) {
    private_headers(response.headers_mut());
}
fn private_headers(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert("cdn-cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
}
fn html(source: &str) -> Response {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut response = axum::response::Html(source.replace("__NONCE__", &nonce)).into_response();
    private(&mut response);
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert("content-security-policy", format!("default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'").parse().unwrap());
    response
}
async fn launcher() -> Response {
    html(include_str!("launcher.html"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/machines/{machine}/web-previews", post(create))
        .route("/api/web-previews", get(list))
        .route("/api/web-previews/{id}", delete(revoke))
        .route("/ws/preview-stream/{id}", get(transport::accept))
        .route("/__offdesk_preview__/launch", get(launcher))
}

/// This outer layer runs before Hub CORS, /api, /ws, or SPA fallback. A
/// development application's /api must never accidentally invoke the Hub API.
pub async fn dispatch(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Some(config) = &state.web_previews.config else {
        return next.run(request).await;
    };
    let Some(authority) = request_authority(&request) else {
        return unknown_authority();
    };
    if config.allows_control(authority, crate::first_run::local_network_addresses) {
        return next.run(request).await;
    }
    let Ok(url) = url::Url::parse(&format!("https://{authority}")) else {
        return unknown_authority();
    };
    let host = url.host_str().unwrap_or_default();
    if url.port() != config.port
        || !host.ends_with(&format!(".{}", config.domain))
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return unknown_authority();
    }
    let Some(lease) = state.web_previews.find(host) else {
        let mut response = (
            StatusCode::GONE,
            "Preview expired or unavailable. Open it again from offdesk.",
        )
            .into_response();
        private(&mut response);
        return response;
    };
    let path = request.uri().path();
    let mut response =
        if path == format!("{SYSTEM_PATH}bootstrap") && request.method() == Method::GET {
            html(include_str!("bootstrap.html"))
        } else if path == format!("{SYSTEM_PATH}redeem") && request.method() == Method::POST {
            redeem(lease, request).await
        } else if path.starts_with(SYSTEM_PATH) {
            StatusCode::NOT_FOUND.into_response()
        } else {
            proxy::forward(state, lease, request).await
        };
    private(&mut response);
    response
}

fn unknown_authority() -> Response {
    let mut response = (StatusCode::MISDIRECTED_REQUEST,
        "Unrecognized Hub address. When web previews are enabled, add your external LAN/Docker or reverse-proxy origin to OFFDESK_PREVIEW_CONTROL_ORIGINS and restart the Hub. Preserve Host (or HTTP/2 :authority) through your proxy.")
        .into_response();
    private(&mut response);
    response
}

fn request_authority(request: &Request) -> Option<&str> {
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host = hosts.next();
    if hosts.next().is_some() {
        return None;
    }
    let uri = request.uri().authority().map(|a| a.as_str());
    match host {
        Some(host) => {
            let host = host.to_str().ok()?;
            if uri.is_some_and(|uri| !uri.eq_ignore_ascii_case(host)) {
                return None;
            }
            Some(host)
        }
        None if request.version() == axum::http::Version::HTTP_2 => uri,
        None => None,
    }
}
async fn redeem(lease: Arc<registry::Lease>, request: Request<Body>) -> Response {
    if request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        != Some(&lease.origin)
        || !request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(';').next() == Some("application/json"))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    #[derive(Deserialize)]
    struct Code {
        code: String,
    }
    let bytes = match axum::body::to_bytes(request.into_body(), 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let Ok(code) = serde_json::from_slice::<Code>(&bytes) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(cookie) = lease.redeem(&code.code) else {
        return (
            StatusCode::UNAUTHORIZED,
            "Launch link expired or already used. Open a new preview from offdesk.",
        )
            .into_response();
    };
    let mut response = Json(serde_json::json!({ "target": lease.target })).into_response();
    let max_age = (lease.expires_at - registry::now()).max(0) / 1000;
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "{}={cookie}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age={max_age}",
            registry::COOKIE
        )
        .parse()
        .unwrap(),
    );
    response
}
