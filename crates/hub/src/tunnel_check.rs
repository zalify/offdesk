//! A local, credential-free preflight for the address used in pairing codes.
//! The pinned key comes from this Hub, never from the relay being checked.
use futures::{SinkExt, StreamExt};
use offdesk_secure::{pairing::Endpoint, Identity, MAX_RECORD};
use serde::Serialize;
use std::time::Duration;
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

const DEADLINE: Duration = Duration::from_secs(12);
const LEGACY_PATHS: [&str; 3] = ["/", "/api/auth/me", "/ws/machine"];

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    InvalidAddress,
    ConnectionFailed,
    IdentityUnverified,
    TimedOut,
}
impl Failure {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidAddress => "Use an HTTP or HTTPS Hub address without a path or credentials.",
            Self::ConnectionFailed => "Could not open the encrypted connection. Check the tunnel, HTTPS certificate and Hub version, then try again.",
            Self::IdentityUnverified => "This address could not be verified as this Hub. Check the tunnel destination before pairing.",
            Self::TimedOut => "The connection check timed out. Check that the Hub and tunnel are running, then try again.",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RouteCheck {
    pub path: &'static str,
    /// None means the request failed, not that the route was hidden.
    pub status: Option<u16>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub hub_url: String,
    pub identity_verified: bool,
    /// One Noise handshake round trip after the WebSocket has opened.
    /// Measured from the Hub machine, not from the phone.
    pub handshake_ms: Option<u64>,
    pub https: bool,
    pub legacy_routes: Vec<RouteCheck>,
    /// A snapshot of the sampled routes, not proof of relay configuration.
    pub legacy_routes_hidden: bool,
    pub failure: Option<Failure>,
}
impl Report {
    pub fn passed(&self, require_encrypted_only: bool) -> bool {
        self.identity_verified
            && (!require_encrypted_only || (self.https && self.legacy_routes_hidden))
    }
}

pub async fn check(endpoint: &Endpoint) -> Report {
    check_with_deadline(endpoint, DEADLINE).await
}

async fn check_with_deadline(endpoint: &Endpoint, deadline: Duration) -> Report {
    let valid = endpoint.validate().is_ok();
    let mut report = Report {
        // Invalid input may be a pasted sign-in URL containing a secret.
        hub_url: if valid {
            endpoint.hub_url.clone()
        } else {
            String::new()
        },
        identity_verified: false,
        handshake_ms: None,
        https: url::Url::parse(&endpoint.hub_url)
            .is_ok_and(|url| url.scheme() == "https"),
        legacy_routes: Vec::new(),
        legacy_routes_hidden: false,
        failure: None,
    };
    match timeout(deadline, verify_identity(endpoint)).await {
        Ok(Ok(ms)) => {
            report.identity_verified = true;
            report.handshake_ms = Some(ms);
        }
        result => {
            report.failure = Some(match result {
                Ok(Err(error)) => error,
                Err(_) => Failure::TimedOut,
                _ => unreachable!(),
            });
            return report;
        }
    }
    report.legacy_routes = inspect_legacy_routes(&endpoint.hub_url).await;
    report.legacy_routes_hidden = report.legacy_routes.len() == LEGACY_PATHS.len()
        && report
            .legacy_routes
            .iter()
            .all(|route| route.status == Some(404));
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::ws::{Message as AxumMessage, WebSocketUpgrade},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    async fn serve(router: Router, identity: &Identity) -> (Endpoint, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint {
            hub_url: format!("http://{}", listener.local_addr().unwrap()),
            public_key: URL_SAFE_NO_PAD.encode(identity.public()),
        };
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (endpoint, task)
    }

    fn encrypted_route(identity: Arc<Identity>, payload: &'static [u8]) -> Router {
        Router::new().route(
            "/ws/secure",
            get(move |ws: WebSocketUpgrade| {
                let identity = identity.clone();
                async move {
                    ws.on_upgrade(move |mut socket| async move {
                        let Some(Ok(AxumMessage::Binary(hello))) = socket.next().await else {
                            return;
                        };
                        let mut responder = identity.responder().unwrap();
                        responder
                            .read_message(&hello, &mut [0; MAX_RECORD])
                            .unwrap();
                        let mut wire = vec![0; MAX_RECORD];
                        let n = responder.write_message(payload, &mut wire).unwrap();
                        wire.truncate(n);
                        socket.send(AxumMessage::Binary(wire.into())).await.unwrap();
                        // There must be no transport message containing pairing data.
                        assert!(!matches!(
                            socket.next().await,
                            Some(Ok(AxumMessage::Binary(_)))
                        ));
                    })
                }
            }),
        )
    }

    #[tokio::test]
    async fn detects_legacy_routes_and_does_not_follow_login_redirects() {
        let identity = Arc::new(Identity::generate().unwrap());
        let follows = Arc::new(AtomicUsize::new(0));
        let count = follows.clone();
        let router = encrypted_route(identity.clone(), &[])
            .route("/", get(|| async { "ordinary web UI" }))
            .route(
                "/api/auth/me",
                get(|| async { axum::http::StatusCode::UNAUTHORIZED }),
            )
            .route(
                "/ws/machine",
                get(|| async {
                    (axum::http::StatusCode::FOUND, [("location", "/login")]).into_response()
                }),
            )
            .route(
                "/login",
                get(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        "login"
                    }
                }),
            );
        let (endpoint, task) = serve(router, &identity).await;
        let report = check(&endpoint).await;
        task.abort();
        assert!(report.identity_verified);
        assert!(report.handshake_ms.is_some());
        assert!(!report.legacy_routes_hidden);
        assert_eq!(
            report
                .legacy_routes
                .iter()
                .map(|r| r.status)
                .collect::<Vec<_>>(),
            vec![Some(200), Some(401), Some(302)]
        );
        assert_eq!(follows.load(Ordering::SeqCst), 0);
        assert!(report.passed(false));
        assert!(!report.passed(true));
    }

    #[tokio::test]
    async fn rejects_unexpected_handshake_payload_even_with_the_correct_key() {
        let identity = Arc::new(Identity::generate().unwrap());
        let (endpoint, task) =
            serve(encrypted_route(identity.clone(), b"unexpected"), &identity).await;
        let report = check(&endpoint).await;
        task.abort();
        assert_eq!(report.failure, Some(Failure::IdentityUnverified));
        assert!(!report.passed(false));
        assert!(report.legacy_routes.is_empty());
    }

    #[tokio::test]
    async fn a_stalled_peer_cannot_hold_a_check_open() {
        let identity = Identity::generate().unwrap();
        let router = Router::new().route(
            "/ws/secure",
            get(|ws: WebSocketUpgrade| async {
                ws.on_upgrade(|mut socket| async move {
                    // Read the hello, then wait without sending a handshake reply.
                    let _ = socket.next().await;
                    let _ = socket.next().await;
                })
            }),
        );
        let (endpoint, task) = serve(router, &identity).await;
        let report = check_with_deadline(&endpoint, Duration::from_millis(100)).await;
        task.abort();
        assert_eq!(report.failure, Some(Failure::TimedOut));
        assert!(!report.passed(false));
    }

    #[tokio::test]
    async fn invalid_sign_in_urls_are_rejected_without_echoing_the_secret() {
        let endpoint = Endpoint {
            hub_url: "https://hub.example/?token=secret-do-not-print".into(),
            public_key: URL_SAFE_NO_PAD.encode([1; 32]),
        };
        let report = check(&endpoint).await;
        assert_eq!(report.failure, Some(Failure::InvalidAddress));
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("secret-do-not-print"));
    }

    #[tokio::test]
    async fn failed_http_checks_do_not_count_as_hidden_routes() {
        // HTTP parse errors give no status; they must not become a 404 pass.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for _ in 0..3 {
                let (socket, _) = listener.accept().await.unwrap();
                drop(socket);
            }
        });
        let checks = inspect_legacy_routes(&base).await;
        task.await.unwrap();
        assert_eq!(checks.len(), 3);
        assert!(checks.iter().all(|r| r.status.is_none()));
        // HTTPS and a verified identity cannot waive failed boundary checks.
        let report = Report {
            hub_url: "https://hub.example".into(),
            identity_verified: true,
            handshake_ms: Some(1),
            https: true,
            legacy_routes: checks,
            legacy_routes_hidden: false,
            failure: None,
        };
        assert!(!report.passed(true));
    }
}

