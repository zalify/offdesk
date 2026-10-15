//! Webhooks (docs/plans/2026-10-14-agent-runs-external-access.md, B2): agent run events
//! POSTed to the integrations a person set up, signed the Standard Webhooks way
//! (`webhook-id`, `webhook-timestamp`, `webhook-signature`: HMAC-SHA256), so the usual
//! libraries verify them. Delivery is at least once: events wait in an SQLite outbox and
//! failures are retried with backoff for a day. Each event has an id and a per-run seq,
//! for the receiver to drop repeats and keep order. Webhooks only tell; they can't
//! answer or start anything.

use std::time::Duration;

use base64::Engine;
use offdesk_protocol::AgentRunInfo;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::db::integrations::{self, Delivery, Integration, RunState};
use crate::db::{self, DbPool};

/// The event types, in the order one update reports them.
pub const EVENT_TYPES: [&str; 7] = [
    "run.started",
    "run.request",
    "run.request_resolved",
    "run.status",
    "run.progress",
    "run.report",
    "run.ended",
];
/// Sent by "test" on an integration, whatever its filter.
pub const TEST_EVENT: &str = "integration.test";

/// After a day, an event that wouldn't go through is given up on.
const GIVE_UP_MS: i64 = 24 * 3600 * 1000;
const FIRST_RETRY_MS: i64 = 5_000;
const MAX_RETRY_MS: i64 = 3600 * 1000;
const POST_TIMEOUT: Duration = Duration::from_secs(10);

/// Wakes the worker for events queued outside it (a test from the API).
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// A new signing secret: `whsec_` and 32 random bytes in base64.
pub fn new_secret() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

/// The `webhook-signature` header: `v1,` and the base64 HMAC-SHA256 of
/// `<id>.<timestamp>.<body>` keyed with the secret's bytes. None for a bad secret.
pub fn sign(secret: &str, id: &str, timestamp: i64, body: &str) -> Option<String> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(secret.strip_prefix("whsec_").unwrap_or(secret))
        .ok()?;
    let mac = hmac_sha256(&key, format!("{id}.{timestamp}.{body}").as_bytes());
    Some(format!(
        "v1,{}",
        base64::engine::general_purpose::STANDARD.encode(mac)
    ))
}

/// What changed since webhooks last described a run, and how to describe it now.
pub fn changes(previous: Option<&RunState>, run: &AgentRunInfo) -> (Vec<&'static str>, RunState) {
    let next = RunState {
        seq: previous.map_or(0, |p| p.seq),
        status: run.status.as_str().to_string(),
        request_id: run.request.as_ref().map(|r| r.id.clone()),
        report_at: run.report.as_ref().map(|r| r.at_ms),
        progress: run.progress.as_ref().map(|p| (p.done, p.total)),
        ended: run.ended_at_ms.is_some(),
    };
    let Some(previous) = previous else {
        let mut events = vec!["run.started"];
        if next.request_id.is_some() {
            events.push("run.request");
        }
        if next.ended {
            events.push("run.ended");
        }
        return (events, next);
    };
    if previous.ended && next.ended {
        return (Vec::new(), next);
    }
    let mut events = Vec::new();
    let new_request = next.request_id.is_some() && next.request_id != previous.request_id;
    if new_request {
        events.push("run.request");
    } else if previous.request_id.is_some() && next.request_id.is_none() {
        events.push("run.request_resolved");
    }
    // A status change says itself, unless the request or the end says it better
    if next.status != previous.status && !new_request && !next.ended {
        events.push("run.status");
    }
    if next.progress != previous.progress && next.progress.is_some() {
        events.push("run.progress");
    }
    if next.report_at != previous.report_at && next.report_at.is_some() {
        events.push("run.report");
    }
    if next.ended && !previous.ended {
        events.push("run.ended");
    }
    (events, next)
}

/// The JSON body of an event (Standard Webhooks' `type`, `timestamp`, `data`).
pub fn body(event_type: &str, seq: i64, run: &AgentRunInfo, machine_name: &str) -> String {
    serde_json::json!({
        "type": event_type,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "data": {
            "seq": seq,
            "run": run,
            "machine": { "id": run.machine_id, "name": machine_name },
        },
    })
    .to_string()
}

fn event_id() -> String {
    format!("msg_{}", uuid::Uuid::new_v4().simple())
}

