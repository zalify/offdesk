use futures::SinkExt;
use offdesk_protocol::preview::AddressFamily;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

/// The destination is always derived from the authenticated control connection.
/// No command can make this node dial another Hub or a non-loopback service.
pub async fn connect(
    hub: &str,
    id: &str,
    ticket: &str,
    port: u16,
    family: AddressFamily,
    expires_at: i64,
) -> Result<(), String> {
    if port == 0
        || expires_at
            <= SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
    {
        return Err("expired preview request".into());
    }
    let mut url = url::Url::parse(hub).map_err(|_| "invalid hub URL")?;
    url.set_path(&format!("/ws/preview-stream/{id}"));
    url.set_query(None);
    url.set_fragment(None);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "invalid preview URL")?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {ticket}")
            .parse()
            .map_err(|_| "invalid ticket")?,
    );
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(crate::CHUNK);
    config.max_frame_size = Some(crate::CHUNK);
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| "preview hub timeout")?
    .map_err(|_| "preview hub rejected connection")?;
    let tcp = match tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect(family.loopback(port)),
    )
    .await
    {
        Ok(Ok(tcp)) => tcp,
        _ => {
            let _ = ws.send(Message::Text("unavailable".into())).await;
            return Err("local preview port unavailable".into());
        }
    };
    let _ = tcp.set_nodelay(true);
    ws.send(Message::Text("ready".into()))
        .await
        .map_err(|_| "preview disconnected")?;
    use futures::StreamExt;
    let (sink, stream) = ws.split();
    crate::bridge(sink, stream, tcp)
        .await
        .map_err(|_| "preview transport closed".into())
}
