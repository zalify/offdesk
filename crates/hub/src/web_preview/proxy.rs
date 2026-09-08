use super::{
    registry::{Lease, StreamGuard, COOKIE},
    transport,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use hyper::{
    body::{Body as HttpBody, Frame, Incoming},
    client::conn::http1,
};
use hyper_util::rt::TokioIo;
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

struct Connection {
    _guard: StreamGuard,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct ResponseBody {
    body: Incoming,
    connection: Option<Connection>,
}
impl HttpBody for ResponseBody {
    type Data = axum::body::Bytes;
    type Error = hyper::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let frame = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(frame, Poll::Ready(None) | Poll::Ready(Some(Err(_))))
            || self.body.is_end_stream()
        {
            self.connection.take();
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> hyper::body::SizeHint {
        self.body.size_hint()
    }
}

pub fn cookie(headers: &HeaderMap) -> Option<String> {
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        for part in value.to_str().ok()?.split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                if name == COOKIE {
                    if found.is_some() {
                        return None;
                    }
                    found = Some(value.to_string());
                }
            }
        }
    }
    found
}

pub fn origin_allowed(headers: &HeaderMap, method: &Method, upgrade: bool, origin: &str) -> bool {
    let supplied = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok());
    if supplied.is_some_and(|o| o != origin) {
        return false;
    }
    if upgrade || !matches!(*method, Method::GET | Method::HEAD) {
        return supplied == Some(origin);
    }
    match headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        Some("same-origin") | Some("none") => true,
        Some("same-site") | Some("cross-site") => {
            headers
                .get("sec-fetch-mode")
                .is_some_and(|v| v == "navigate")
                && headers.get("sec-fetch-user").is_some_and(|v| v == "?1")
        }
        // Older clients must supply an exact Origin or same-origin Referer.
        _ => {
            supplied == Some(origin)
                || headers
                    .get(header::REFERER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|r| url::Url::parse(r).ok())
                    .is_some_and(|r| r.origin().ascii_serialization() == origin)
        }
    }
}

fn strip_hop(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(|s| s.trim().to_string()))
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

fn request_headers(headers: &mut HeaderMap, lease: &Lease, websocket: bool) {
    let cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .filter(|v| !v.split_once('=').is_some_and(|(name, _)| name == COOKIE))
        .collect::<Vec<_>>()
        .join("; ");
    headers.remove(header::COOKIE);
    if !cookies.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&cookies) {
            headers.insert(header::COOKIE, v);
        }
    }
    strip_hop(headers);
    let forwarded: Vec<_> = headers
        .keys()
        .filter(|k| k.as_str().starts_with("x-forwarded-") || k.as_str() == "forwarded")
        .cloned()
        .collect();
    for k in forwarded {
        headers.remove(k);
    }
    let authority = lease.origin.trim_start_matches("https://");
    headers.insert(header::HOST, authority.parse().unwrap());
    headers.insert("x-forwarded-host", authority.parse().unwrap());
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    headers.insert(
        "x-forwarded-port",
        url::Url::parse(&lease.origin)
            .unwrap()
            .port_or_known_default()
            .unwrap()
            .to_string()
            .parse()
            .unwrap(),
    );
    if websocket {
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    }
}

fn rewrite_location(value: &str, lease: &Lease) -> String {
    if let Ok(mut url) = url::Url::parse(value) {
        let local = match lease.family {
            offdesk_protocol::preview::AddressFamily::Ipv4 => {
                matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            }
            offdesk_protocol::preview::AddressFamily::Ipv6 => {
                matches!(url.host_str(), Some("localhost" | "[::1]"))
            }
        };
        if local && url.scheme() == "http" && url.port_or_known_default() == Some(lease.port) {
            let dest = url::Url::parse(&lease.origin).unwrap();
            let _ = url.set_scheme("https");
            let _ = url.set_host(dest.host_str());
            let _ = url.set_port(dest.port());
            let _ = url.set_username("");
            let _ = url.set_password(None);
            return url.to_string();
        }
    }
    value.to_string()
}