/// A run changed: an event per change for each enabled webhook that wants it and may
/// see the run's machine, at that integration's content level. Returns how many went
/// into the outbox.
pub fn on_run(conn: &rusqlite::Connection, user_id: &str, run: &AgentRunInfo) -> rusqlite::Result<usize> {
    let hooks: Vec<Integration> = integrations::list_for_user(conn, user_id)?
        .into_iter()
        .filter(|i| i.enabled && i.kind == "webhook")
        .collect();
    if hooks.is_empty() {
        return Ok(0);
    }
    let previous = integrations::run_state(conn, &run.id)?;
    let (events, mut next) = changes(previous.as_ref(), run);
    if events.is_empty() {
        if previous.as_ref() != Some(&next) {
            integrations::save_run_state(conn, &run.id, &next)?;
        }
        return Ok(0);
    }
    let machine = db::machines::find_machine_by_id(conn, &run.machine_id)?;
    let production = machine.as_ref().is_some_and(|m| m.production);
    let machine_name = machine.map(|m| m.name).unwrap_or_default();
    let first_seq = next.seq + 1;
    next.seq += events.len() as i64;
    let mut queued = 0;
    for hook in &hooks {
        if !hook.access.allows_machine(&run.machine_id, production) {
            continue;
        }
        let shown = crate::routes::agent_runs::shown_run(run.clone(), Some(hook.access.content));
        for (offset, event_type) in events.iter().enumerate() {
            if !hook.events.is_empty() && !hook.events.iter().any(|e| e == event_type) {
                continue;
            }
            let body = body(event_type, first_seq + offset as i64, &shown, &machine_name);
            integrations::enqueue(conn, &hook.id, &event_id(), event_type, &body)?;
            queued += 1;
        }
    }
    integrations::save_run_state(conn, &run.id, &next)?;
    Ok(queued)
}

/// Queues a test event for one integration, whatever its filter.
pub fn enqueue_test(conn: &rusqlite::Connection, hook: &Integration) -> rusqlite::Result<()> {
    let body = serde_json::json!({
        "type": TEST_EVENT,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "data": { "integration": hook.name },
    })
    .to_string();
    integrations::enqueue(conn, &hook.id, &event_id(), TEST_EVENT, &body)?;
    WAKE.notify_one();
    Ok(())
}

/// When to try a failed delivery again: backing off from 5 s to an hour, and giving
/// up a day after the event was made.
pub fn retry_at(delivery: &Delivery, now: i64) -> Option<i64> {
    if now - delivery.created_at >= GIVE_UP_MS {
        return None;
    }
    let delay = FIRST_RETRY_MS
        .saturating_mul(1i64 << delivery.attempts.clamp(0, 20))
        .min(MAX_RETRY_MS);
    Some(now + delay)
}

async fn post(client: &reqwest::Client, hook: &Integration, delivery: &Delivery) -> Result<(), String> {
    let timestamp = chrono::Utc::now().timestamp();
    let signature = sign(&hook.secret, &delivery.event_id, timestamp, &delivery.body)
        .ok_or_else(|| "the integration's secret is broken".to_string())?;
    let response = client
        .post(&hook.url)
        .header("content-type", "application/json")
        .header("webhook-id", &delivery.event_id)
        .header("webhook-timestamp", timestamp.to_string())
        .header("webhook-signature", signature)
        .body(delivery.body.clone())
        .send()
        .await
        .map_err(|error| {
            // Never the URL's query or the body: just what went wrong
            if error.is_timeout() {
                "timed out".to_string()
            } else if error.is_connect() {
                "couldn't connect".to_string()
            } else {
                "request failed".to_string()
            }
        })?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status().as_u16()))
    }
}

/// Delivers what's due now; returns how many it tried.
pub async fn deliver_due(pool: &DbPool, client: &reqwest::Client) -> usize {
    let due = match pool.get().map(|conn| integrations::due(&conn, db::now_ms(), 20)) {
        Ok(Ok(due)) => due,
        Ok(Err(error)) => {
            tracing::warn!("webhooks: {}", error);
            return 0;
        }
        Err(error) => {
            tracing::warn!("webhooks: {}", error);
            return 0;
        }
    };
    let tried = due.len();
    for (delivery, hook) in due {
        let result = post(client, &hook, &delivery).await;
        let Ok(conn) = pool.get() else { continue };
        let saved = match result {
            Ok(()) => integrations::mark_delivered(&conn, &delivery),
            Err(error) => {
                let retry = retry_at(&delivery, db::now_ms());
                if retry.is_none() {
                    tracing::warn!("webhook {} gave up on {}: {}", hook.name, delivery.event_id, error);
                }
                integrations::mark_failed(&conn, &delivery, &error, retry)
            }
        };
        if let Err(error) = saved {
            tracing::warn!("webhooks: {}", error);
        }
    }
    tried
}

