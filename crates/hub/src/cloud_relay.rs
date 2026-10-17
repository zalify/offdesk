//! The relay connector: Offdesk Relay in place of cloudflared. The Hub keeps a control
//! connection to each of its relay regions (its home, and a backup) and, for every phone the
//! relay announces, dials a stream back and joins it to this Hub's encrypted-only listener
//! (127.0.0.1:4318, `/ws/secure`), as cloudflared did. Both pass Noise records they can't read:
//! the phone and the Hub encrypt end to end, and the pairing pins the Hub's key.
//!
//! The relay's side, on a Hub's hostname (`<slug>.<region>.relay.offdesk.cloud`):
//!   /.offdesk/relay            control connection, `Authorization: Bearer <control token>`;
//!                              the relay sends `{"type":"open","stream":"<32 hex>"}` per phone
//!   /.offdesk/relay/<stream>   the Hub's socket for that phone, same token, within 10 s
//! Close codes from the relay: 4000 replaced by a newer connection, 4003 no longer allowed
//! (disabled or moved off the relay), 1012 the relay restarting.
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::HeaderValue,
    protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
    Message,
};
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The relay pings every 20 s; nothing for this long means the connection is dead.
const SILENT_FOR: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// The relay allows 32 streams per Hub; so does the Hub's handshake limit.
const MAX_STREAMS: usize = 32;
/// One Noise record per message (offdesk_secure::MAX_RECORD).
const MAX_RECORD: usize = 65_535;

/// Where the Hub keeps a control connection: one of its regions.
#[derive(Clone, Debug)]
pub struct Region {
    pub code: String,
    pub hostname: String,
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_RECORD))
        .max_frame_size(Some(MAX_RECORD))
}

/// Runs until `shutdown` resolves: one control connection per region, redialled with backoff.
pub async fn run(
    regions: Vec<Region>,
    token: Zeroizing<String>,
    origin: String,
    shutdown: impl std::future::Future<Output = ()>,
) {
    let token = Arc::new(token);
    let mut tasks = tokio::task::JoinSet::new();
    for region in regions {
        let (token, origin) = (token.clone(), origin.clone());
        tasks.spawn(async move { keep_connected(region, token, origin).await });
    }
    shutdown.await;
    tasks.abort_all();
}

fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_secs(1u64 << attempt.min(6)).min(MAX_BACKOFF);
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    // ±25 % jitter
    base.mul_f64(0.75 + f64::from(byte[0]) / 255.0 * 0.5)
}

async fn keep_connected(region: Region, token: Arc<Zeroizing<String>>, origin: String) {
    let mut attempt = 0u32;
    loop {
        let opened = Instant::now();
        let ended = control(&region, &token, &origin).await;
        // Never log tokens or addresses with credentials: the region and why is enough
        eprintln!("relay {}: {}", region.code, ended.reason());
        // A connection that held for a while starts the backoff over
        if opened.elapsed() > Duration::from_secs(60) {
            attempt = 0;
        }
        let wait = match ended {
            // Disabled or moved off the relay: Cloud decides; look again now and then
            Ended::NotAllowed => MAX_BACKOFF,
            // Another connector took over (this Hub's registration elsewhere)
            Ended::Replaced => MAX_BACKOFF,
            // The relay restarting: its region is back within seconds
            Ended::Restart => Duration::from_secs(1),
            _ => backoff(attempt),
        };
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(wait).await;
    }
}

#[derive(Debug, PartialEq)]
enum Ended {
    Unreachable,
    Refused(u16),
    NotAllowed,
    Replaced,
    Restart,
    Silent,
    Closed,
}
impl Ended {
    fn reason(&self) -> String {
        match self {
            Ended::Unreachable => "couldn't connect".into(),
            Ended::Refused(status) => format!("refused (HTTP {status})"),
            Ended::NotAllowed => "not allowed (disabled, or not on the relay)".into(),
            Ended::Replaced => "replaced by another connection".into(),
            Ended::Restart => "relay restarting".into(),
            Ended::Silent => "silent".into(),
            Ended::Closed => "closed".into(),
        }
    }
}

fn request(
    url: &str,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, Ended> {
    let mut request = url.into_client_request().map_err(|_| Ended::Unreachable)?;
    let value =
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Ended::Unreachable)?;
    request.headers_mut().insert("authorization", value);
    Ok(request)
}

