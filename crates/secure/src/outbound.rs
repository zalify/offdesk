//! Bound queued bytes and multiplex small independent messages between upload
//! fragments. Messages on the same logical socket retain their original order.
use crate::{wire::WireMessage, Channel, OutgoingMessage, FRAGMENT_BYTES};
use futures::{Sink, SinkExt};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::{mpsc, Mutex, OwnedSemaphorePermit, Semaphore};

pub const QUEUED_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone)]
pub struct Sender {
    data: mpsc::Sender<Queued>,
    control: mpsc::Sender<Queued>,
    budget: Arc<Semaphore>,
}
struct Queued {
    key: String,
    message: OutgoingMessage,
    _permit: Option<OwnedSemaphorePermit>,
}
pub struct Writer {
    data: mpsc::Receiver<Queued>,
    control: mpsc::Receiver<Queued>,
}
pub fn queue() -> (Sender, Writer) {
    let (data, receive) = mpsc::channel(64);
    let (control, controls) = mpsc::channel(4);
    (
        Sender {
            data,
            control,
            budget: Arc::new(Semaphore::new(QUEUED_BYTES)),
        },
        Writer {
            data: receive,
            control: controls,
        },
    )
}
impl Sender {
    pub fn is_idle(&self) -> bool { self.budget.available_permits() == QUEUED_BYTES }

