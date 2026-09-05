pub mod store;

use crate::{auth::AuthUser, AppState};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{Request as HttpRequest, StatusCode},
    response::{IntoResponse, Response as HttpResponse},
    routing::{delete, get},
    Json, Router,
};
#[cfg(test)]
use base64::Engine;
use futures::{SinkExt, StreamExt};
use offdesk_secure::{
    messages::{Authenticate, AuthenticationResult, Request, Response},
    Channel, Identity, MAX_MESSAGE, MAX_RECORD,
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, Mutex, Semaphore},
    task::JoinSet,
};
use tower::ServiceExt;

#[derive(Clone)]
struct SecureState {
    app: AppState,
    inner: Router,
    identity: Arc<Identity>,
    handshakes: Arc<Semaphore>,
}

pub fn router(app: AppState, inner: Router, database: &str) -> Result<Router, String> {
    let state = SecureState {
        app,
        inner,
        identity: Arc::new(store::load_identity(database)?),
        handshakes: Arc::new(Semaphore::new(32)),
    };
    Ok(Router::new()
        .route("/ws/secure", get(upgrade))
        .with_state(state))
}
pub fn management_router() -> Router<AppState> {
    Router::new()
        .route("/api/security/devices", get(list_devices))
        .route("/api/security/devices/{id}", delete(revoke_device))
}
async fn list_devices(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<store::Device>>, StatusCode> {
    let conn = state
        .db
        .get()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        store::list(&conn, &user.user_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}
async fn revoke_device(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let conn = state
        .db
        .get()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let revoked = store::revoke(&conn, &user.user_id, &id, crate::db::now_ms())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if revoked {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
async fn upgrade(State(state): State<SecureState>, ws: WebSocketUpgrade) -> HttpResponse {
    let Ok(permit) = state.handshakes.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.max_frame_size(MAX_RECORD)
        .max_message_size(MAX_RECORD)
        .on_upgrade(move |socket| async move {
            let mut socket = socket;
            let authenticated =
                tokio::time::timeout(Duration::from_secs(15), authenticate(&mut socket, &state))
                    .await;
            drop(permit);
            if let Ok(Ok((channel, device, public_key))) = authenticated {
                serve(socket, state, channel, device, public_key).await;
            }
        })
}
async fn binary(socket: &mut WebSocket) -> Result<Vec<u8>, String> {
    match socket.next().await {
        Some(Ok(Message::Binary(bytes))) if bytes.len() <= MAX_RECORD => Ok(bytes.to_vec()),
        _ => Err("Secure handshake interrupted".into()),
    }
}
async fn authenticate(
    socket: &mut WebSocket,
    state: &SecureState,
) -> Result<(Channel, store::Device, [u8; 32]), String> {
    let mut handshake = state.identity.responder().map_err(|e| e.to_string())?;
    let first = binary(socket).await?;
    let mut plain = vec![0; MAX_RECORD];
    if handshake
        .read_message(&first, &mut plain)
        .map_err(|e| e.to_string())?
        != 0
    {
        return Err("Handshake payloads are not supported".into());
    }
    let key: [u8; 32] = handshake
        .get_remote_static()
        .ok_or("Missing device identity")?
        .try_into()
        .map_err(|_| "Invalid device identity")?;
    let mut response = vec![0; MAX_RECORD];
    let n = handshake
        .write_message(&[], &mut response)
        .map_err(|e| e.to_string())?;
    response.truncate(n);
    socket
        .send(Message::Binary(response.into()))
        .await
        .map_err(|_| "Handshake interrupted")?;
    let mut channel = Channel::new(handshake.into_transport_mode().map_err(|e| e.to_string())?);
    // Require an initiator transport message before responding with any user
    // information. IK handshake payloads have weaker forward-secrecy properties.
    let record = binary(socket).await?;
    if record.len() > 4096 {
        return Err("Authentication request is too large".into());
    }
    let messages = channel.decode(&record).map_err(|e| e.to_string())?;
    if messages.len() != 1 {
        return Err("Invalid authentication request".into());
    }
    let auth: Authenticate =
        serde_json::from_slice(&messages[0]).map_err(|_| "Invalid authentication request")?;
    let device = (|| -> Result<store::Device, String> {
        let mut conn = state.app.db.get().map_err(|e| e.to_string())?;
        match auth {
            Authenticate::Pair { code, device_name } => {
                store::pair(&mut conn, &key, &code, &device_name, crate::db::now_ms())
            }
            Authenticate::Resume => store::active(&conn, &key)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    "This device is not paired or has been revoked. Scan a new pairing code.".into()
                }),
        }
    })();
    let answer = match &device {
        Ok(device) => AuthenticationResult::Ready {
            device_id: device.id.clone(),
        },
        Err(message) => AuthenticationResult::Rejected {
            message: message.clone(),
        },
    };
    let bytes = serde_json::to_vec(&answer).map_err(|e| e.to_string())?;
    for record in channel.encode(&bytes).map_err(|e| e.to_string())? {
        socket
            .send(Message::Binary(record.into()))
            .await
            .map_err(|_| "Authentication interrupted")?;
    }
    let device = device?;
    if let Ok(conn) = state.app.db.get() {
        let _ = conn.execute(
            "UPDATE secure_devices SET last_seen_at=?1 WHERE id=?2",
            rusqlite::params![crate::db::now_ms(), device.id],
        );
    }
    Ok((channel, device, key))
}

type Sockets = Arc<Mutex<HashMap<String, mpsc::Sender<tokio_tungstenite::tungstenite::Message>>>>;
async fn serve(
    socket: WebSocket,
    state: SecureState,
    channel: Channel,
    device: store::Device,
    key: [u8; 32],
) {
    let (writer, mut reader) = socket.split();
    let channel = Arc::new(Mutex::new(channel));
    let (out_tx, out_rx) = offdesk_secure::outbound::queue();
    let write_channel = channel.clone();
    let mut write_task = tokio::spawn(async move {
        let _ = out_rx.run(writer, write_channel, |record| Message::Binary(record.into())).await;
    });
    let token = crate::auth::sign_jwt(&device.user_id, &state.app.jwt_secret);
    let sockets: Sockets = Arc::new(Mutex::new(HashMap::new()));
    let http_slots = Arc::new(Semaphore::new(16));
    let mut tasks = JoinSet::new();
    let mut revocations = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = &mut write_task => break,
            _ = revocations.tick() => {
                let active = state.app.db.get().ok().and_then(|conn| store::active(&conn, &key).ok()).flatten();
                if active.is_none() { break; }
            }
            Some(_) = tasks.join_next() => {},
            incoming = reader.next() => {
                let records = match incoming {
                    Some(Ok(Message::Binary(record))) => record,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    _ => break,
                };
                let Ok(messages) = channel.lock().await.decode(&records) else { break; };
                let mut valid = true;
                for bytes in messages {
                    let Ok(request) = offdesk_secure::wire::request(&bytes) else { valid = false; break; };
                    dispatch(request, &state, &token, &sockets, &out_tx, &http_slots, &mut tasks).await;
                }
                if !valid { break; }
            }
        }
    }
    write_task.abort();
    tasks.abort_all();
    sockets.lock().await.clear();
}