pub fn response_headers(headers: &mut HeaderMap, lease: &Lease, websocket: bool) {
    let cookies: Vec<_> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|value| {
            let mut parts = value.split(';');
            let first = parts.next()?.trim();
            let (name, _) = first.split_once('=')?;
            if name.trim() == COOKIE {
                return None;
            }
            let mut result = first.to_string();
            for part in parts {
                if !part
                    .trim()
                    .split('=')
                    .next()
                    .is_some_and(|n| n.eq_ignore_ascii_case("domain"))
                {
                    result.push(';');
                    result.push_str(part);
                }
            }
            HeaderValue::from_str(&result).ok()
        })
        .collect();
    headers.remove(header::SET_COOKIE);
    strip_hop(headers);
    for v in cookies {
        headers.append(header::SET_COOKIE, v);
    }
    if let Some(value) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok()) {
        if let Ok(value) = HeaderValue::from_str(&rewrite_location(value, lease)) {
            headers.insert(header::LOCATION, value);
        }
    }
    if let Some(value) = headers.get("refresh").and_then(|v| v.to_str().ok()) {
        if let Some((delay, target)) = value.split_once(';') {
            let target = target.trim();
            if target
                .get(..4)
                .is_some_and(|s| s.eq_ignore_ascii_case("url="))
            {
                let target = target[4..].trim().trim_matches(['\'', '"']);
                if let Ok(v) = format!("{delay};url={}", rewrite_location(target, lease)).parse() {
                    headers.insert("refresh", v);
                }
            }
        }
    }
    let cors: Vec<_> = headers
        .keys()
        .filter(|k| k.as_str().starts_with("access-control-"))
        .cloned()
        .collect();
    for k in cors {
        headers.remove(k);
    }
    headers.remove("clear-site-data");
    super::private_headers(headers);
    if websocket {
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    }
}

pub async fn forward(
    state: crate::AppState,
    lease: Arc<Lease>,
    mut request: Request<Body>,
) -> Response {
    let is_ws = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|h| h.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if request.method() == Method::CONNECT
        || (request.headers().contains_key(header::UPGRADE) && !is_ws)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !cookie(request.headers()).is_some_and(|c| lease.authenticated(&c)) {
        return (
            StatusCode::UNAUTHORIZED,
            "Preview expired or not signed in. Open it again from offdesk.",
        )
            .into_response();
    }
    if !origin_allowed(request.headers(), request.method(), is_ws, &lease.origin) {
        return (StatusCode::FORBIDDEN, "Cross-origin preview request denied").into_response();
    }
    let ws_expected = if is_ws {
        match tokio_tungstenite::tungstenite::handshake::server::create_response_with_body(
            &request,
            || (),
        ) {
            Ok(response) => Some(response.headers()["sec-websocket-accept"].clone()),
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        }
    } else {
        None
    };
    let offered_protocols = request.headers().get("sec-websocket-protocol").cloned();
    let offered_extensions = request.headers().get("sec-websocket-extensions").cloned();
    let browser_upgrade = if is_ws {
        Some(hyper::upgrade::on(&mut request))
    } else {
        None
    };
    let (io, guard) = match transport::open(&state, lease.clone()).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    request_headers(request.headers_mut(), &lease, is_ws);
    *request.version_mut() = axum::http::Version::HTTP_11;
    let path = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    *request.uri_mut() = path.parse().unwrap();
    let (mut sender, connection) = match http1::handshake(TokioIo::new(io)).await {
        Ok(v) => v,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let cancel = guard.cancel.clone();
    let deadline = lease.expires;
    let task = tokio::spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => {},
            _ = tokio::time::sleep_until(deadline.into()) => {},
            _ = connection.with_upgrades() => {},
        }
    });
    let life = Connection {
        _guard: guard,
        task,
    };
    let mut response =
        match tokio::time::timeout(Duration::from_secs(60), sender.send_request(request)).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return StatusCode::BAD_GATEWAY.into_response(),
            Err(_) => return StatusCode::GATEWAY_TIMEOUT.into_response(),
        };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let Some(expected) = ws_expected else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        if response.headers().get("sec-websocket-accept") != Some(&expected)
            || !response
                .headers()
                .get(header::UPGRADE)
                .is_some_and(|h| h.as_bytes().eq_ignore_ascii_case(b"websocket"))
            || !response
                .headers()
                .get(header::CONNECTION)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| {
                    h.split(',')
                        .any(|p| p.trim().eq_ignore_ascii_case("upgrade"))
                })
        {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        if let Some(protocol) = response.headers().get("sec-websocket-protocol") {
            if !offered_protocols
                .as_ref()
                .and_then(|p| p.to_str().ok())
                .is_some_and(|p| {
                    p.split(',')
                        .any(|p| p.trim().as_bytes() == protocol.as_bytes())
                })
            {
                return StatusCode::BAD_GATEWAY.into_response();
            }
        }
        if response.headers().contains_key("sec-websocket-extensions")
            && offered_extensions.is_none()
        {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        let upstream = hyper::upgrade::on(&mut response);
        let browser = browser_upgrade.unwrap();
        response_headers(response.headers_mut(), &lease, true);
        tokio::spawn(async move {
            let _life = life;
            tokio::select! {
                _ = _life._guard.cancel.cancelled() => {},
                _ = tokio::time::sleep_until(lease.expires.into()) => {},
                _ = async {
                    if let (Ok(upstream), Ok(browser)) = tokio::join!(upstream, browser) {
                        let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(upstream), &mut TokioIo::new(browser)).await;
                    }
                } => {},
            }
        });
        return response.map(|_| Body::empty());
    }
    response_headers(response.headers_mut(), &lease, false);
    response.map(|body| {
        Body::new(ResponseBody {
            body,
            connection: Some(life),
        })
    })
}
