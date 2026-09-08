use super::registry::{now, StreamGuard};
use crate::{auth::hash_token, AppState};
use axum::{
    extract::{
        ws::{Message as AxMessage, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use offdesk_protocol::HubToMachine;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::DuplexStream;
use tokio_tungstenite::tungstenite::Message;

pub async fn open(
    state: &AppState,
    lease: Arc<super::registry::Lease>,
) -> Result<(DuplexStream, StreamGuard), (StatusCode, &'static str)> {
    let Some((conn_id, commands, connection_cancel)) = state
        .manager
        .preview_connection(&lease.user, &lease.machine)
        .await
    else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Preview machine is offline or unavailable; retry after it reconnects",
        ));
    };
    let (guard, ticket, rx) = state
        .web_previews
        .allocate(lease.clone(), conn_id, connection_cancel)
        .map_err(|e| (StatusCode::TOO_MANY_REQUESTS, e))?;
    let command = HubToMachine::OpenPreviewStream {
        stream_id: guard.id.clone(),
        ticket,
        port: lease.port,
        address_family: lease.family,
        expires_at: now() + 10_000,
    };
    let result = tokio::select! {
        _ = guard.cancel.cancelled() => return Err((StatusCode::SERVICE_UNAVAILABLE, "Preview machine disconnected")),
        result = tokio::time::timeout(Duration::from_secs(10), async {
            commands.send(command).await.map_err(|_| ())?;
            rx.await.map_err(|_| ())?
        }) => result,
    };
    match result {
        Ok(Ok(io)) => Ok((io, guard)),
        Ok(Err(())) => Err((StatusCode::BAD_GATEWAY, "Local preview port is unavailable")),
        Err(_) => Err((StatusCode::GATEWAY_TIMEOUT, "Preview connection timed out")),
    }
}

pub async fn accept(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let lease = state
        .web_previews
        .streams
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| (s.lease.clone(), s.conn_id.clone()));
    let Some((lease, stream_conn_id)) = lease else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !state
        .manager
        .preview_connection(&lease.user, &lease.machine)
        .await
        .is_some_and(|(conn_id, _, _)| conn_id == stream_conn_id)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    let claimed = {
        let mut streams = state.web_previews.streams.lock().unwrap();
        streams.get_mut(&id).and_then(|s| {
            if !s.lease.live()
                || s.cancel.is_cancelled()
                || Instant::now() >= s.deadline
                || s.ticket_hash != hash_token(token)
            {
                return None;
            }
            s.sender
                .take()
                .map(|tx| (tx, s.cancel.clone(), s.lease.expires))
        })
    };
    let Some((sender, cancel, expires)) = claimed else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    ws.max_frame_size(offdesk_preview_transport::CHUNK)
        .max_message_size(offdesk_preview_transport::CHUNK)
        .on_upgrade(move |mut socket| async move {
            let ready = tokio::select! {
                _ = cancel.cancelled() => return,
                result = tokio::time::timeout(Duration::from_secs(8), socket.recv()) => result,
            };
            if !matches!(ready, Ok(Some(Ok(AxMessage::Text(ref t)))) if t.as_str() == "ready") {
                let _ = sender.send(Err(()));
                return;
            }
            let (client, pump) = tokio::io::duplex(offdesk_preview_transport::BUFFER);
            if sender.send(Ok(client)).is_err() {
                return;
            }
            let (sink, stream) = socket.split();
            let sink = sink.with(|m: Message| async move {
                Ok::<_, axum::Error>(match m {
                    Message::Binary(b) => AxMessage::Binary(b),
                    Message::Text(t) => AxMessage::Text(t.to_string().into()),
                    Message::Ping(b) => AxMessage::Ping(b),
                    Message::Pong(b) => AxMessage::Pong(b),
                    _ => AxMessage::Close(None),
                })
            });
            let stream = stream.map(|m| {
                m.map(|m| match m {
                    AxMessage::Binary(b) => Message::Binary(b),
                    AxMessage::Text(t) => Message::Text(t.to_string().into()),
                    AxMessage::Ping(b) => Message::Ping(b),
                    AxMessage::Pong(b) => Message::Pong(b),
                    AxMessage::Close(_) => Message::Close(None),
                })
            });
            tokio::pin!(sink);
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = tokio::time::sleep_until(expires.into()) => {},
                _ = offdesk_preview_transport::bridge(sink, stream, pump) => {},
            }
        })
        .into_response()
}
