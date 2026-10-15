use rusqlite::{params, Connection};

use super::now_ms;
use super::types::{ApiTokenRow, LoginCodeRow, RegistrationTokenRow};

pub fn create_registration_token(
    conn: &Connection,
    id: &str,
    user_id: &str,
    machine_name: &str,
    token_hash: &str,
    expires_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO registration_tokens (id, user_id, machine_name, token_hash, expires_at, used)
         VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![id, user_id, machine_name, token_hash, expires_at],
    )?;
    Ok(())
}

pub fn find_registration_token_by_hash(
    conn: &Connection,
    token_hash: &str,
) -> rusqlite::Result<Option<RegistrationTokenRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, machine_name, token_hash, expires_at, used
         FROM registration_tokens WHERE token_hash = ?1",
    )?;
    let mut rows = stmt.query_map(params![token_hash], |row| {
        Ok(RegistrationTokenRow {
            id: row.get(0)?,
            user_id: row.get(1)?,
            machine_name: row.get(2)?,
            token_hash: row.get(3)?,
            expires_at: row.get(4)?,
            used: row.get::<_, i64>(5)? != 0,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn consume_registration_token(conn: &Connection, token_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE registration_tokens SET used = 1 WHERE id = ?1",
        params![token_id],
    )?;
    Ok(())
}

pub fn cleanup_expired_tokens(conn: &Connection) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "DELETE FROM registration_tokens WHERE expires_at < ?1 OR used = 1",
        params![now],
    )?;
    Ok(())
}

pub fn create_api_token(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    token_hash: &str,
    expires_at: Option<i64>,
) -> rusqlite::Result<()> {
    create_scoped_api_token(conn, id, user_id, name, token_hash, expires_at, None)
}

/// An API token limited to `access` (None: full access).
pub fn create_scoped_api_token(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    token_hash: &str,
    expires_at: Option<i64>,
    access: Option<&offdesk_protocol::TokenAccess>,
) -> rusqlite::Result<()> {
    let created_at = now_ms();
    let access = access
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at, access)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, user_id, name, token_hash, created_at, expires_at, access],
    )?;
    Ok(())
}

const API_TOKEN_COLUMNS: &str =
    "id, user_id, name, token_hash, created_at, last_used_at, expires_at, access";

fn api_token_row(row: &rusqlite::Row) -> rusqlite::Result<ApiTokenRow> {
    Ok(ApiTokenRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        token_hash: row.get(3)?,
        created_at: row.get(4)?,
        last_used_at: row.get(5)?,
        expires_at: row.get(6)?,
        // Access that no longer reads (a newer hub's) is treated as nothing allowed,
        // never as full: an empty scope list passes no check
        access: row
            .get::<_, Option<String>>(7)?
            .map(|json| serde_json::from_str(&json).unwrap_or_default()),
    })
}

pub fn find_api_token_by_hash(
    conn: &Connection,
    token_hash: &str,
) -> rusqlite::Result<Option<ApiTokenRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {API_TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1"
    ))?;
    let mut rows = stmt.query_map(params![token_hash], api_token_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn list_api_tokens_by_user(
    conn: &Connection,
    user_id: &str,
) -> rusqlite::Result<Vec<ApiTokenRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {API_TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?1
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![user_id], api_token_row)?;
    rows.collect()
}

/// One thing an API token did or was refused (docs/plans/2026-10-14-agent-runs-external-access.md):
/// answers, approvals and starts, and requests outside its scopes.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct TokenAuditEntry {
    pub token_id: String,
    pub token_name: String,
    /// "answer", "approve", "start", or "denied".
    pub action: String,
    /// The run, machine or route it was about.
    pub target: String,
    /// "ok", or why it was refused.
    pub result: String,
    pub at_ms: i64,
}

pub fn insert_audit(
    conn: &Connection,
    user_id: &str,
    token_id: &str,
    token_name: &str,
    action: &str,
    target: &str,
    result: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_token_audit (user_id, token_id, token_name, action, target, result, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![user_id, token_id, token_name, action, target, result, now_ms()],
    )?;
    // Keep the newest 10,000 per user
    conn.execute(
        "DELETE FROM api_token_audit WHERE user_id = ?1 AND id <= (
             SELECT id FROM api_token_audit WHERE user_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET 10000)",
        params![user_id],
    )?;
    Ok(())
}

/// Newest first; `token_id` narrows it to one token.
pub fn list_audit(
    conn: &Connection,
    user_id: &str,
    token_id: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<TokenAuditEntry>> {
    let mut stmt = conn.prepare(
        "SELECT token_id, token_name, action, target, result, created_at FROM api_token_audit
         WHERE user_id = ?1 AND (?2 IS NULL OR token_id = ?2)
         ORDER BY id DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![user_id, token_id, limit], |row| {
        Ok(TokenAuditEntry {
            token_id: row.get(0)?,
            token_name: row.get(1)?,
            action: row.get(2)?,
            target: row.get(3)?,
            result: row.get(4)?,
            at_ms: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// How many times a token did `actions` successfully since `since_ms` (for its hourly limits).
pub fn count_audit(
    conn: &Connection,
    token_id: &str,
    actions: &[&str],
    since_ms: i64,
) -> rusqlite::Result<i64> {
    let mut total = 0;
    for action in actions {
        total += conn.query_row(
            "SELECT count(*) FROM api_token_audit
             WHERE token_id = ?1 AND action = ?2 AND result = 'ok' AND created_at >= ?3",
            params![token_id, action, since_ms],
            |row| row.get::<_, i64>(0),
        )?;
    }
    Ok(total)
}

pub fn delete_api_token(conn: &Connection, token_id: &str, user_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM api_tokens WHERE id = ?1 AND user_id = ?2",
        params![token_id, user_id],
    )?;
    Ok(())
}

pub fn update_api_token_last_used(conn: &Connection, token_id: &str) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2",
        params![now, token_id],
    )?;
    Ok(())
}

// ── Login codes ──

pub fn create_login_code(
    conn: &Connection,
    id: &str,
    user_id: &str,
    code_hash: &str,
    expires_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO login_codes (id, user_id, code_hash, expires_at, used) VALUES (?1, ?2, ?3, ?4, 0)",
        params![id, user_id, code_hash, expires_at],
    )?;
    Ok(())
}

pub fn find_login_code_by_hash(
    conn: &Connection,
    code_hash: &str,
) -> rusqlite::Result<Option<LoginCodeRow>> {
    let mut stmt =
        conn.prepare("SELECT id, user_id, expires_at, used FROM login_codes WHERE code_hash = ?1")?;
    let mut rows = stmt.query_map(params![code_hash], |row| {
        Ok(LoginCodeRow {
            id: row.get(0)?,
            user_id: row.get(1)?,
            expires_at: row.get(2)?,
            used: row.get::<_, i64>(3)? != 0,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Marks the code used, and says whether this call was the one that did —
/// two phones racing on one code get one session between them.
pub fn consume_login_code(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE login_codes SET used = 1 WHERE id = ?1 AND used = 0",
        params![id],
    )?;
    Ok(changed == 1)
}

pub fn cleanup_login_codes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM login_codes WHERE expires_at < ?1 OR used = 1",
        params![now_ms()],
    )?;
    Ok(())
}