async fn control(region: &Region, token: &str, origin: &str) -> Ended {
    control_with(region, token, origin, "wss").await
}

/// `scheme` is `wss` but in tests (a fake relay without TLS)
async fn control_with(region: &Region, token: &str, origin: &str, scheme: &'static str) -> Ended {
    let url = format!("{scheme}://{}/.offdesk/relay", region.hostname);
    let request = match request(&url, token) {
        Ok(request) => request,
        Err(ended) => return ended,
    };
    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(config()), true),
    )
    .await;
    let mut socket = match connected {
        Err(_) => return Ended::Unreachable,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            return match response.status().as_u16() {
                401 | 403 => Ended::NotAllowed,
                status => Ended::Refused(status),
            }
        }
        Ok(Err(_)) => return Ended::Unreachable,
        Ok(Ok((socket, _))) => socket,
    };
    eprintln!("relay {}: connected", region.code);
    let streams = Arc::new(Semaphore::new(MAX_STREAMS));
    loop {
        let message = match tokio::time::timeout(SILENT_FOR, socket.next()).await {
            Err(_) => return Ended::Silent,
            Ok(None) | Ok(Some(Err(_))) => return Ended::Closed,
            Ok(Some(Ok(message))) => message,
        };
        match message {
            Message::Text(text) => {
                let Some(stream) = open_request(&text) else {
                    continue;
                };
                // Over the limit the relay already refuses; the phone gets 1013 when no
                // stream arrives
                let Ok(permit) = streams.clone().try_acquire_owned() else {
                    continue;
                };
                let url = format!("{scheme}://{}/.offdesk/relay/{stream}", region.hostname);
                let (token, origin) = (Zeroizing::new(token.to_string()), origin.to_string());
                tokio::spawn(async move {
                    join(&url, &token, &origin).await;
                    drop(permit);
                });
            }
            Message::Close(frame) => {
                return match frame.map(|f| u16::from(f.code)) {
                    Some(4003) => Ended::NotAllowed,
                    Some(4000) => Ended::Replaced,
                    Some(1012) => Ended::Restart,
                    _ => Ended::Closed,
                }
            }
            // tungstenite answers pings itself; any message is a sign of life
            _ => {}
        }
    }
}

/// The stream id of an `open` message, if it's one: 128 bits, lower-case hex.
fn open_request(text: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Open {
        r#type: String,
        stream: String,
    }
    let open: Open = serde_json::from_str(text).ok()?;
    (open.r#type == "open"
        && open.stream.len() == 32
        && open
            .stream
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(open.stream)
}

/// One phone: the relay's stream and the local encrypted listener, joined until either ends.
async fn join(url: &str, token: &str, origin: &str) {
    let Ok(request) = request(url, token) else {
        return;
    };
    let local = format!("{}/ws/secure", origin.replacen("http://", "ws://", 1));
    let dialled = tokio::time::timeout(CONNECT_TIMEOUT, async {
        tokio::try_join!(
            tokio_tungstenite::connect_async_with_config(request, Some(config()), true),
            tokio_tungstenite::connect_async_with_config(local.as_str(), Some(config()), true),
        )
    })
    .await;
    let Ok(Ok(((relay, _), (hub, _)))) = dialled else {
        return;
    };
    pipe(relay, hub).await;
}

async fn pipe<A, B>(a: A, b: B)
where
    A: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures::Sink<Message>
        + Unpin,
    B: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures::Sink<Message>
        + Unpin,
{
    let (mut a_tx, mut a_rx) = a.split();
    let (mut b_tx, mut b_rx) = b.split();
    let code = tokio::select! {
        code = forward(&mut a_rx, &mut b_tx) => code,
        code = forward(&mut b_rx, &mut a_tx) => code,
    };
    let close = |code: u16| {
        Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: "".into(),
        }))
    };
    let _ = a_tx.send(close(code)).await;
    let _ = b_tx.send(close(code)).await;
}

