use super::*;
use axum::{extract::ws::WebSocketUpgrade, routing::any};
use futures::{SinkExt, StreamExt};
use registry::{Config, Registry};
use std::time::Duration;

struct Fixture {
    state: AppState,
    base: String,
    port: u16,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        {
            let c = pool.get().unwrap();
            crate::db::init_db(&c).unwrap();
            crate::db::users::create_user(&c, "u", "test", "u", "User", None, "admin").unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = AppState {
            manager: Arc::new(crate::machine_manager::MachineManager::new(pool.clone())),
            router: Arc::new(crate::attach_router::HubRouter::new()),
            db: pool,
            web_previews: Arc::new(Registry::configured(
                Config::new("preview.test", &base).unwrap(),
            )),
            jwt_secret: "test".into(),
            base_url: base.clone(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        };
        let (_, mut commands) = state
            .manager
            .register_machine_with_capabilities(
                offdesk_protocol::MachineInfo {
                    id: "m".into(),
                    name: "machine".into(),
                    os: "linux".into(),
                    home_dir: "/tmp".into(),
                    production: false,
                },
                Some("u".into()),
                vec![offdesk_protocol::preview::CAPABILITY.into()],
            )
            .await;
        let hub = base.replace("http://", "ws://") + "/ws/machine";
        let node = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            while let Some(cmd) = commands.recv().await {
                while tasks.try_join_next().is_some() {}
                if let offdesk_protocol::HubToMachine::OpenPreviewStream {
                    stream_id,
                    ticket,
                    port,
                    address_family,
                    expires_at,
                } = cmd
                {
                    let hub = hub.clone();
                    tasks.spawn(async move {
                        offdesk_preview_transport::connect(
                            &hub,
                            &stream_id,
                            &ticket,
                            port,
                            address_family,
                            expires_at,
                        )
                        .await
                    });
                }
            }
        });
        let app = router()
            .route("/api/control-only", get(|| async { "hub-secret" }))
            .layer(tower_http::cors::CorsLayer::permissive())
            .with_state(state.clone())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                dispatch,
            ));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = upstream.local_addr().unwrap().port();
        let app = Router::new()
            .route(
                "/echo",
                any(|req: Request| async move {
                    let headers = req.headers().clone();
                    let body = axum::body::to_bytes(req.into_body(), 2_000_000)
                        .await
                        .unwrap();
                    let mut response = Body::from(body).into_response();
                    response.headers_mut().insert(
                        "x-seen-cookie",
                        headers
                            .get("cookie")
                            .cloned()
                            .unwrap_or(HeaderValue::from_static("none")),
                    );
                    response
                        .headers_mut()
                        .insert("x-seen-host", headers["host"].clone());
                    response.headers_mut().append(
                        "set-cookie",
                        HeaderValue::from_static("app=1; Domain=localhost; Path=/; HttpOnly"),
                    );
                    response
                        .headers_mut()
                        .append("set-cookie", HeaderValue::from_static("other=2; Path=/"));
                    response.headers_mut().append(
                        "set-cookie",
                        HeaderValue::from_static("__Host-offdesk-preview=attack; Path=/; Secure"),
                    );
                    response
                }),
            )
            .route("/big", get(|| async { vec![42u8; 1_048_576] }))
            .route(
                "/sse",
                get(|| async {
                    Body::from_stream(futures::stream::unfold(0, |n| async move {
                        if n == 3 {
                            return None;
                        }
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        Some((Ok::<_, std::io::Error>(format!("data: {n}\n\n")), n + 1))
                    }))
                }),
            )
            .route(
                "/ws",
                get(|ws: WebSocketUpgrade| async {
                    ws.protocols(["hmr"]).on_upgrade(|mut ws| async move {
                        while let Some(Ok(msg)) = ws.recv().await {
                            if ws.send(msg).await.is_err() {
                                break;
                            }
                        }
                    })
                }),
            );
        let upstream = tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        });
        Self {
            state,
            base,
            port,
            tasks: vec![server, node, upstream],
        }
    }
    fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    async fn lease(&self) -> (Arc<registry::Lease>, String) {
        let (conn, tx, cancel) = self
            .state
            .manager
            .preview_connection("u", "m")
            .await
            .unwrap();
        self.state
            .web_previews
            .create(
                "u".into(),
                "m".into(),
                conn,
                tx,
                cancel,
                self.port,
                AddressFamily::Ipv4,
                "/echo?x=1#anchor".into(),
            )
            .unwrap()
    }
    fn request(
        &self,
        lease: &registry::Lease,
        session: &str,
        path: &str,
    ) -> reqwest::RequestBuilder {
        self.client()
            .get(format!("{}{path}", self.base))
            .header("Host", &lease.hostname)
            .header("Cookie", format!("{}={session}", registry::COOKIE))
            .header("Sec-Fetch-Site", "same-origin")
    }
}