async fn error(out: &offdesk_secure::outbound::Sender, id: String, message: &str) {
    let _ = out.try_send(Response::Error {
        id,
        message: message.into(),
    });
}
fn api_path(path: &str) -> bool {
    path.starts_with("/api/") && !path.contains('#') && !path.contains('\\') && path.len() < 8192
}
fn websocket_url(path: &str, token: &str) -> Result<url::Url, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') || path.len() > 8192
    {
        return Err("Invalid socket path".into());
    }
    let mut url = url::Url::parse("ws://offdesk.internal")
        .unwrap()
        .join(path)
        .map_err(|_| "Invalid socket path")?;
    let allowed = matches!(url.path(), "/ws/events" | "/ws/terminal-previews")
        || url.path().starts_with("/ws/terminal/");
    if !allowed || url.host_str() != Some("offdesk.internal") || url.fragment().is_some() {
        return Err("Unsupported socket path".into());
    }
    let query: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "token" && key != "api_token")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(query)
        .append_pair("token", token);
    Ok(url)
}
async fn dispatch(
    request: Request,
    state: &SecureState,
    token: &str,
    sockets: &Sockets,
    out: &offdesk_secure::outbound::Sender,
    slots: &Arc<Semaphore>,
    tasks: &mut JoinSet<()>,
) {
    match request {
        Request::Ping { id } => {
            if id.len() <= 64 {
                let _ = out.try_send(Response::Pong { id });
            }
        }
        Request::Http {
            id,
            method,
            path,
            body,
        } => {
            if id.len() > 64
                || !api_path(&path)
                || !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
            {
                error(out, id, "Invalid API request").await;
                return;
            }
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                error(out, id, "Too many pending requests").await;
                return;
            };
            let request = HttpRequest::builder()
                .method(method.as_str())
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.unwrap_or_default()));
            let Ok(request) = request else {
                error(out, id, "Invalid API request").await;
                return;
            };
            let router = state.inner.clone();
            let out = out.clone();
            tasks.spawn(async move {
                let response =
                    tokio::time::timeout(Duration::from_secs(30), router.oneshot(request)).await;
                let answer = match response {
                    Ok(Ok(response)) => {
                        let status = response.status().as_u16();
                        match to_bytes(response.into_body(), MAX_MESSAGE - 1024).await {
                            Ok(bytes) => match String::from_utf8(bytes.to_vec()) {
                                Ok(body) => Response::Http { id, status, body },
                                Err(_) => Response::Error {
                                    id,
                                    message: "Unsupported binary API response".into(),
                                },
                            },
                            Err(_) => Response::Error {
                                id,
                                message: "API response is too large".into(),
                            },
                        }
                    }
                    _ => Response::Error {
                        id,
                        message: "Hub request timed out".into(),
                    },
                };
                drop(permit);
                let _ = out.send(answer).await;
            });
        }
        Request::Open { id, path } => {
            let url = match websocket_url(&path, token) {
                Ok(url) => url,
                Err(reason) => {
                    error(out, id, &reason).await;
                    return;
                }
            };
            let mut entries = sockets.lock().await;
            if id.len() > 64 || entries.len() >= 32 || entries.contains_key(&id) {
                drop(entries);
                error(out, id, "Invalid or duplicate socket").await;
                return;
            }
            let (send, mut receive) = mpsc::channel(32);
            entries.insert(id.clone(), send);
            drop(entries);
            let sockets = sockets.clone();
            let router = state.inner.clone();
            let out = out.clone();
            tasks.spawn(async move {
                // Run the existing WebSocket handlers on an in-process duplex
                // HTTP connection. No credentials or decrypted bytes traverse
                // a loopback TCP port, the relay, or an HTTP proxy.
                let (server_io, client_io) = tokio::io::duplex(64 * 1024);
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(server_io), hyper_util::service::TowerToHyperService::new(router))
                        .with_upgrades().await;
                });
                let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
                config.max_message_size = Some(MAX_MESSAGE);
                config.max_frame_size = Some(MAX_MESSAGE);
                let connected = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::client_async_with_config(url.as_str(), client_io, Some(config))).await;
                if let Ok(Ok((mut socket, _))) = connected {
                    let _ = out.send(Response::Opened { id: id.clone() }).await;
                    loop {
                        tokio::select! {
                            message = receive.recv() => match message {
                                Some(message) => { if socket.send(message).await.is_err() { break; } },
                                None => break,
                            },
                            message = socket.next() => {
                                use tokio_tungstenite::tungstenite::Message as WsMessage;
                                let response = match message {
                                    Some(Ok(WsMessage::Text(data))) => Response::Text { id: id.clone(), data: data.to_string() },
                                    Some(Ok(WsMessage::Binary(data))) => Response::Binary { id: id.clone(), data: data.to_vec() },
                                    Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => continue,
                                    _ => break,
                                };
                                if out.send(response).await.is_err() { break; }
                            }
                        }
                    }
                } else { error(&out,id.clone(),"Could not open the Hub socket").await; }
                sockets.lock().await.remove(&id);
                let _ = out.send(Response::Closed { id }).await;
            });
        }
        Request::Text { id, data } => {
            let sender = sockets.lock().await.get(&id).cloned();
            if let Some(sender) = sender {
                if sender
                    .try_send(tokio_tungstenite::tungstenite::Message::Text(data.into()))
                    .is_err()
                {
                    sockets.lock().await.remove(&id);
                    error(out, id, "Socket is backpressured; reconnect before sending").await;
                }
            } else {
                error(out, id, "Socket is closed").await;
            }
        }
        Request::Binary { id, data } => {
            let sender = sockets.lock().await.get(&id).cloned();
            if let Some(sender) = sender {
                if sender
                    .try_send(tokio_tungstenite::tungstenite::Message::Binary(
                        data.into(),
                    ))
                    .is_err()
                {
                    sockets.lock().await.remove(&id);
                    error(out, id, "Socket is backpressured; reconnect before sending").await;
                }
            } else {
                error(out, id, "Invalid binary socket message").await;
            }
        }
        Request::Close { id } => {
            sockets.lock().await.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_secure::{client::Client, pairing::Endpoint};
    #[tokio::test]
    async fn encrypted_only_endpoint_pairs_proxies_http_and_websockets_and_enforces_revocation() {
        let root =
            std::env::temp_dir().join(format!("offdesk-secure-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let database = root.join("hub.db");
        let database = database.to_str().unwrap();
        let pool = crate::db::create_pool(database).unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
            crate::db::users::create_user(
                &conn,
                "secure-owner",
                "test",
                "secure-owner",
                "Secure owner",
                None,
                "admin",
            )
            .unwrap();
        }
        let state = AppState {
            manager: Arc::new(crate::machine_manager::MachineManager::new(pool.clone())),
            router: Arc::new(crate::attach_router::HubRouter::new()),
            db: pool.clone(),
            jwt_secret: "isolated-encrypted-test".into(),
            base_url: "https://remote.example".into(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        };
        let inner = crate::routes::router()
            .merge(crate::connections::router("0.0.0.0:4317".into(), None))
            .merge(crate::ws::router())
            .route("/ws/terminal/secure-test-echo", get(|ws: WebSocketUpgrade| async {
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(Message::Binary(bytes))) = socket.next().await {
                        if socket.send(Message::Binary(bytes)).await.is_err() { break; }
                    }
                })
            }))
            .with_state(state.clone());
        let denied = inner.clone().oneshot(HttpRequest::builder().uri("/api/connection-routes").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED, "LAN metadata is not public");
        let encrypted = router(state, inner, database).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let serving = tokio::spawn(async move {
            axum::serve(listener, encrypted).await.unwrap();
        });
        assert_eq!(
            reqwest::get(format!("{base}/api/auth/me"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        // Preflight proves this local Hub identity without minting a code or
        // registering a device, and observes the dedicated listener's boundary.
        let checked_endpoint = crate::tunnel_check::local_endpoint(database, &base).unwrap();
        let report = crate::tunnel_check::check(&checked_endpoint).await;
        assert!(report.identity_verified);
        assert!(report.legacy_routes_hidden);
        assert!(report.passed(false));
        assert!(!report.passed(true)); // Local HTTP is not a public HTTPS tunnel.
        {
            let conn = pool.get().unwrap();
            let counts: (i64, i64) = conn.query_row(
                "SELECT (SELECT COUNT(*) FROM secure_devices), (SELECT COUNT(*) FROM secure_pairing_codes)",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(counts, (0, 0));
        }
        let wrong_key = Endpoint { hub_url: base.clone(), public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Identity::generate().unwrap().public()) };
        let wrong_report = crate::tunnel_check::check(&wrong_key).await;
        assert!(!wrong_report.identity_verified);
        assert!(wrong_report.legacy_routes.is_empty());
        // Model a relay that terminates the outer WebSocket and records all
        // traffic in both directions. It has no Hub or device private key.
        let relay_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_base = format!("http://{}", relay_listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let relay_captured = captured.clone();
        let origin = base.replace("http:", "ws:") + "/ws/secure";
        let relay = tokio::spawn(async move {
            while let Ok((io, _)) = relay_listener.accept().await {
                let origin = origin.clone();
                let captured = relay_captured.clone();
                tokio::spawn(async move {
                    let Ok(mut client) = tokio_tungstenite::accept_async(io).await else {
                        return;
                    };
                    let Ok((mut hub, _)) = tokio_tungstenite::connect_async(origin).await else {
                        return;
                    };
                    loop {
                        tokio::select! {
                            message = client.next() => match message {
                                Some(Ok(message)) => {
                                    captured.lock().await.push(message.clone().into_data().to_vec());
                                    if hub.send(message).await.is_err() { break; }
                                }, _ => break,
                            },
                            message = hub.next() => match message {
                                Some(Ok(message)) => {
                                    captured.lock().await.push(message.clone().into_data().to_vec());
                                    if client.send(message).await.is_err() { break; }
                                }, _ => break,
                            },
                        }
                    }
                });
            }
        });
        let hub = store::load_identity(database).unwrap();
        let endpoint = Endpoint {
            hub_url: relay_base,
            public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hub.public()),
        };
        let (descriptor, _) = store::mint(
            &pool.get().unwrap(),
            "secure-owner",
            &base,
            &hub,
            crate::db::now_ms(),
        )
        .unwrap();
        let phone = Identity::generate().unwrap();
        let (client, device_id) = Client::connect(
            &endpoint,
            &phone,
            Authenticate::Pair {
                code: descriptor.code,
                device_name: "Test phone".into(),
            },
        )
        .await
        .unwrap();
        match client
            .request("GET".into(), "/api/auth/me".into(), None)
            .await
            .unwrap()
        {
            Response::Http { status, body, .. } => {
                assert_eq!(status, 200);
                assert!(body.contains("Secure owner"));
            }
            _ => panic!("expected HTTP response"),
        }
        // The same QR-paired device resumes directly after pairing via relay.
        // No second code, user, or device is created for the alternate origin.
        let direct = Endpoint { hub_url: base.clone(), public_key: endpoint.public_key.clone() };
        let (alternate, alternate_id) = Client::connect(&direct, &phone, Authenticate::Resume).await.unwrap();
        assert_eq!(alternate_id, device_id);
        match alternate.request("GET".into(), "/api/connection-routes".into(), None).await.unwrap() {
            Response::Http { status: 200, body, .. } => {
                let routes: Vec<offdesk_secure::routes::Route> = serde_json::from_str(&body).unwrap();
                assert!(routes.iter().any(|r| r.hub_url == "https://remote.example"));
            }
            _ => panic!("expected authenticated route discovery"),
        }
        assert_eq!(store::list(&pool.get().unwrap(), "secure-owner").unwrap().len(), 1);
        alternate.close();
        assert!(Client::connect(&wrong_key, &phone, Authenticate::Resume).await.is_err());
        // A failed alternate handshake does not close the current route.
        let mut events = client
            .open_socket("events".into(), "/ws/events?device_id=secure-test".into())
            .await
            .unwrap();
        assert!(matches!(events.recv().await, Some(Response::Opened { .. })));
        client
            .socket_text("events".into(), r#"{"type":"ping","t":42}"#.into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match events.recv().await {
                    Some(Response::Text { data, .. }) if data.contains("pong") => {
                        assert!(data.contains("42"));
                        break;
                    }
                    Some(_) => {}
                    None => panic!("event stream closed before pong"),
                }
            }
        })
        .await
        .unwrap();
        let mut binary = client.open_socket("binary".into(), "/ws/terminal/secure-test-echo".into()).await.unwrap();
        assert!(matches!(binary.recv().await, Some(Response::Opened { .. })));
        let bytes: Vec<u8> = (0..100 * 1024).map(|n| (n % 256) as u8).collect();
        client.socket_binary("binary".into(), base64::engine::general_purpose::STANDARD.encode(&bytes)).await.unwrap();
        let answer = tokio::time::timeout(Duration::from_secs(5), binary.recv()).await.unwrap();
        assert!(matches!(answer, Some(Response::Binary { data, .. }) if data == bytes));
        client.close_socket("binary".into()).await.unwrap();
        client.close();
        let (resumed, _) = Client::connect(&endpoint, &phone, Authenticate::Resume)
            .await
            .unwrap();
        let _ = resumed
            .request(
                "DELETE".into(),
                format!("/api/security/devices/{device_id}"),
                None,
            )
            .await;
        tokio::time::timeout(Duration::from_secs(4), async {
            while !resumed.is_closed() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert!(Client::connect(&endpoint, &phone, Authenticate::Resume)
            .await
            .is_err());
        let captured = captured.lock().await;
        for record in captured.iter() {
            for plaintext in [
                b"Secure owner".as_slice(),
                b"Test phone",
                b"/api/auth/me",
                b"device_id",
                b"pong",
            ] {
                assert!(!record
                    .windows(plaintext.len())
                    .any(|bytes| bytes == plaintext));
            }
        }
        assert!(!captured.is_empty());
        relay.abort();
        serving.abort();
        let _ = serving.await;
        drop(pool);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn virtual_sockets_cannot_access_machine_registration_or_other_origins() {
        assert!(websocket_url("/ws/machine", "token").is_err());
        assert!(websocket_url("//elsewhere/ws/events", "token").is_err());
        assert!(websocket_url("/ws/terminal/a/../../machine", "token").is_err());
        let url = websocket_url("/ws/events?token=untrusted&device_id=phone", "internal").unwrap();
        assert_eq!(url.query_pairs().filter(|(k, _)| k == "token").count(), 1);
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "token").unwrap().1,
            "internal"
        );
    }
}
