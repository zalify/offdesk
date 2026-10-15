//! Integrations (docs/plans/2026-10-14-agent-runs-external-access.md, B2): outside
//! systems that get agent run events. A webhook integration has a URL, a signing secret,
//! the events it wants, and what it may see (machines, content level). Events wait in an
//! outbox until delivered, so a hub restart loses none.

use offdesk_protocol::TokenAccess;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::now_ms;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Integration {
    pub id: String,
    #[serde(skip)]
    pub user_id: String,
    pub kind: String,
    pub name: String,
    pub url: String,
    /// Standard Webhooks secret (`whsec_…`); never listed, shown once when made.
    #[serde(skip)]
    pub secret: String,
    /// The event types it gets; empty: all of them.
    pub events: Vec<String>,
    /// Its machines and content level (scopes are `runs:read`).
    pub access: TokenAccess,
    pub enabled: bool,
    pub created_at: i64,
    pub last_delivery_at: Option<i64>,
    pub last_error: Option<String>,
    /// A bridge's one-time pairing code, until the server has taken it.
    #[serde(skip)]
    pub pairing_code: Option<String>,
}

const COLUMNS: &str = "id, user_id, kind, name, url, secret, events, access, enabled, created_at, \
     last_delivery_at, last_error, pairing_code";

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<Integration> {
    Ok(Integration {
        id: row.get(0)?,
        user_id: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        url: row.get(4)?,
        secret: row.get(5)?,
        events: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        // Access that doesn't read sees nothing: no machines
        access: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_else(|_| TokenAccess {
            machines: Some(Vec::new()),
            ..Default::default()
        }),
        enabled: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        last_delivery_at: row.get(10)?,
        last_error: row.get(11)?,
        pairing_code: row.get(12)?,
    })
}

pub fn insert(conn: &Connection, integration: &Integration) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO integrations (id, user_id, kind, name, url, secret, events, access, enabled, created_at, pairing_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            integration.id,
            integration.user_id,
            integration.kind,
            integration.name,
            integration.url,
            integration.secret,
            serde_json::to_string(&integration.events).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&integration.access).unwrap_or_else(|_| "{}".into()),
            integration.enabled as i64,
            integration.created_at,
            integration.pairing_code,
        ],
    )?;
    Ok(())
}

/// Every enabled bridge, of every user (the hub keeps each connected).
pub fn enabled_bridges(conn: &Connection) -> rusqlite::Result<Vec<Integration>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM integrations WHERE kind = 'bridge' AND enabled = 1"
    ))?;
    let rows = stmt.query_map([], map_row)?;
    rows.collect()
}

/// Finds an integration by id alone (the hub's own tasks; never for a request).
pub fn find(conn: &Connection, id: &str) -> rusqlite::Result<Option<Integration>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM integrations WHERE id = ?1"),
        params![id],
        map_row,
    )
    .optional()
}

/// The server took the pairing code: from now on the bridge key alone signs in.
pub fn paired(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE integrations SET pairing_code = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn record_bridge_error(conn: &Connection, id: &str, error: Option<&str>) -> rusqlite::Result<()> {
    record_result(conn, id, error)
}

/// A bridge's events the server hasn't acknowledged, after `after` (an outbox id), oldest first.
pub fn unacked(conn: &Connection, integration_id: &str, after: i64, limit: i64) -> rusqlite::Result<Vec<Delivery>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DELIVERY_COLUMNS} FROM webhook_outbox
         WHERE integration_id = ?1 AND delivered_at IS NULL AND failed_at IS NULL AND id > ?2
         ORDER BY id LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![integration_id, after, limit], map_delivery)?;
    rows.collect()
}

/// The server has everything up to `seq` (an outbox id): those are delivered.
pub fn ack(conn: &Connection, integration_id: &str, seq: i64) -> rusqlite::Result<usize> {
    let now = now_ms();
    let acked = conn.execute(
        "UPDATE webhook_outbox SET delivered_at = ?1, attempts = attempts + 1
         WHERE integration_id = ?2 AND id <= ?3 AND delivered_at IS NULL",
        params![now, integration_id, seq],
    )?;
    if acked > 0 {
        record_result(conn, integration_id, None)?;
    }
    Ok(acked)
}

