//! Lossless, bounded TCP bytes over a dedicated WebSocket. Independent of PTY traffic.
mod client;
pub use client::connect;
use futures::{Sink, SinkExt, Stream, StreamExt};
use std::{fmt::Display, io, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

pub const CHUNK: usize = 64 * 1024;
pub const BUFFER: usize = 256 * 1024;

fn error(e: impl Display) -> io::Error {
    io::Error::other(e.to_string())
}

/// `eof` half-closes only the peer's TCP write direction. A premature WS close
/// is a transport error, never a successful/truncated HTTP body.
pub async fn bridge<S, R, E, T>(mut sink: S, mut stream: R, io: T) -> io::Result<()>
where
    S: Sink<Message, Error = E> + Unpin,
    R: Stream<Item = Result<Message, E>> + Unpin,
    E: Display,
    T: AsyncRead + AsyncWrite + Unpin,
{
    let (mut read, mut write) = tokio::io::split(io);
    let send = async {
        let mut buf = vec![0; CHUNK];
        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                n = read.read(&mut buf) => {
                    let n = n?;
                    if n == 0 {
                        sink.send(Message::Text("eof".into())).await.map_err(error)?;
                        return Ok::<_, io::Error>(());
                    }
                    sink.send(Message::Binary(buf[..n].to_vec().into())).await.map_err(error)?;
                }
                _ = heartbeat.tick() => {
                    sink.send(Message::Ping(Vec::new().into())).await.map_err(error)?;
                }
            }
        }
    };
    let receive = async {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(90), stream.next())
                .await
                .map_err(error)?
                .ok_or_else(|| error("preview stream disconnected"))?
                .map_err(error)?;
            match msg {
                Message::Binary(data) if data.len() <= CHUNK => write.write_all(&data).await?,
                Message::Text(text) if text == "eof" => {
                    write.shutdown().await?;
                    return Ok::<_, io::Error>(());
                }
                Message::Ping(_) | Message::Pong(_) => {}
                _ => return Err(error("invalid preview frame or premature close")),
            }
        }
    };
    tokio::try_join!(send, receive)?;
    Ok(())
}