    pub async fn send(&self, value: impl WireMessage) -> Result<(), String> {
        if value.control() {
            return self.try_send(value);
        }
        let key = value.key();
        let bytes = value.encode().map_err(|e| e.to_string())?;
        let size = bytes.len();
        let message = OutgoingMessage::new(bytes).map_err(|e| e.to_string())?;
        let permit = self
            .budget
            .clone()
            .acquire_many_owned(size as u32)
            .await
            .map_err(|_| "Encrypted queue closed")?;
        self.data
            .send(Queued {
                key,
                message,
                _permit: Some(permit),
            })
            .await
            .map_err(|_| "Encrypted queue closed".into())
    }
    pub fn try_send(&self, value: impl WireMessage) -> Result<(), String> {
        let control = value.control();
        let key = value.key();
        let bytes = value.encode().map_err(|e| e.to_string())?;
        if control && bytes.len() > FRAGMENT_BYTES {
            return Err("Invalid heartbeat".into());
        }
        let permit = if control {
            None
        } else {
            Some(
                self.budget
                    .clone()
                    .try_acquire_many_owned(bytes.len() as u32)
                    .map_err(|_| "Encrypted queue full")?,
            )
        };
        let queued = Queued {
            key,
            message: OutgoingMessage::new(bytes).map_err(|e| e.to_string())?,
            _permit: permit,
        };
        (if control { &self.control } else { &self.data })
            .try_send(queued)
            .map_err(|_| "Encrypted queue full".into())
    }
}
impl Writer {
    pub async fn run<S, M, F>(
        mut self,
        mut sink: S,
        channel: Arc<Mutex<Channel>>,
        frame: F,
    ) -> Result<(), String>
    where
        S: Sink<M> + Unpin,
        F: Fn(Vec<u8>) -> M,
    {
        let mut waiting = VecDeque::<Queued>::new();
        let mut bulk: Option<Queued> = None;
        let mut urgent_streak = 0;
        loop {
            // Pull a bounded batch. Keeping a single fragmented bulk message
            // active bounds assembly and preserves same-socket ordering.
            while waiting.len() < 64 {
                match self.data.try_recv() {
                    Ok(next) => waiting.push_back(next),
                    Err(_) => break,
                }
            }
            let urgent = self.control.try_recv().ok();
            let small = waiting.iter().enumerate().position(|(index, next)| {
                next.message.is_small()
                    && bulk.as_ref().is_none_or(|bulk| bulk.key != next.key)
                    && !waiting
                        .iter()
                        .take(index)
                        .any(|earlier| earlier.key == next.key)
            });
            let next = if let Some(control) = urgent {
                Some(control)
            } else if small.is_some() && urgent_streak < 8 {
                urgent_streak += 1;
                waiting.remove(small.unwrap())
            } else if bulk.is_some() {
                urgent_streak = 0;
                bulk.take()
            } else {
                urgent_streak = 0;
                waiting.pop_front()
            };
            let Some(mut next) = next else {
                tokio::select! {
                    biased;
                    value = self.control.recv() => match value { Some(value) => waiting.push_front(value), None => return Ok(()) },
                    value = self.data.recv() => match value { Some(value) => waiting.push_back(value), None => return Ok(()) },
                }
                continue;
            };
            let record = channel
                .lock()
                .await
                .encode_next(&mut next.message)
                .map_err(|e| e.to_string())?;
            sink.send(frame(record))
                .await
                .map_err(|_| "Encrypted connection interrupted")?;
            if !next.message.finished() {
                bulk = Some(next);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{messages::Request, wire};
    #[tokio::test]
    async fn queued_upload_holds_the_idle_budget_until_the_writer_releases_it() {
        let (sender, writer) = queue();
        assert!(sender.is_idle());
        sender.send(Request::Text { id: "file".into(), data: "x".repeat(FRAGMENT_BYTES * 3) }).await.unwrap();
        assert!(!sender.is_idle());
        drop(writer);
        assert!(sender.is_idle());
    }
    #[tokio::test]
    async fn busy_small_streams_do_not_starve_bulk_or_reorder_its_following_enter() {
        let (sender, writer) = queue();
        sender
            .send(Request::Text {
                id: "upload".into(),
                data: "A".repeat(FRAGMENT_BYTES * 20),
            })
            .await
            .unwrap();
        sender
            .send(Request::Text {
                id: "upload".into(),
                data: "Enter".into(),
            })
            .await
            .unwrap();
        for index in 0..20 {
            sender
                .send(Request::Text {
                    id: format!("other-{index}"),
                    data: "x".into(),
                })
                .await
                .unwrap();
        }
        drop(sender);
        let (channel, receiver) = crate::tests::handshake();
        let receiver = Arc::new(Mutex::new(receiver));
        let received = Arc::new(Mutex::new(Vec::new()));
        let observed = received.clone();
        let records = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = records.clone();
        let first_partial = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let partial = first_partial.clone();
        let sink = Box::pin(futures::sink::unfold((), move |(), record: Vec<u8>| {
            let receiver = receiver.clone();
            let observed = observed.clone();
            let count = count.clone();
            let partial = partial.clone();
            async move {
                use std::sync::atomic::Ordering::SeqCst;
                let index = count.fetch_add(1, SeqCst) + 1;
                let messages = receiver.lock().await.decode(&record).unwrap();
                if messages.is_empty() {
                    let _ = partial.compare_exchange(0, index, SeqCst, SeqCst);
                }
                for message in messages {
                    if let Request::Text { id, data } = wire::request(&message).unwrap() {
                        observed.lock().await.push((id, data.len()));
                    }
                }
                Ok::<_, std::convert::Infallible>(())
            }
        }));
        writer
            .run(sink, Arc::new(Mutex::new(channel)), |record| record)
            .await
            .unwrap();
        assert!(first_partial.load(std::sync::atomic::Ordering::SeqCst) <= 9);
        let received = received.lock().await;
        assert_eq!(
            received
                .iter()
                .filter(|(id, _)| id == "upload")
                .map(|(_, len)| *len)
                .collect::<Vec<_>>(),
            vec![FRAGMENT_BYTES * 20, 5]
        );
        assert_eq!(received.len(), 22);
    }

    #[tokio::test]
    async fn full_data_budget_keeps_a_separate_bounded_heartbeat_lane() {
        struct Data(Vec<u8>);
        impl WireMessage for Data {
            fn key(&self) -> String {
                "data".into()
            }
            fn control(&self) -> bool {
                false
            }
            fn encode(self) -> Result<Vec<u8>, crate::Error> {
                Ok(self.0)
            }
        }
        let (sender, writer) = queue();
        for _ in 0..2 {
            sender.send(Data(vec![1; QUEUED_BYTES / 2])).await.unwrap();
        }
        assert!(sender.try_send(Data(vec![1])).is_err());
        for _ in 0..4 {
            sender
                .try_send(Request::Ping {
                    id: "heartbeat".into(),
                })
                .unwrap();
        }
        assert!(sender
            .try_send(Request::Ping {
                id: "heartbeat".into()
            })
            .is_err());
        drop(writer);
        assert_eq!(sender.budget.available_permits(), QUEUED_BYTES);
    }
}
