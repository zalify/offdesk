//! Native client. Decrypted messages are delivered only to the bundled App's
//! IPC bridge; no remote JavaScript receives keys or raw credentials.
use crate::{
    messages::{Authenticate, AuthenticationResult, Request, Response},
    pairing::Endpoint,
    Channel, Identity, MAX_RECORD,
};
use futures::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

type Pending = oneshot::Sender<Result<Response, String>>;
struct Inner {
    outbound: crate::outbound::Sender,
    pending: Mutex<HashMap<String, Pending>>,
    sockets: Mutex<HashMap<String, mpsc::Sender<Response>>>,
    stop: watch::Sender<bool>,
    closed: AtomicBool,
    started: Instant,
    last_received: AtomicU64,
}
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    pub async fn connect(
        endpoint: &Endpoint,
        identity: &Identity,
        authenticate: Authenticate,
    ) -> Result<(Self, String), String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = endpoint.websocket_url()?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_RECORD))
            .max_frame_size(Some(MAX_RECORD));
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async_with_config(url, Some(config), false),
        )
        .await
        .map_err(|_| "Could not reach the Hub")?
        .map_err(|_| "Could not open the encrypted connection")?;
        let mut handshake = identity
            .initiator(&endpoint.key()?)
            .map_err(|e| e.to_string())?;
        let mut wire = vec![0; MAX_RECORD];
        let n = handshake
            .write_message(&[], &mut wire)
            .map_err(|e| e.to_string())?;
        wire.truncate(n);
        socket
            .send(Message::Binary(wire.into()))
            .await
            .map_err(|_| "Connection interrupted")?;
        let hello = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .map_err(|_| "Hub handshake timed out")?;
        let Some(Ok(Message::Binary(hello))) = hello else {
            return Err("Hub identity could not be verified".into());
        };
        let n = handshake
            .read_message(&hello, &mut [0; MAX_RECORD])
            .map_err(|_| {
                "Hub identity changed or could not be verified. Re-pair from the Hub's own screen."
            })?;
        if n != 0 {
            return Err("Unsupported handshake payload".into());
        }
        let mut channel = Channel::new(handshake.into_transport_mode().map_err(|e| e.to_string())?);
        let bytes = serde_json::to_vec(&authenticate).map_err(|e| e.to_string())?;
        if bytes.len() > 3000 {
            return Err("Invalid authentication request".into());
        }
        for record in channel.encode(&bytes).map_err(|e| e.to_string())? {
            socket
                .send(Message::Binary(record.into()))
                .await
                .map_err(|_| "Connection interrupted")?;
        }
        let answer = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await
            .map_err(|_| "Hub authentication timed out")?;
        let Some(Ok(Message::Binary(answer))) = answer else {
            return Err("Hub authentication failed".into());
        };
        let messages = channel.decode(&answer).map_err(|e| e.to_string())?;
        if messages.len() != 1 {
            return Err("Invalid Hub authentication response".into());
        }
        let device_id = match serde_json::from_slice::<AuthenticationResult>(&messages[0])
            .map_err(|_| "Invalid authentication response")?
        {
            AuthenticationResult::Ready { device_id } => device_id,
            AuthenticationResult::Rejected { message } => return Err(message),
        };
        Ok((Self::start(socket, channel), device_id))
    }
    fn start<S>(socket: tokio_tungstenite::WebSocketStream<S>, channel: Channel) -> Self
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (outbound, outgoing) = crate::outbound::queue();
        let (stop, mut write_stop) = watch::channel(false);
        let inner = Arc::new(Inner {
            outbound,
            pending: Mutex::new(HashMap::new()),
            sockets: Mutex::new(HashMap::new()),
            stop,
            closed: AtomicBool::new(false),
            started: Instant::now(),
            last_received: AtomicU64::new(0),
        });
        let client = Self {
            inner: inner.clone(),
        };
        let (writer, mut reader) = socket.split();
        let channel = Arc::new(Mutex::new(channel));
        let write_channel = channel.clone();
        let write_inner = inner.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = write_stop.changed() => {},
                _ = outgoing.run(writer, write_channel, |record| Message::Binary(record.into())) => {},
            }
            fail(&write_inner).await;
        });
        let heartbeat = client.clone();
        let mut heartbeat_stop = inner.stop.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(5));
            loop {
                if heartbeat.is_closed() {
                    break;
                }
                tokio::select! {
                    _ = heartbeat_stop.changed() => break,
                    _ = timer.tick() => {},
                }
                // Only authenticated Noise records update this clock. A relay
                // cannot keep a dead session alive with outer WS Ping/Pong.
                let idle = heartbeat
                    .inner
                    .started
                    .elapsed()
                    .as_secs()
                    .saturating_sub(heartbeat.inner.last_received.load(Ordering::Relaxed));
                if idle > 60 {
                    heartbeat.close();
                    break;
                }
                if heartbeat
                    .inner
                    .outbound
                    .try_send(Request::Ping {
                        id: "heartbeat".into(),
                    })
                    .is_err()
                    && heartbeat.is_closed()
                {
                    break;
                }
            }
        });
        let mut read_stop = inner.stop.subscribe();
        tokio::spawn(async move {
            loop {
                if inner.closed.load(Ordering::SeqCst) {
                    break;
                }
                let incoming = tokio::select! {
                    _ = read_stop.changed() => break,
                    incoming = reader.next() => incoming,
                };
                let record = match incoming {
                    Some(Ok(Message::Binary(record))) => record,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    _ => break,
                };
                let messages = match channel.lock().await.decode(&record) {
                    Ok(messages) => messages,
                    Err(_) => break,
                };
                inner
                    .last_received
                    .store(inner.started.elapsed().as_secs(), Ordering::Relaxed);
                let mut failed = false;
                for bytes in messages {
                    let response: Response = match crate::wire::response(&bytes) {
                        Ok(response) => response,
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    };
                    if matches!(response, Response::Pong { .. }) {
                        continue;
                    }
                    let id = response.id().to_string();
                    let pending = inner.pending.lock().await.remove(&id);
                    if let Some(pending) = pending {
                        let _ = pending.send(Ok(response));
                    } else {
                        let terminal = inner.sockets.lock().await.get(&id).cloned();
                        if let Some(terminal) = terminal {
                            let closes = matches!(
                                response,
                                Response::Closed { .. } | Response::Error { .. }
                            );
                            // Backpressure reaches the socket and relay instead
                            // of silently dropping terminal/compression bytes.
                            let delivered = tokio::select! {
                                _ = read_stop.changed() => { failed = true; break; },
                                result = terminal.send(response) => result.is_ok(),
                            };
                            if closes || !delivered {
                                inner.sockets.lock().await.remove(&id);
                            }
                        }
                    }
                }
                if failed {
                    break;
                }
            }
            fail(&inner).await;
        });
        client
    }
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }
    /// Includes queued and partially transmitted upload fragments.
    pub fn outgoing_idle(&self) -> bool { self.inner.outbound.is_idle() }
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        let _ = self.inner.stop.send(true);
    }
    async fn send(&self, request: Request) -> Result<(), String> {
        if self.is_closed() {
            return Err("Encrypted connection is closed".into());
        }
        self.inner
            .outbound
            .send(request)
            .await
            .map_err(|_| "Encrypted connection is closed".into())
    }
    pub async fn request(
        &self,
        method: String,
        path: String,
        body: Option<String>,
    ) -> Result<Response, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id.clone(), tx);
        if let Err(error) = self
            .send(Request::Http {
                id: id.clone(),
                method,
                path,
                body,
            })
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(Duration::from_secs(40), rx).await;
        self.inner.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(result)) => match result? {
                Response::Error { message, .. } => Err(message),
                response => Ok(response),
            },
            _ => {
                self.close();
                Err("Encrypted request timed out or was interrupted".into())
            }
        }
    }
    pub async fn open_socket(
        &self,
        id: String,
        path: String,
    ) -> Result<mpsc::Receiver<Response>, String> {
        let (tx, rx) = mpsc::channel(32);
        let mut sockets = self.inner.sockets.lock().await;
        if sockets.contains_key(&id) || sockets.len() >= 32 {
            return Err("Invalid or duplicate socket".into());
        }
        sockets.insert(id.clone(), tx);
        drop(sockets);
        if let Err(error) = self
            .send(Request::Open {
                id: id.clone(),
                path,
            })
            .await
        {
            self.inner.sockets.lock().await.remove(&id);
            return Err(error);
        }
        Ok(rx)
    }
    pub async fn socket_text(&self, id: String, data: String) -> Result<(), String> {
        self.send(Request::Text { id, data }).await
    }
    pub async fn socket_binary(&self, id: String, data: String) -> Result<(), String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let data = STANDARD
            .decode(data)
            .map_err(|_| "Invalid binary socket data")?;
        self.send(Request::Binary { id, data }).await
    }
    pub async fn close_socket(&self, id: String) -> Result<(), String> {
        self.inner.sockets.lock().await.remove(&id);
        self.send(Request::Close { id }).await
    }
}
async fn fail(inner: &Arc<Inner>) {
    inner.closed.store(true, Ordering::SeqCst);
    let _ = inner.stop.send(true);
    for (_, pending) in inner.pending.lock().await.drain() {
        let _ = pending.send(Err("Encrypted connection interrupted".into()));
    }
    inner.sockets.lock().await.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    /// A correctly authenticated Hub that stops replying to application data.
    async fn silent_hub() -> (
        Client,
        Arc<tokio::sync::Notify>,
        tokio::task::JoinHandle<()>,
    ) {
        let hub = Identity::generate().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint {
            hub_url: format!("http://{}", listener.local_addr().unwrap()),
            public_key: URL_SAFE_NO_PAD.encode(hub.public()),
        };
        let observed = Arc::new(tokio::sync::Notify::new());
        let seen = observed.clone();
        let serving = tokio::spawn(async move {
            let (io, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(io).await.unwrap();
            let mut handshake = hub.responder().unwrap();
            let first = socket.next().await.unwrap().unwrap().into_data();
            handshake
                .read_message(&first, &mut [0; MAX_RECORD])
                .unwrap();
            let mut hello = [0; MAX_RECORD];
            let n = handshake.write_message(&[], &mut hello).unwrap();
            socket
                .send(Message::Binary(hello[..n].to_vec().into()))
                .await
                .unwrap();
            let mut channel = Channel::new(handshake.into_transport_mode().unwrap());
            let auth = socket.next().await.unwrap().unwrap().into_data();
            channel.decode(&auth).unwrap();
            for record in channel
                .encode(br#"{"type":"ready","device_id":"test"}"#)
                .unwrap()
            {
                socket.send(Message::Binary(record.into())).await.unwrap();
            }
            while let Some(Ok(Message::Binary(record))) = socket.next().await {
                for message in channel.decode(&record).unwrap() {
                    if matches!(
                        crate::wire::request(&message).unwrap(),
                        Request::Http { .. }
                    ) {
                        seen.notify_one();
                    }
                }
            }
        });
        let (client, _) = Client::connect(
            &endpoint,
            &Identity::generate().unwrap(),
            Authenticate::Resume,
        )
        .await
        .unwrap();
        (client, observed, serving)
    }
    #[tokio::test]
    async fn silent_network_loss_closes_the_connection_for_a_fresh_handshake() {
        let (client, _, server) = silent_hub().await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(66)).await;
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(
            client.is_closed(),
            "elapsed={} received={}",
            client.inner.started.elapsed().as_secs(),
            client.inner.last_received.load(Ordering::Relaxed)
        );
        server.abort();
    }
    #[tokio::test]
    async fn a_timed_out_mutation_is_not_replayed_and_closes_the_stale_connection() {
        let (client, observed, server) = silent_hub().await;
        let requesting = client.clone();
        let request = tokio::spawn(async move {
            requesting
                .request("POST".into(), "/api/terminals".into(), Some("{}".into()))
                .await
        });
        observed.notified().await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(41)).await;
        assert!(request.await.unwrap().is_err());
        assert!(client.is_closed());
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn slow_large_upload_keeps_authenticated_heartbeats_and_other_streams_responsive() {
        use crate::wire::WireMessage;
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};
        // A 20 MiB image represented as base64 in the existing terminal JSON
        // frame takes >100s at 2 Mbps. Virtual time makes this deterministic;
        // a 1 KiB duplex prevents an unbounded OS buffer hiding backpressure.
        let image_text_len = (20 * 1024 * 1024usize).div_ceil(3) * 4;
        let (client_io, hub_io) = tokio::io::duplex(1024);
        let client_socket = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut hub_socket = WebSocketStream::from_raw_socket(hub_io, Role::Server, None).await;
        let (client_channel, mut hub_channel) = crate::tests::handshake();
        let client = Client::start(client_socket, client_channel);
        let started = Instant::now();
        let first_fragment = Arc::new(tokio::sync::Notify::new());
        let first = first_fragment.clone();
        let measurements = Arc::new(Mutex::new(Vec::<(&'static str, Duration)>::new()));
        let measured = measurements.clone();
        let (complete, completed) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut complete = Some(complete);
            let mut saw_image = false;
            while let Some(Ok(Message::Binary(record))) = hub_socket.next().await {
                let wire_time = Duration::from_secs_f64(record.len() as f64 * 8.0 / 2_000_000.0);
                tokio::time::sleep(wire_time).await;
                let messages = hub_channel.decode(&record).unwrap();
                if messages.is_empty() {
                    first.notify_one();
                }
                for bytes in messages {
                    let response = match crate::wire::request(&bytes).unwrap() {
                        Request::Ping { id } => {
                            measured.lock().await.push(("ping", started.elapsed()));
                            Some(Response::Pong { id })
                        }
                        Request::Http { id, .. } => Some(Response::Http {
                            id,
                            status: 200,
                            body: "{}".into(),
                        }),
                        Request::Text { id, data }
                            if id == "upload" && data.len() == image_text_len =>
                        {
                            saw_image = true;
                            measured.lock().await.push(("image", started.elapsed()));
                            None
                        }
                        Request::Text { id, data } if id == "upload" && data == "Enter" => {
                            assert!(
                                saw_image,
                                "Enter must not overtake its image on the same terminal"
                            );
                            let _ = complete.take().unwrap().send(());
                            None
                        }
                        Request::Text { id, data } if id == "other" && data == "x" => {
                            measured.lock().await.push(("key", started.elapsed()));
                            None
                        }
                        _ => panic!("unexpected request"),
                    };
                    if let Some(response) = response {
                        // Include an 800ms response delay, in addition to the
                        // rate-limited uplink, for encrypted Ping/Pong and HTTP.
                        tokio::time::sleep(Duration::from_millis(800)).await;
                        for reply in hub_channel.encode(&response.encode().unwrap()).unwrap() {
                            hub_socket
                                .send(Message::Binary(reply.into()))
                                .await
                                .unwrap();
                        }
                    }
                }
            }
        });
        client
            .socket_text("upload".into(), "A".repeat(image_text_len))
            .await
            .unwrap();
        first_fragment.notified().await;
        let input_at = started.elapsed();
        client
            .socket_text("upload".into(), "Enter".into())
            .await
            .unwrap();
        client
            .socket_text("other".into(), "x".into())
            .await
            .unwrap();
        let http_start = Instant::now();
        assert!(matches!(
            client
                .request("GET".into(), "/api/auth/me".into(), None)
                .await
                .unwrap(),
            Response::Http { status: 200, .. }
        ));
        let http_elapsed = http_start.elapsed();
        assert!(
            http_elapsed < Duration::from_secs(3),
            "HTTP waited {http_elapsed:?}"
        );
        tokio::time::timeout(Duration::from_secs(180), completed)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !client.is_closed(),
            "a progressing upload must not hit the 65s watchdog"
        );
        let measurements = measurements.lock().await;
        let image_elapsed = measurements
            .iter()
            .find(|(kind, _)| *kind == "image")
            .unwrap()
            .1;
        let key_elapsed = measurements
            .iter()
            .find(|(kind, _)| *kind == "key")
            .unwrap()
            .1
            - input_at;
        let pings = measurements
            .iter()
            .filter(|(kind, _)| *kind == "ping")
            .count();
        assert!(image_elapsed > Duration::from_secs(100));
        assert!(
            key_elapsed < Duration::from_secs(3),
            "other-terminal input waited {key_elapsed:?}"
        );
        assert!(
            pings >= 20,
            "authenticated heartbeats must pass throughout the upload"
        );
        eprintln!("2 Mbps virtual uplink + 800ms replies: upload={image_elapsed:?}, other-terminal key={key_elapsed:?}, HTTP={http_elapsed:?}, authenticated heartbeats={pings}");
        client.close();
        server.abort();
    }
}