/// The result a command already got, if it was carried out before.
pub fn command_result(conn: &Connection, integration_id: &str, command_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT result FROM bridge_commands WHERE integration_id = ?1 AND command_id = ?2",
        params![integration_id, command_id],
        |row| row.get(0),
    )
    .optional()
}

pub fn save_command_result(conn: &Connection, integration_id: &str, command_id: &str, result: &str) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT OR REPLACE INTO bridge_commands (integration_id, command_id, result, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![integration_id, command_id, result, now],
    )?;
    conn.execute(
        "DELETE FROM bridge_commands WHERE created_at < ?1",
        params![now - 7 * 24 * 3600 * 1000],
    )?;
    Ok(())
}

pub fn list_for_user(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Integration>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM integrations WHERE user_id = ?1 ORDER BY created_at"
    ))?;
    let rows = stmt.query_map(params![user_id], map_row)?;
    rows.collect()
}

pub fn find_for_user(
    conn: &Connection,
    id: &str,
    user_id: &str,
) -> rusqlite::Result<Option<Integration>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM integrations WHERE id = ?1 AND user_id = ?2"),
        params![id, user_id],
        map_row,
    )
    .optional()
}

pub fn set_enabled(conn: &Connection, id: &str, user_id: &str, enabled: bool) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE integrations SET enabled = ?1 WHERE id = ?2 AND user_id = ?3",
        params![enabled as i64, id, user_id],
    )? > 0)
}

/// Removes it and everything still waiting for it (foreign keys aren't on for every
/// pooled connection, so the outbox is cleared here, not by cascade).
pub fn delete(conn: &Connection, id: &str, user_id: &str) -> rusqlite::Result<bool> {
    let removed = conn.execute(
        "DELETE FROM integrations WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    )? > 0;
    if removed {
        conn.execute("DELETE FROM webhook_outbox WHERE integration_id = ?1", params![id])?;
        conn.execute("DELETE FROM bridge_commands WHERE integration_id = ?1", params![id])?;
    }
    Ok(removed)
}

fn record_result(conn: &Connection, id: &str, error: Option<&str>) -> rusqlite::Result<()> {
    match error {
        None => conn.execute(
            "UPDATE integrations SET last_delivery_at = ?1, last_error = NULL WHERE id = ?2",
            params![now_ms(), id],
        )?,
        Some(error) => conn.execute(
            "UPDATE integrations SET last_error = ?1 WHERE id = ?2",
            params![error, id],
        )?,
    };
    Ok(())
}

// ── What was last said about each run ──

/// The run as webhooks last described it, to tell what changed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunState {
    pub seq: i64,
    pub status: String,
    pub request_id: Option<String>,
    pub report_at: Option<i64>,
    pub progress: Option<(u32, u32)>,
    pub ended: bool,
}

pub fn run_state(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<RunState>> {
    conn.query_row(
        "SELECT seq, status, request_id, report_at, progress_done, progress_total, ended
         FROM webhook_run_state WHERE run_id = ?1",
        params![run_id],
        |row| {
            Ok(RunState {
                seq: row.get(0)?,
                status: row.get(1)?,
                request_id: row.get(2)?,
                report_at: row.get(3)?,
                progress: match (row.get::<_, Option<u32>>(4)?, row.get::<_, Option<u32>>(5)?) {
                    (Some(done), Some(total)) => Some((done, total)),
                    _ => None,
                },
                ended: row.get::<_, i64>(6)? != 0,
            })
        },
    )
    .optional()
}

pub fn save_run_state(conn: &Connection, run_id: &str, state: &RunState) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO webhook_run_state (run_id, seq, status, request_id, report_at, progress_done, progress_total, ended, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(run_id) DO UPDATE SET seq = ?2, status = ?3, request_id = ?4, report_at = ?5,
             progress_done = ?6, progress_total = ?7, ended = ?8, updated_at = ?9",
        params![
            run_id,
            state.seq,
            state.status,
            state.request_id,
            state.report_at,
            state.progress.map(|p| p.0),
            state.progress.map(|p| p.1),
            state.ended as i64,
            now_ms()
        ],
    )?;
    // Runs that ended a week ago won't change again
    conn.execute(
        "DELETE FROM webhook_run_state WHERE ended = 1 AND updated_at < ?1",
        params![now_ms() - 7 * 24 * 3600 * 1000],
    )?;
    Ok(())
}

// ── The outbox ──