async fn verify_identity(endpoint: &Endpoint) -> Result<u64, Failure> {
    let url = endpoint
        .websocket_url()
        .map_err(|_| Failure::InvalidAddress)?;
    // A fresh disposable key cannot resume or pair an existing device. No
    // pairing secret, JWT or Hub private key is sent, even inside encryption.
    let identity = Identity::generate().map_err(|_| Failure::IdentityUnverified)?;
    let mut handshake = identity
        .initiator(&endpoint.key().map_err(|_| Failure::InvalidAddress)?)
        .map_err(|_| Failure::IdentityUnverified)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_RECORD))
        .max_frame_size(Some(MAX_RECORD));
    let (mut socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
        .await
        .map_err(|_| Failure::ConnectionFailed)?;
    let mut wire = vec![0; MAX_RECORD];
    let n = handshake
        .write_message(&[], &mut wire)
        .map_err(|_| Failure::IdentityUnverified)?;
    wire.truncate(n);
    let start = Instant::now();
    socket
        .send(Message::Binary(wire.into()))
        .await
        .map_err(|_| Failure::ConnectionFailed)?;
    loop {
        match socket.next().await {
            Some(Ok(Message::Binary(reply))) => {
                let n = handshake
                    .read_message(&reply, &mut [0; MAX_RECORD])
                    .map_err(|_| Failure::IdentityUnverified)?;
                if n != 0 || !handshake.is_handshake_finished() {
                    return Err(Failure::IdentityUnverified);
                }
                let ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
                // Drop the socket immediately: no authentication or database
                // mutation is necessary to prove possession of the pinned key.
                return Ok(ms);
            }
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                socket
                    .flush()
                    .await
                    .map_err(|_| Failure::ConnectionFailed)?;
            }
            _ => return Err(Failure::IdentityUnverified),
        }
    }
}