/// Runs the webhook worker: turns run updates (from the returned sender) into outbox
/// events, one at a time so each run's events keep their order, and delivers what's
/// due. Picks up whatever the outbox held when the hub stopped.
pub fn spawn(pool: DbPool) -> mpsc::UnboundedSender<(Option<String>, AgentRunInfo)> {
    let (tx, mut rx) = mpsc::unbounded_channel::<(Option<String>, AgentRunInfo)>();
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(POST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("offdesk-hub/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("webhook client");
        loop {
            deliver_due(&pool, &client).await;
            let wait = pool
                .get()
                .ok()
                .and_then(|conn| integrations::next_due(&conn).ok().flatten())
                .map_or(Duration::from_secs(30), |at| {
                    Duration::from_millis((at - db::now_ms()).clamp(200, 30_000) as u64)
                });
            tokio::select! {
                update = rx.recv() => {
                    let Some((user_id, run)) = update else { break };
                    if let Ok(conn) = pool.get() {
                        // A run belongs to its machine's owner
                        let owner = match user_id {
                            Some(user_id) => Ok(Some(user_id)),
                            None => db::machines::find_machine_by_id(&conn, &run.machine_id)
                                .map(|machine| machine.map(|m| m.user_id)),
                        };
                        let result = owner.and_then(|owner| match owner {
                            Some(owner) => on_run(&conn, &owner, &run).map(|_| ()),
                            None => Ok(()),
                        });
                        if let Err(error) = result {
                            tracing::warn!("webhooks: {}", error);
                        }
                    }
                }
                _ = WAKE.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_protocol::AgentRunStatus;

    #[test]
    fn signatures_match_the_standard_webhooks_example() {
        // From the Standard Webhooks specification's test vector
        assert_eq!(
            sign(
                "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
                "msg_p5jXN8AQM9LWM0D4loKWxJek",
                1614265330,
                r#"{"test": 2432232314}"#
            )
            .unwrap(),
            "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
        );
        assert!(new_secret().starts_with("whsec_"));
        assert_ne!(new_secret(), new_secret());
        assert!(sign("whsec_not base64!", "id", 1, "{}").is_none());
    }

    fn run(status: AgentRunStatus) -> AgentRunInfo {
        serde_json::from_value(serde_json::json!({
            "id": "run-1", "machine_id": "machine-a", "agent": "claude", "cwd": "/w",
            "status": status.as_str(), "started_at_ms": 1, "updated_at_ms": 1,
        }))
        .unwrap()
    }

    fn waiting(prompt: &str) -> AgentRunInfo {
        let mut run = run(AgentRunStatus::Waiting);
        run.request = Some(serde_json::from_value(serde_json::json!({
            "id": "req-1", "kind": "question", "prompt": prompt, "source": "hooks", "created_at_ms": 2,
        })).unwrap());
        run
    }

    #[test]
    fn each_change_is_one_event() {
        let (events, started) = changes(None, &run(AgentRunStatus::Working));
        assert_eq!(events, ["run.started"]);
        let (events, asked) = changes(Some(&started), &waiting("Which plan?"));
        assert_eq!(events, ["run.request"], "the request says the status");
        let (events, same) = changes(Some(&asked), &waiting("Which plan?"));
        assert!(events.is_empty() && same == asked);
        let (events, answered) = changes(Some(&asked), &run(AgentRunStatus::Working));
        assert_eq!(events, ["run.request_resolved", "run.status"]);
        let mut done = run(AgentRunStatus::Done);
        done.ended_at_ms = Some(9);
        done.report = Some(serde_json::from_value(serde_json::json!({ "kind": "finished", "text": "PR", "at_ms": 8 })).unwrap());
        let (events, ended) = changes(Some(&answered), &done);
        assert_eq!(events, ["run.report", "run.ended"]);
        // An ended run says nothing more
        assert!(changes(Some(&ended), &done).0.is_empty());
    }

    #[test]
    fn retries_back_off_and_stop_after_a_day() {
        let delivery = |attempts, created_at| Delivery {
            id: 1, integration_id: "i".into(), event_id: "e".into(), event_type: "t".into(), body: "{}".into(),
            attempts, created_at, next_attempt_at: 0, delivered_at: None, failed_at: None, last_error: None,
        };
        assert_eq!(retry_at(&delivery(0, 0), 1000), Some(1000 + 5_000));
        assert_eq!(retry_at(&delivery(3, 0), 1000), Some(1000 + 40_000));
        assert_eq!(retry_at(&delivery(30, 0), 1000), Some(1000 + 3_600_000));
        assert_eq!(retry_at(&delivery(1, 0), GIVE_UP_MS), None);
    }

    /// A receiver on localhost that checks each signature, records what it got, and
    /// fails while `fail` is set.
    async fn receiver(
        secret: String,
        fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        use axum::{http::HeaderMap, routing::post, Router};
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = got.clone();
        let app = Router::new().route(
            "/hook",
            post(move |headers: HeaderMap, body: String| {
                let (seen, fail, secret) = (seen.clone(), fail.clone(), secret.clone());
                async move {
                    let header = |name: &str| headers.get(name).unwrap().to_str().unwrap().to_string();
                    let expected = sign(&secret, &header("webhook-id"), header("webhook-timestamp").parse().unwrap(), &body);
                    assert_eq!(Some(header("webhook-signature")), expected, "signed");
                    if fail.load(std::sync::atomic::Ordering::SeqCst) {
                        return axum::http::StatusCode::SERVICE_UNAVAILABLE;
                    }
                    let mut value: serde_json::Value = serde_json::from_str(&body).unwrap();
                    value["webhook-id"] = header("webhook-id").into();
                    seen.lock().unwrap().push(value);
                    axum::http::StatusCode::NO_CONTENT
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, got)
    }

    fn file_pool(path: &str) -> DbPool {
        let pool = db::create_pool(path).unwrap();
        db::init_db(&pool.get().unwrap()).unwrap();
        pool
    }

    #[tokio::test]
    async fn events_are_signed_filtered_retried_and_survive_a_restart() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let path = std::env::temp_dir().join(format!("offdesk-webhooks-{}.db", uuid::Uuid::new_v4()));
        let path = path.to_string_lossy().into_owned();
        let pool = file_pool(&path);
        {
            let conn = pool.get().unwrap();
            db::users::create_user(&conn, "user-a", "test", "user-a", "user-a", None, "admin").unwrap();
            db::machines::ensure_machine_for_user(&conn, "machine-a", "user-a", "studio", Some("linux"), Some("/tmp")).unwrap();
        }
        let secret = new_secret();
        let fail = std::sync::Arc::new(AtomicBool::new(true));
        let (url, got) = receiver(secret.clone(), fail.clone()).await;
        let hook = Integration {
            id: "hook-1".into(), user_id: "user-a".into(), kind: "webhook".into(), name: "phone".into(),
            url, secret, events: vec!["run.request".into(), "run.ended".into()],
            access: offdesk_protocol::TokenAccess { scopes: vec![offdesk_protocol::TokenScope::RunsRead], ..Default::default() },
            enabled: true, created_at: 0, last_delivery_at: None, last_error: None,
        };
        integrations::insert(&pool.get().unwrap(), &hook).unwrap();
        let client = reqwest::Client::new();

        // Only the events it asked for go out, and at metadata level without the question
        let conn = pool.get().unwrap();
        assert_eq!(on_run(&conn, "user-a", &run(AgentRunStatus::Working)).unwrap(), 0);
        assert_eq!(on_run(&conn, "user-a", &waiting("Which plan?")).unwrap(), 1);
        drop(conn);
        // The receiver is down: it waits for a retry
        assert_eq!(deliver_due(&pool, &client).await, 1);
        assert!(got.lock().unwrap().is_empty());
        let pending = integrations::recent_deliveries(&pool.get().unwrap(), "hook-1", 10).unwrap();
        assert_eq!((pending[0].attempts, pending[0].last_error.as_deref()), (1, Some("HTTP 503")));
        assert!(pending[0].next_attempt_at > db::now_ms());
        let stored = integrations::find_for_user(&pool.get().unwrap(), "hook-1", "user-a").unwrap().unwrap();
        assert_eq!(stored.last_error.as_deref(), Some("HTTP 503"));

        // The hub stops; another starts on the same database once the receiver is back
        drop(pool);
        fail.store(false, Ordering::SeqCst);
        let pool = file_pool(&path);
        pool.get().unwrap().execute("UPDATE webhook_outbox SET next_attempt_at = 0", []).unwrap();
        assert_eq!(deliver_due(&pool, &client).await, 1);
        {
            let got = got.lock().unwrap();
            assert_eq!(got.len(), 1);
            assert_eq!(got[0]["type"], "run.request");
            assert_eq!(got[0]["data"]["seq"], 2);
            assert_eq!(got[0]["data"]["machine"]["name"], "studio");
            assert!(got[0]["data"]["run"]["request"].get("prompt").is_none(), "metadata only: {}", got[0]);
            assert_eq!(got[0]["webhook-id"], pending[0].event_id, "the same id on every attempt");
        }
        assert_eq!(deliver_due(&pool, &client).await, 0, "delivered once");

        // Turned off, nothing goes out; removed, nothing waits for it
        let conn = pool.get().unwrap();
        integrations::set_enabled(&conn, "hook-1", "user-a", false).unwrap();
        let mut done = run(AgentRunStatus::Done);
        done.ended_at_ms = Some(5);
        assert_eq!(on_run(&conn, "user-a", &done).unwrap(), 0);
        integrations::set_enabled(&conn, "hook-1", "user-a", true).unwrap();
        enqueue_test(&conn, &integrations::find_for_user(&conn, "hook-1", "user-a").unwrap().unwrap()).unwrap();
        integrations::delete(&conn, "hook-1", "user-a").unwrap();
        assert_eq!(integrations::next_due(&conn).unwrap(), None);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