/// An event waiting to be delivered (or given up on), with its rendered body.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Delivery {
    pub id: i64,
    pub integration_id: String,
    /// `webhook-id`: the same on every retry, for the receiver to drop repeats.
    pub event_id: String,
    pub event_type: String,
    #[serde(skip)]
    pub body: String,
    pub attempts: i64,
    pub created_at: i64,
    pub next_attempt_at: i64,
    pub delivered_at: Option<i64>,
    pub failed_at: Option<i64>,
    pub last_error: Option<String>,
}

const DELIVERY_COLUMNS: &str = "id, integration_id, event_id, event_type, body, attempts, created_at, \
     next_attempt_at, delivered_at, failed_at, last_error";

fn map_delivery(row: &rusqlite::Row) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        id: row.get(0)?,
        integration_id: row.get(1)?,
        event_id: row.get(2)?,
        event_type: row.get(3)?,
        body: row.get(4)?,
        attempts: row.get(5)?,
        created_at: row.get(6)?,
        next_attempt_at: row.get(7)?,
        delivered_at: row.get(8)?,
        failed_at: row.get(9)?,
        last_error: row.get(10)?,
    })
}

pub fn enqueue(
    conn: &Connection,
    integration_id: &str,
    event_id: &str,
    event_type: &str,
    body: &str,
) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO webhook_outbox (integration_id, event_id, event_type, body, attempts, created_at, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![integration_id, event_id, event_type, body, now],
    )?;
    Ok(())
}

/// Webhook deliveries due now, oldest first, for enabled webhooks (a bridge's events
/// go over its connection instead).
pub fn due(conn: &Connection, now: i64, limit: i64) -> rusqlite::Result<Vec<(Delivery, Integration)>> {
    let mut stmt = conn.prepare(
        "SELECT o.id FROM webhook_outbox o JOIN integrations i ON i.id = o.integration_id
         WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_attempt_at <= ?1
           AND i.enabled = 1 AND i.kind = 'webhook'
         ORDER BY o.id LIMIT ?2",
    )?;
    let ids: Vec<i64> = stmt
        .query_map(params![now, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let delivery = conn.query_row(
            &format!("SELECT {DELIVERY_COLUMNS} FROM webhook_outbox WHERE id = ?1"),
            params![id],
            map_delivery,
        )?;
        let integration = conn.query_row(
            &format!("SELECT {COLUMNS} FROM integrations WHERE id = ?1"),
            params![delivery.integration_id],
            map_row,
        )?;
        out.push((delivery, integration));
    }
    Ok(out)
}

/// When the next waiting delivery is due, if any.
pub fn next_due(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT min(o.next_attempt_at) FROM webhook_outbox o JOIN integrations i ON i.id = o.integration_id
         WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND i.enabled = 1 AND i.kind = 'webhook'",
        [],
        |row| row.get(0),
    )
}

pub fn mark_delivered(conn: &Connection, delivery: &Delivery) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE webhook_outbox SET delivered_at = ?1, attempts = attempts + 1, last_error = NULL WHERE id = ?2",
        params![now_ms(), delivery.id],
    )?;
    record_result(conn, &delivery.integration_id, None)
}

/// A failed attempt: retried at `retry_at`, or given up on when that's None.
pub fn mark_failed(
    conn: &Connection,
    delivery: &Delivery,
    error: &str,
    retry_at: Option<i64>,
) -> rusqlite::Result<()> {
    match retry_at {
        Some(at) => conn.execute(
            "UPDATE webhook_outbox SET attempts = attempts + 1, next_attempt_at = ?1, last_error = ?2 WHERE id = ?3",
            params![at, error, delivery.id],
        )?,
        None => conn.execute(
            "UPDATE webhook_outbox SET attempts = attempts + 1, failed_at = ?1, last_error = ?2 WHERE id = ?3",
            params![now_ms(), error, delivery.id],
        )?,
    };
    record_result(conn, &delivery.integration_id, Some(error))
}

/// An integration's recent deliveries, newest first; delivered ones older than a week go.
pub fn recent_deliveries(
    conn: &Connection,
    integration_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<Delivery>> {
    conn.execute(
        "DELETE FROM webhook_outbox WHERE (delivered_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at < ?1",
        params![now_ms() - 7 * 24 * 3600 * 1000],
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {DELIVERY_COLUMNS} FROM webhook_outbox WHERE integration_id = ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![integration_id, limit], map_delivery)?;
    rows.collect()
}