async fn inspect_legacy_routes(base: &str) -> Vec<RouteCheck> {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return Vec::new();
    };
    futures::future::join_all(LEGACY_PATHS.into_iter().map(|path| {
        let client = &client;
        async move {
            // No redirects, credentials, cookies, or response-body reads. An
            // Access login redirect / error page is not an encrypted-only pass.
            let status = client
                .get(format!("{}{path}", base.trim_end_matches('/')))
                .send()
                .await
                .ok()
                .map(|response| response.status().as_u16());
            RouteCheck { path, status }
        }
    }))
    .await
}

pub fn local_endpoint(database: &str, hub_url: &str) -> Result<Endpoint, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    if !crate::secure::store::key_path(database).exists() {
        return Err("Start an updated Hub before checking its encrypted connection.".into());
    }
    let identity = crate::secure::store::load_identity(database)?;
    Ok(Endpoint {
        hub_url: hub_url.trim_end_matches('/').to_owned(),
        public_key: URL_SAFE_NO_PAD.encode(identity.public()),
    })
}

pub fn print_report(report: &Report, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string(report).expect("serializable connection report")
        );
        return;
    }
    if let Some(failure) = report.failure {
        println!("{}", failure.message());
        return;
    }
    println!("Hub identity verified at {}", report.hub_url);
    println!(
        "Noise handshake: {} ms (from this computer, not your phone)",
        report.handshake_ms.unwrap_or_default()
    );
    for route in &report.legacy_routes {
        println!(
            "  {}: {}",
            route.path,
            route
                .status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "request failed".into())
        );
    }
    if !report.https {
        println!("Use HTTPS for a public tunnel.");
    }
    if !report.legacy_routes_hidden {
        println!("Ordinary routes were not all hidden. For an encrypted-only tunnel, route it to the Hub's --secure-listen port.");
    } else {
        println!("Sampled ordinary routes returned 404. Verify the tunnel configuration too; this is a point-in-time check.");
    }
}