/// Binary messages pass one for one; text ends the stream (only Noise records are expected).
async fn forward<R, W>(from: &mut R, to: &mut W) -> u16
where
    R: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    W: futures::Sink<Message> + Unpin,
{
    loop {
        match from.next().await {
            Some(Ok(Message::Binary(record))) => {
                if to.send(Message::Binary(record)).await.is_err() {
                    return 1001;
                }
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
            Some(Ok(Message::Text(_))) => return 1003,
            Some(Ok(Message::Close(frame))) => {
                let code = frame.map(|f| u16::from(f.code)).unwrap_or(1000);
                return if matches!(code, 1000..=1003 | 1007..=1011 | 3000..=4999) {
                    code
                } else {
                    1000
                };
            }
            Some(Err(_)) | None => return 1001,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn only_well_formed_open_messages_start_a_stream() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            open_request(&format!(r#"{{"type":"open","stream":"{id}"}}"#)).as_deref(),
            Some(id)
        );
        for bad in [
            r#"{"type":"close","stream":"0123456789abcdef0123456789abcdef"}"#.to_string(),
            r#"{"type":"open","stream":"../../ws/secure"}"#.to_string(),
            r#"{"type":"open","stream":"0123456789ABCDEF0123456789ABCDEF"}"#.to_string(),
            r#"{"type":"open","stream":"0123"}"#.to_string(),
            "not json".to_string(),
        ] {
            assert_eq!(open_request(&bad), None, "{bad}");
        }
    }

    /// A fake relay (plain ws, same paths) and a fake encrypted listener: the connector
    /// answers an `open` with a stream that carries bytes both ways unchanged, sends its
    /// token on both sockets, and stops on 4003.
    #[tokio::test]
    async fn dials_streams_and_joins_them_to_the_local_listener() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
        let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay.local_addr().unwrap();
        let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = local.local_addr().unwrap();
        // The local listener echoes records reversed, so a pass-through is visible
        tokio::spawn(async move {
            while let Ok((tcp, _)) = local.accept().await {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    while let Some(Ok(Message::Binary(b))) = ws.next().await {
                        let mut v = b.to_vec();
                        v.reverse();
                        ws.send(Message::Binary(v.into())).await.unwrap();
                    }
                });
            }
        });
        let (paths_tx, mut paths) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
        let accept = |tcp| {
            let paths_tx = paths_tx.clone();
            async move {
                tokio_tungstenite::accept_hdr_async(tcp, move |req: &Request, res: Response| {
                    let auth = req
                        .headers()
                        .get("authorization")
                        .unwrap()
                        .to_str()
                        .unwrap();
                    paths_tx
                        .send((req.uri().path().to_string(), auth.to_string()))
                        .unwrap();
                    Ok(res)
                })
                .await
                .unwrap()
            }
        };
        let region = Region {
            code: "hk".into(),
            hostname: relay_addr.to_string(),
        };
        let token = "a".repeat(64);
        let origin = format!("http://{local_addr}");
        let control_task = {
            let (token, origin) = (token.clone(), origin.clone());
            tokio::spawn(async move { control_with(&region, &token, &origin, "ws").await })
        };
        let (tcp, _) = relay.accept().await.unwrap();
        let mut control_ws = accept(tcp).await;
        assert_eq!(
            paths.recv().await.unwrap(),
            ("/.offdesk/relay".into(), format!("Bearer {token}"))
        );
        let stream = "0123456789abcdef0123456789abcdef";
        control_ws
            .send(Message::Text(
                format!(r#"{{"type":"open","stream":"{stream}"}}"#).into(),
            ))
            .await
            .unwrap();
        let (tcp, _) = relay.accept().await.unwrap();
        let mut stream_ws = accept(tcp).await;
        assert_eq!(
            paths.recv().await.unwrap(),
            (
                format!("/.offdesk/relay/{stream}"),
                format!("Bearer {token}")
            )
        );
        stream_ws
            .send(Message::Binary(vec![1u8, 2, 3].into()))
            .await
            .unwrap();
        match stream_ws.next().await.unwrap().unwrap() {
            Message::Binary(b) => assert_eq!(b.to_vec(), vec![3u8, 2, 1]),
            other => panic!("{other:?}"),
        }
        // Text isn't a Noise record: the stream ends
        stream_ws.send(Message::Text("hello".into())).await.unwrap();
        loop {
            match stream_ws.next().await {
                Some(Ok(Message::Close(Some(frame)))) => {
                    assert_eq!(u16::from(frame.code), 1003);
                    break;
                }
                Some(Ok(_)) => continue,
                other => panic!("{other:?}"),
            }
        }
        control_ws
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(4003),
                reason: "not_allowed".into(),
            })))
            .await
            .unwrap();
        assert_eq!(control_task.await.unwrap(), Ended::NotAllowed);
    }
}