#[tokio::test]
async fn streams_binary_upload_download_and_frees_keepalive_connections() {
    let f = Fixture::new().await;
    let (lease, code) = f.lease().await;
    let session = lease.redeem(&code).unwrap();
    let bytes = vec![173u8; 900_000];
    let response = f
        .client()
        .post(format!("{}/echo", f.base))
        .header("host", &lease.hostname)
        .header("origin", &lease.origin)
        .header(
            "cookie",
            format!("app=local; {}={session}", registry::COOKIE),
        )
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-seen-cookie"], "app=local");
    assert_eq!(response.headers()["x-seen-host"], lease.hostname);
    let cookies: Vec<_> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|h| h.to_str().unwrap())
        .collect();
    assert_eq!(cookies.len(), 2);
    assert!(cookies
        .iter()
        .all(|c| !c.contains("Domain") && !c.contains(registry::COOKIE)));
    assert_eq!(response.bytes().await.unwrap().as_ref(), &bytes);
    for _ in 0..40 {
        let response = f.request(&lease, &session, "/big").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            vec![42; 1_048_576]
        );
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(f.state.web_previews.streams.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_cross_origin_cookie_replay_unknown_host_and_hub_api_on_preview() {
    let f = Fixture::new().await;
    let (lease, code) = f.lease().await;
    let endpoint = format!("{}/__offdesk_preview__/redeem", f.base);
    let response = f
        .client()
        .post(&endpoint)
        .header("host", &lease.hostname)
        .header("origin", "https://sibling.preview.test")
        .json(&serde_json::json!({"code": code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = f
        .client()
        .post(&endpoint)
        .header("host", &lease.hostname)
        .header("origin", &lease.origin)
        .json(&serde_json::json!({"code": code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert!(lease.redeem(&code).is_none());
    let session = cookie.split_once('=').unwrap().1;
    let blocked = f
        .request(&lease, session, "/echo")
        .header("origin", "https://sibling.preview.test")
        .send()
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    let duplicate = f
        .request(&lease, session, "/echo")
        .header("cookie", format!("{cookie}; {cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::UNAUTHORIZED);
    let response = f
        .request(&lease, session, "/api/control-only")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(!response
        .headers()
        .contains_key("access-control-allow-origin"));
    assert_eq!(
        f.client()
            .get(&f.base)
            .header("host", "unknown.test")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::MISDIRECTED_REQUEST
    );
    assert!(!f.state.web_previews.revoke("other", &lease.id));
    assert!(f.state.web_previews.revoke("u", &lease.id));
    assert_eq!(
        f.request(&lease, session, "/echo")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::GONE
    );
}

#[tokio::test]
async fn websocket_subprotocol_binary_and_revocation() {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let f = Fixture::new().await;
    let (lease, code) = f.lease().await;
    let session = lease.redeem(&code).unwrap();
    let mut request = format!("{}/ws", f.base.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("host", lease.hostname.parse().unwrap());
    request
        .headers_mut()
        .insert("origin", lease.origin.parse().unwrap());
    request.headers_mut().insert(
        "cookie",
        format!("{}={session}", registry::COOKIE).parse().unwrap(),
    );
    request
        .headers_mut()
        .insert("sec-websocket-protocol", "hmr".parse().unwrap());
    let (mut ws, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "hmr");
    ws.send(Message::Binary(vec![0, 255, 9].into()))
        .await
        .unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap(),
        Message::Binary(vec![0, 255, 9].into())
    );
    f.state.web_previews.revoke("u", &lease.id);
    let result = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap();
    assert!(result.is_none() || result.unwrap().is_err());
}

#[tokio::test]
async fn sse_is_incremental_and_reconnect_cancels_old_lease() {
    let f = Fixture::new().await;
    let (lease, code) = f.lease().await;
    let session = lease.redeem(&code).unwrap();
    let mut response = f.request(&lease, &session, "/sse").send().await.unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "data: 0\n\n");
    let conn = lease.conn_id.clone();
    f.state.manager.unregister_machine("m", &conn).await;
    assert!(!lease.live());
    assert!(f.state.web_previews.find(&lease.hostname).is_none());
    tokio::time::timeout(Duration::from_secs(1), async {
        while !f.tasks[1].is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("an inactive preview must not keep the node command channel alive");
}

#[test]
fn target_origin_and_dns_validation() {
    for target in [
        "//evil.test/",
        "/\\evil.test",
        "https://evil.test",
        "/__offdesk_preview__/redeem",
        "/../__offdesk_preview__/bootstrap",
    ] {
        assert!(!valid_target(target), "{target}");
    }
    assert!(valid_target("/page?a=1#part"));
    assert!(Config::new("preview.test", "https://hub.example.test").is_ok());
    assert!(Config::new("example.test", "https://hub.example.test").is_err());
    assert!(Config::new("127.0.0.1", "https://hub.test").is_err());
}

#[tokio::test]
async fn management_requires_owner_and_old_nodes_are_not_sent_preview_commands() {
    let f = Fixture::new().await;
    let url = format!("{}/api/machines/m/web-previews", f.base);
    let body = serde_json::json!({ "port": f.port, "target": "/" });
    assert_eq!(
        f.client()
            .post(&url)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let other = crate::auth::sign_jwt("other", "test");
    assert_eq!(
        f.client()
            .post(&url)
            .bearer_auth(other)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let token = crate::auth::sign_jwt("u", "test");
    let response = f
        .client()
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (_, _old_commands) = f
        .state
        .manager
        .register_machine(
            offdesk_protocol::MachineInfo {
                id: "m".into(),
                name: "old-node".into(),
                os: "linux".into(),
                home_dir: "/tmp".into(),
                production: false,
            },
            Some("u".into()),
        )
        .await;
    assert_eq!(
        f.client()
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(f
        .state
        .web_previews
        .leases
        .lock()
        .unwrap()
        .values()
        .all(|l| !l.live()));
}

#[tokio::test]
async fn stream_tickets_are_single_use_expire_and_release_their_budgets() {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error, Message};
    let f = Fixture::new().await;
    let (lease, _) = f.lease().await;
    let (guard, ticket, _rx) = f.state.web_previews.allocate(lease.clone()).unwrap();
    let request = || {
        let mut request = format!(
            "{}/ws/preview-stream/{}",
            f.base.replace("http://", "ws://"),
            guard.id
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {ticket}").parse().unwrap());
        request
    };
    let (mut ws, _) = tokio_tungstenite::connect_async(request()).await.unwrap();
    let repeated = tokio_tungstenite::connect_async(request())
        .await
        .unwrap_err();
    assert!(matches!(repeated, Error::Http(r) if r.status() == StatusCode::UNAUTHORIZED));
    ws.send(Message::Text("unavailable".into())).await.unwrap();
    drop(guard);
    let (guard, ticket, _) = f.state.web_previews.allocate(lease.clone()).unwrap();
    f.state
        .web_previews
        .streams
        .lock()
        .unwrap()
        .get_mut(&guard.id)
        .unwrap()
        .deadline = std::time::Instant::now() - Duration::from_secs(1);
    let mut expired = format!(
        "{}/ws/preview-stream/{}",
        f.base.replace("http://", "ws://"),
        guard.id
    )
    .into_client_request()
    .unwrap();
    expired
        .headers_mut()
        .insert("authorization", format!("Bearer {ticket}").parse().unwrap());
    assert!(
        matches!(tokio_tungstenite::connect_async(expired).await.unwrap_err(), Error::Http(r) if r.status() == StatusCode::UNAUTHORIZED)
    );
    drop(guard);
    let guards: Vec<_> = (0..32)
        .map(|_| f.state.web_previews.allocate(lease.clone()).unwrap().0)
        .collect();
    assert!(f.state.web_previews.allocate(lease).is_err());
    drop(guards);
    assert!(f.state.web_previews.streams.lock().unwrap().is_empty());
}

#[test]
fn control_routes_keep_lan_and_aliases_without_opening_preview_hosts() {
    let mut config = Config::new("preview.test", "https://hub.test").unwrap();
    config.listener = Some("0.0.0.0:4317".parse().unwrap());
    config.add_control_origin("https://remote.test").unwrap();
    config
        .add_control_origin("http://mac-mini.local:4317")
        .unwrap();
    let ips = ["192.168.1.94".parse().unwrap()];
    for host in [
        "hub.test",
        "remote.test",
        "mac-mini.local:4317",
        "localhost:4317",
        "127.0.0.1:4317",
        "192.168.1.94:4317",
    ] {
        assert!(config.allows_control(host, &ips), "{host}");
    }
    for host in [
        "unknown.test",
        "192.168.1.95:4317",
        "192.168.1.94:4318",
        "p-abc.preview.test",
        "preview.test",
        "192.168.1.94:4317/path",
        "user@192.168.1.94:4317",
    ] {
        assert!(!config.allows_control(host, &ips), "{host}");
    }
    assert!(
        !config.allows_control("192.168.1.94:4317", &[]),
        "an old DHCP address stops being accepted"
    );
    for origin in [
        "https://p-abc.preview.test",
        "https://preview.test",
        "https://remote.test/path",
        "https://user@remote.test",
        "file:///tmp",
    ] {
        assert!(config.add_control_origin(origin).is_err(), "{origin}");
    }
    config.listener = Some("127.0.0.1:4317".parse().unwrap());
    assert!(!config.allows_control("192.168.1.94:4317", &ips));
    let ipv6 = Config::new("preview.test", "http://[::1]:4317").unwrap();
    assert!(ipv6.allows_control("[::1]:4317", &[]));
}
