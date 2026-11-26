//! Draft version history and public share links.
//!
//! Shares are the hub's only unauthenticated surface: the token is the sole
//! credential, and everything else (owner, target, view) is resolved from the
//! stored share row at request time.

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::draft_databases::{
    self as dd, Column, DdError, QueryRequest, Sort, View, PUBLIC_MAX_LIMIT,
};
use super::drafts::DraftRow;
use super::now_ms;

type R<T> = Result<T, DdError>;

/// Versions kept per draft (newest first).
pub const MAX_VERSIONS: i64 = 30;
/// Longest accepted share lifetime.
pub const MAX_EXPIRES_IN_DAYS: f64 = 3650.0;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct VersionSummary {
    pub id: String,
    pub title: String,
    /// Bytes of the version's content.
    pub size: i64,
    pub created_at: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct VersionFull {
    pub id: String,
    pub draft_id: String,
    pub title: String,
    pub content: String,
    pub created_at: i64,
}

/// Save a draft's previous state and prune to the newest `MAX_VERSIONS`.
/// Callers run this inside the write transaction that overwrites the draft.
pub fn record_version(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
    title: &str,
    content: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO draft_versions (id, draft_id, user_id, title, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            draft_id,
            user_id,
            title,
            content,
            now_ms()
        ],
    )?;
    conn.execute(
        "DELETE FROM draft_versions
         WHERE draft_id = ?1 AND rowid NOT IN (
             SELECT rowid FROM draft_versions WHERE draft_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2
         )",
        params![draft_id, MAX_VERSIONS],
    )?;
    Ok(())
}

fn draft_exists(conn: &Connection, user_id: &str, draft_id: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM drafts WHERE id = ?1 AND user_id = ?2",
            params![draft_id, user_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// `None` when the draft does not exist (or is not the user's).
pub fn list_versions(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
) -> rusqlite::Result<Option<Vec<VersionSummary>>> {
    if !draft_exists(conn, user_id, draft_id)? {
        return Ok(None);
    }
    let mut stmt = conn.prepare(
        "SELECT id, title, length(CAST(content AS BLOB)), created_at FROM draft_versions
         WHERE draft_id = ?1 AND user_id = ?2
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = stmt
        .query_map(params![draft_id, user_id], |r| {
            Ok(VersionSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                size: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(rows))
}

pub fn get_version(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
    version_id: &str,
) -> rusqlite::Result<Option<VersionFull>> {
    conn.query_row(
        "SELECT id, draft_id, title, content, created_at FROM draft_versions
         WHERE id = ?1 AND draft_id = ?2 AND user_id = ?3",
        params![version_id, draft_id, user_id],
        |r| {
            Ok(VersionFull {
                id: r.get(0)?,
                draft_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )
    .optional()
}

/// Restore a version: the current state is saved as a version first.
pub fn restore_version(
    conn: &mut Connection,
    user_id: &str,
    draft_id: &str,
    version_id: &str,
) -> rusqlite::Result<Option<DraftRow>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(version) = get_version(&tx, user_id, draft_id, version_id)? else {
        return Ok(None);
    };
    let Some(current) = super::drafts::get_draft(&tx, user_id, draft_id)? else {
        return Ok(None);
    };
    record_version(&tx, user_id, draft_id, &current.title, &current.content)?;
    tx.execute(
        "UPDATE drafts SET title = ?1, content = ?2, updated_at = ?3
         WHERE id = ?4 AND user_id = ?5",
        params![version.title, version.content, now_ms(), draft_id, user_id],
    )?;
    let out = super::drafts::get_draft(&tx, user_id, draft_id)?;
    tx.commit()?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

/// A full `draft_shares` row.
#[derive(Debug, Clone)]
pub struct ShareRow {
    pub id: String,
    pub user_id: String,
    pub token: String,
    pub kind: String,
    pub target_id: String,
    pub mode: String,
    pub view_id: Option<String>,
    pub snapshot_title: Option<String>,
    pub snapshot_content: Option<String>,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
}

const SHARE_SELECT: &str = "id, user_id, token, kind, target_id, mode, view_id, snapshot_title,
    snapshot_content, expires_at, revoked_at, created_at";

fn map_share(r: &rusqlite::Row<'_>) -> rusqlite::Result<ShareRow> {
    Ok(ShareRow {
        id: r.get(0)?,
        user_id: r.get(1)?,
        token: r.get(2)?,
        kind: r.get(3)?,
        target_id: r.get(4)?,
        mode: r.get(5)?,
        view_id: r.get(6)?,
        snapshot_title: r.get(7)?,
        snapshot_content: r.get(8)?,
        expires_at: r.get(9)?,
        revoked_at: r.get(10)?,
        created_at: r.get(11)?,
    })
}

/// A share with what the management API shows beside it.
#[derive(Debug, Clone)]
pub struct ShareRecord {
    pub row: ShareRow,
    pub target_title: String,
    /// Sources of the stored assets, in index order.
    pub assets: Vec<String>,
}

/// An image to store with a share.
#[derive(Debug, Clone)]
pub struct StoredAsset {
    pub source: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// A validated share target, produced before any machine read so the slow
/// work happens outside a DB transaction.
#[derive(Debug, Clone)]
pub struct PreparedShare {
    pub kind: String,
    pub target_id: String,
    pub mode: String,
    pub view_id: Option<String>,
    pub title: String,
    /// Draft shares: the content at preparation time (snapshot source and the
    /// text scanned for images).
    pub content: Option<String>,
}

fn bad<T>(msg: impl Into<String>) -> R<T> {
    Err(DdError::BadRequest(msg.into()))
}

/// 32 bytes from the OS CSPRNG, base64url without padding (43 chars).
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("random source unavailable: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Cheap shape check so garbage never reaches the database.
pub fn token_shape_ok(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Validate a share request against what the user owns.
pub fn prepare_share(
    conn: &Connection,
    user_id: &str,
    kind: &str,
    target_id: &str,
    mode: Option<&str>,
    view_id: Option<&str>,
) -> R<PreparedShare> {
    match kind {
        "draft" => {
            let mode = match mode {
                None => "snapshot",
                Some(m @ ("snapshot" | "live")) => m,
                Some(other) => {
                    return bad(format!("unknown mode '{other}' (expected snapshot or live)"))
                }
            };
            if view_id.is_some() {
                return bad("view_id only applies to database shares");
            }
            let draft = super::drafts::get_draft(conn, user_id, target_id)?
                .ok_or_else(|| DdError::NotFound("draft not found".into()))?;
            Ok(PreparedShare {
                kind: "draft".into(),
                target_id: draft.id,
                mode: mode.into(),
                view_id: None,
                title: draft.title,
                content: Some(draft.content),
            })
        }
        "database" => {
            if let Some(m) = mode {
                if m != "live" {
                    return bad("database shares must use mode 'live'");
                }
            }
            let db = dd::get_database(conn, user_id, target_id)?;
            let view = match view_id.filter(|v| !v.is_empty()) {
                Some(v) => db
                    .views
                    .iter()
                    .find(|x| x.id == v)
                    .ok_or_else(|| DdError::BadRequest(format!("unknown view '{v}'")))?,
                None => db
                    .views
                    .first()
                    .ok_or_else(|| DdError::BadRequest("database has no views".into()))?,
            };
            Ok(PreparedShare {
                kind: "database".into(),
                target_id: db.id.clone(),
                mode: "live".into(),
                view_id: Some(view.id.clone()),
                title: db.name,
                content: None,
            })
        }
        other => bad(format!("unknown kind '{other}' (expected draft or database)")),
    }
}

/// Convert `expires_in_days` into an absolute expiry (ms epoch).
pub fn expiry_from_days(days: Option<f64>) -> R<Option<i64>> {
    match days {
        None => Ok(None),
        Some(d) if d.is_finite() && d > 0.0 && d <= MAX_EXPIRES_IN_DAYS => {
            Ok(Some(now_ms().saturating_add((d * 86_400_000.0) as i64)))
        }
        Some(_) => bad(format!(
            "expires_in_days must be a positive number of at most {MAX_EXPIRES_IN_DAYS}"
        )),
    }
}

/// Create the share (and its asset rows) in one transaction. Draft shares pin
/// the draft so the auto-archive never hides it.
pub fn create_share(
    conn: &mut Connection,
    user_id: &str,
    prepared: &PreparedShare,
    expires_at: Option<i64>,
    assets: &[StoredAsset],
) -> R<ShareRecord> {
    let token = generate_token().map_err(DdError::Internal)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Re-check the target inside the transaction: it may have gone while the
    // images were being read.
    let (snapshot_title, snapshot_content) = if prepared.kind == "draft" {
        if !draft_exists(&tx, user_id, &prepared.target_id)? {
            return Err(DdError::NotFound("draft not found".into()));
        }
        tx.execute(
            "UPDATE drafts SET pinned = 1 WHERE id = ?1 AND user_id = ?2",
            params![prepared.target_id, user_id],
        )?;
        if prepared.mode == "snapshot" {
            (Some(prepared.title.clone()), prepared.content.clone())
        } else {
            (None, None)
        }
    } else {
        let db = dd::get_database(&tx, user_id, &prepared.target_id)?;
        let wanted = prepared.view_id.as_deref().unwrap_or_default();
        if !db.views.iter().any(|v| v.id == wanted) {
            return Err(DdError::NotFound("view not found".into()));
        }
        (None, None)
    };
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_ms();
    tx.execute(
        "INSERT INTO draft_shares (id, user_id, token, kind, target_id, mode, view_id,
            snapshot_title, snapshot_content, expires_at, revoked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)",
        params![
            id,
            user_id,
            token,
            prepared.kind,
            prepared.target_id,
            prepared.mode,
            prepared.view_id,
            snapshot_title,
            snapshot_content,
            expires_at,
            created_at
        ],
    )?;
    for (idx, a) in assets.iter().enumerate() {
        tx.execute(
            "INSERT INTO draft_share_assets (share_id, idx, source, mime, bytes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, idx as i64, a.source, a.mime, a.bytes],
        )?;
    }
    let row = tx.query_row(
        &format!("SELECT {SHARE_SELECT} FROM draft_shares WHERE id = ?1"),
        params![id],
        map_share,
    )?;
    let out = ShareRecord {
        target_title: prepared.title.clone(),
        assets: assets.iter().map(|a| a.source.clone()).collect(),
        row,
    };
    tx.commit()?;
    Ok(out)
}

fn share_assets(conn: &Connection, share_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT source FROM draft_share_assets WHERE share_id = ?1 ORDER BY idx")?;
    let rows = stmt
        .query_map(params![share_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn target_title(conn: &Connection, row: &ShareRow) -> rusqlite::Result<String> {
    let current: Option<String> = if row.kind == "database" {
        conn.query_row(
            "SELECT name FROM draft_databases WHERE id = ?1 AND user_id = ?2",
            params![row.target_id, row.user_id],
            |r| r.get(0),
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT title FROM drafts WHERE id = ?1 AND user_id = ?2",
            params![row.target_id, row.user_id],
            |r| r.get(0),
        )
        .optional()?
    };
    Ok(current
        .or_else(|| row.snapshot_title.clone())
        .unwrap_or_default())
}

/// Active (not revoked, not expired) shares of the user, newest first.
pub fn list_shares(
    conn: &Connection,
    user_id: &str,
    target_id: Option<&str>,
) -> rusqlite::Result<Vec<ShareRecord>> {
    let sql = format!(
        "SELECT {SHARE_SELECT} FROM draft_shares
         WHERE user_id = ?1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?2)
           AND (?3 IS NULL OR target_id = ?3)
         ORDER BY created_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![user_id, now_ms(), target_id], map_share)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(ShareRecord {
            target_title: target_title(conn, &row)?,
            assets: share_assets(conn, &row.id)?,
            row,
        });
    }
    Ok(out)
}

/// Revoke one of the user's shares and delete its assets. `false` when no such
/// share belongs to the user. Revoking twice is fine.
pub fn revoke_share(conn: &mut Connection, user_id: &str, share_id: &str) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM draft_shares WHERE id = ?1 AND user_id = ?2",
            params![share_id, user_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(false);
    }
    tx.execute(
        "UPDATE draft_shares SET revoked_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL",
        params![now_ms(), share_id, user_id],
    )?;
    tx.execute(
        "DELETE FROM draft_share_assets WHERE share_id = ?1",
        params![share_id],
    )?;
    tx.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Public (token-resolved) reads
// ---------------------------------------------------------------------------

/// Resolve a token to an active share: a single equality lookup on the UNIQUE
/// token index. Unknown, revoked and expired tokens all return `None`.
pub fn resolve_token(conn: &Connection, token: &str) -> rusqlite::Result<Option<ShareRow>> {
    if !token_shape_ok(token) {
        return Ok(None);
    }
    conn.query_row(
        &format!(
            "SELECT {SHARE_SELECT} FROM draft_shares
             WHERE token = ?1 AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?2)"
        ),
        params![token, now_ms()],
        map_share,
    )
    .optional()
}

/// What a draft share serves right now: (title, content, updated_at).
/// `None` when a live share's draft is gone.
pub fn public_draft(
    conn: &Connection,
    share: &ShareRow,
) -> rusqlite::Result<Option<(String, String, i64)>> {
    if share.kind != "draft" {
        return Ok(None);
    }
    if share.mode == "snapshot" {
        return Ok(Some((
            share.snapshot_title.clone().unwrap_or_default(),
            share.snapshot_content.clone().unwrap_or_default(),
            share.created_at,
        )));
    }
    Ok(super::drafts::get_draft(conn, &share.user_id, &share.target_id)?
        .map(|d| (d.title, d.content, d.updated_at)))
}

/// The shared database, its shared view and the columns viewers may see.
pub struct DbContext {
    pub name: String,
    pub db_id: String,
    pub view: View,
    pub visible: Vec<Column>,
    hidden: Vec<String>,
}

impl DbContext {
    fn is_hidden_key(&self, all: &[Column], key: &str) -> bool {
        dd::property_column_id(all, key).is_some_and(|id| self.hidden.contains(&id))
    }
}

/// `None` when the database or the shared view no longer exists.
pub fn load_db_context(conn: &Connection, share: &ShareRow) -> R<Option<DbContext>> {
    if share.kind != "database" {
        return Ok(None);
    }
    let db = match dd::get_database(conn, &share.user_id, &share.target_id) {
        Ok(db) => db,
        Err(DdError::NotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(view) = db
        .views
        .iter()
        .find(|v| Some(&v.id) == share.view_id.as_ref())
        .cloned()
    else {
        return Ok(None);
    };
    let hidden: Vec<String> = view
        .hidden_columns
        .iter()
        .flatten()
        .filter_map(|k| dd::property_column_id(&db.columns, k))
        .collect();
    let visible = db
        .columns
        .iter()
        .filter(|c| !hidden.contains(&c.id))
        .cloned()
        .collect();
    Ok(Some(DbContext {
        name: format!("{} · {}", db.name, view.name),
        db_id: db.id,
        view,
        visible,
        hidden,
    }))
}

/// Client-controlled part of a public query. There is deliberately no
/// `filters` field: filters always come from the stored view.
#[derive(Deserialize, Default, Debug)]
pub struct PublicQuery {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sorts: Option<Vec<Sort>>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct PublicRow {
    pub id: String,
    pub title: String,
    pub properties: Map<String, Value>,
    pub has_content: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Debug)]
pub struct PublicQueryResult {
    pub rows: Vec<PublicRow>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

fn strip_hidden(mut props: Map<String, Value>, ctx: &DbContext) -> Map<String, Value> {
    props.retain(|k, _| ctx.visible.iter().any(|c| &c.id == k));
    props
}

fn to_public(row: dd::DbRow, ctx: &DbContext) -> PublicRow {
    PublicRow {
        id: row.id,
        title: row.title,
        properties: strip_hidden(row.properties, ctx),
        has_content: row.has_content,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Number of rows matching the view's filters.
pub fn public_row_count(conn: &Connection, share: &ShareRow, ctx: &DbContext) -> R<i64> {
    let req = QueryRequest {
        filters: ctx.view.filters.clone(),
        limit: Some(1),
        ..Default::default()
    };
    Ok(dd::query_rows(conn, &share.user_id, &ctx.db_id, &req)?.total)
}

pub fn public_query(
    conn: &Connection,
    share: &ShareRow,
    ctx: &DbContext,
    q: &PublicQuery,
) -> R<PublicQueryResult> {
    let all = dd::get_database(conn, &share.user_id, &ctx.db_id)?.columns;
    let sorts = match &q.sorts {
        Some(s) => {
            for sort in s {
                if ctx.is_hidden_key(&all, &sort.column) {
                    // Same message as any other bad sort: no hidden-column name oracle.
                    return bad("invalid sort or search");
                }
            }
            s.clone()
        }
        // The view's own sorts minus hidden columns, so row order never leaks
        // the ranking of a column the viewer cannot see.
        None => ctx
            .view
            .sorts
            .iter()
            .filter(|sort| !ctx.is_hidden_key(&all, &sort.column))
            .cloned()
            .collect(),
    };
    let req = QueryRequest {
        // Always the stored view's filters, re-read for this request.
        filters: ctx.view.filters.clone(),
        sorts,
        search: q.search.clone(),
        limit: Some(q.limit.unwrap_or(100).clamp(1, PUBLIC_MAX_LIMIT)),
        offset: q.offset,
    };
    // The builder's own messages list every column (hidden ones included), so
    // clients only ever get a generic complaint.
    let res = dd::query_rows(conn, &share.user_id, &ctx.db_id, &req).map_err(|e| match e {
        DdError::BadRequest(_) => DdError::BadRequest("invalid sort or search".into()),
        other => other,
    })?;
    Ok(PublicQueryResult {
        rows: res.rows.into_iter().map(|r| to_public(r, ctx)).collect(),
        total: res.total,
        offset: res.offset,
        limit: res.limit,
    })
}

/// One row's body, only if it belongs to the shared database AND matches the
/// view's filters.
pub fn public_row(
    conn: &Connection,
    share: &ShareRow,
    ctx: &DbContext,
    row_id: &str,
) -> R<Option<(PublicRow, String)>> {
    let req = QueryRequest {
        filters: ctx.view.filters.clone(),
        limit: Some(1),
        ..Default::default()
    };
    let res = dd::query_rows_inner(conn, &share.user_id, &ctx.db_id, &req, Some(row_id))?;
    let Some(row) = res.rows.into_iter().next() else {
        return Ok(None);
    };
    let content: String = conn.query_row(
        "SELECT content FROM drafts WHERE id = ?1 AND database_id = ?2 AND user_id = ?3",
        params![row.id, ctx.db_id, share.user_id],
        |r| r.get(0),
    )?;
    Ok(Some((to_public(row, ctx), content)))
}

/// `(source, idx)` pairs of a share's stored assets.
pub fn asset_map(conn: &Connection, share_id: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt =
        conn.prepare("SELECT source, idx FROM draft_share_assets WHERE share_id = ?1 ORDER BY idx")?;
    let rows = stmt
        .query_map(params![share_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `(mime, bytes)` of one stored asset.
pub fn get_asset(
    conn: &Connection,
    share_id: &str,
    idx: i64,
) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
    conn.query_row(
        "SELECT mime, bytes FROM draft_share_assets WHERE share_id = ?1 AND idx = ?2",
        params![share_id, idx],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::draft_databases::{create_database, patch_row, upsert_rows, ColumnInput, ConflictMode, DatabasePatch, Filter, RowInput};
    use crate::db::drafts::{delete_draft, get_draft, update_draft, upsert_draft, DraftPatch};
    use crate::db::init_db;
    use serde_json::json;

    pub(crate) fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        for u in ["u1", "u2"] {
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at)
                 VALUES (?1, 'local', ?1, 'Test', 'admin', 1)",
                params![u],
            )
            .unwrap();
        }
        conn
    }

    fn patch<'a>(title: Option<&'a str>, content: Option<&'a str>) -> DraftPatch<'a> {
        DraftPatch { title, content, project_group: None, pinned: None, archived: None, tags: None }
    }

    fn versions(conn: &Connection, id: &str) -> Vec<VersionSummary> {
        list_versions(conn, "u1", id).unwrap().unwrap()
    }

    #[test]
    fn versions_record_previous_state_only_on_real_change() {
        let conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "v1", "p", None, false, false).unwrap();
        assert!(versions(&conn, &d.id).is_empty());
        // Same content: no version.
        upsert_draft(&conn, "u1", "T", "v1", "p", None, false, false).unwrap();
        assert!(versions(&conn, &d.id).is_empty());
        // Upsert hit with new content saves the previous content.
        upsert_draft(&conn, "u1", "T", "v2", "p", None, false, false).unwrap();
        let vs = versions(&conn, &d.id);
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].size, 2);
        assert_eq!(get_version(&conn, "u1", &d.id, &vs[0].id).unwrap().unwrap().content, "v1");
        // PATCH with identical title/content: nothing.
        update_draft(&conn, "u1", &d.id, patch(Some("T"), Some("v2"))).unwrap();
        assert_eq!(versions(&conn, &d.id).len(), 1);
        // Pin-only change: nothing.
        update_draft(
            &conn,
            "u1",
            &d.id,
            DraftPatch { title: None, content: None, project_group: None, pinned: Some(true), archived: None, tags: None },
        )
        .unwrap();
        assert_eq!(versions(&conn, &d.id).len(), 1);
        // Title change records previous title.
        update_draft(&conn, "u1", &d.id, patch(Some("T2"), None)).unwrap();
        let vs = versions(&conn, &d.id);
        assert_eq!(vs.len(), 2);
        assert_eq!(vs[0].title, "T");
    }

    #[test]
    fn versions_are_pruned_to_newest_30_and_deleted_with_draft() {
        let conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "c0", "p", None, false, false).unwrap();
        for i in 1..=40 {
            update_draft(&conn, "u1", &d.id, patch(None, Some(&format!("c{i}")))).unwrap();
        }
        let vs = versions(&conn, &d.id);
        assert_eq!(vs.len(), 30);
        // Newest first: the previous state of the last write is c39.
        assert_eq!(get_version(&conn, "u1", &d.id, &vs[0].id).unwrap().unwrap().content, "c39");
        assert_eq!(get_version(&conn, "u1", &d.id, &vs[29].id).unwrap().unwrap().content, "c10");
        assert!(delete_draft(&conn, "u1", &d.id).unwrap());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM draft_versions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn restore_saves_current_state_first_and_is_owner_scoped() {
        let mut conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "old", "p", None, false, false).unwrap();
        update_draft(&conn, "u1", &d.id, patch(None, Some("new"))).unwrap();
        let vs = versions(&conn, &d.id);
        assert_eq!(vs.len(), 1);
        // Another user can neither list nor restore.
        assert!(list_versions(&conn, "u2", &d.id).unwrap().is_none());
        assert!(restore_version(&mut conn, "u2", &d.id, &vs[0].id).unwrap().is_none());
        let restored = restore_version(&mut conn, "u1", &d.id, &vs[0].id).unwrap().unwrap();
        assert_eq!(restored.content, "old");
        let vs2 = versions(&conn, &d.id);
        assert_eq!(vs2.len(), 2);
        assert_eq!(get_version(&conn, "u1", &d.id, &vs2[0].id).unwrap().unwrap().content, "new");
        assert!(restore_version(&mut conn, "u1", &d.id, "nope").unwrap().is_none());
    }

    #[test]
    fn row_patch_records_versions_and_batch_upsert_does_not() {
        let mut conn = test_conn();
        let (db, _) = create_database(&conn, "u1", "tasks", None, &[], false).unwrap();
        let res = upsert_rows(
            &mut conn,
            "u1",
            &db.id,
            vec![RowInput { title: "a".into(), properties: None, content: Some("one".into()) }],
            ConflictMode::Update,
        )
        .unwrap();
        let id = res.rows[0].id.clone();
        upsert_rows(
            &mut conn,
            "u1",
            &db.id,
            vec![RowInput { title: "a".into(), properties: None, content: Some("two".into()) }],
            ConflictMode::Update,
        )
        .unwrap();
        assert!(versions(&conn, &id).is_empty());
        patch_row(&mut conn, "u1", &db.id, &id, None, None, Some("three")).unwrap();
        let vs = versions(&conn, &id);
        assert_eq!(vs.len(), 1);
        assert_eq!(get_version(&conn, "u1", &id, &vs[0].id).unwrap().unwrap().content, "two");
        // Same content again: no new version.
        patch_row(&mut conn, "u1", &db.id, &id, None, None, Some("three")).unwrap();
        assert_eq!(versions(&conn, &id).len(), 1);
    }

    #[test]
    fn tokens_are_43_chars_url_safe_and_unique() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(token_shape_ok(&a));
        assert!(!a.contains('=') && !a.contains('+') && !a.contains('/'));
        assert!(!token_shape_ok("short"));
        assert!(!token_shape_ok(&"a".repeat(44)));
        assert!(!token_shape_ok(&format!("{}'", "a".repeat(42))));
    }

    fn make_share(conn: &mut Connection, user: &str, id: &str, mode: Option<&str>) -> ShareRecord {
        let p = prepare_share(conn, user, "draft", id, mode, None).unwrap();
        create_share(conn, user, &p, None, &[]).unwrap()
    }

    #[test]
    fn draft_share_pins_snapshot_is_frozen_live_follows() {
        let mut conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "v1", "p", None, false, false).unwrap();
        let snap = make_share(&mut conn, "u1", &d.id, None);
        let live = make_share(&mut conn, "u1", &d.id, Some("live"));
        assert!(get_draft(&conn, "u1", &d.id).unwrap().unwrap().pinned);
        update_draft(&conn, "u1", &d.id, patch(Some("T2"), Some("v2"))).unwrap();
        let s = resolve_token(&conn, &snap.row.token).unwrap().unwrap();
        assert_eq!(public_draft(&conn, &s).unwrap().unwrap().1, "v1");
        let l = resolve_token(&conn, &live.row.token).unwrap().unwrap();
        let (t, c, _) = public_draft(&conn, &l).unwrap().unwrap();
        assert_eq!((t.as_str(), c.as_str()), ("T2", "v2"));
        // Deleting the draft: snapshot survives, live is gone.
        delete_draft(&conn, "u1", &d.id).unwrap();
        assert_eq!(public_draft(&conn, &s).unwrap().unwrap().1, "v1");
        assert!(public_draft(&conn, &l).unwrap().is_none());
    }

    #[test]
    fn unknown_revoked_and_expired_tokens_resolve_to_none() {
        let mut conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "v1", "p", None, false, false).unwrap();
        let p = prepare_share(&conn, "u1", "draft", &d.id, None, None).unwrap();
        let ok = create_share(&mut conn, "u1", &p, None, &[]).unwrap();
        let expired = create_share(&mut conn, "u1", &p, Some(now_ms() - 1000), &[]).unwrap();
        let revoked = create_share(&mut conn, "u1", &p, None, &[]).unwrap();
        assert!(revoke_share(&mut conn, "u1", &revoked.row.id).unwrap());
        assert!(resolve_token(&conn, &ok.row.token).unwrap().is_some());
        assert!(resolve_token(&conn, &expired.row.token).unwrap().is_none());
        assert!(resolve_token(&conn, &revoked.row.token).unwrap().is_none());
        assert!(resolve_token(&conn, &generate_token().unwrap()).unwrap().is_none());
        // Expired + revoked shares are not listed.
        let listed = list_shares(&conn, "u1", None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].row.id, ok.row.id);
    }

    #[test]
    fn management_is_owner_scoped_and_revoke_deletes_assets() {
        let mut conn = test_conn();
        let d = upsert_draft(&conn, "u1", "T", "v1", "p", None, false, false).unwrap();
        // u2 cannot share u1's draft.
        assert!(matches!(
            prepare_share(&conn, "u2", "draft", &d.id, None, None),
            Err(DdError::NotFound(_))
        ));
        let p = prepare_share(&conn, "u1", "draft", &d.id, None, None).unwrap();
        let assets = vec![StoredAsset {
            source: "file://m/a.png".into(),
            mime: "image/png".into(),
            bytes: vec![1, 2, 3],
        }];
        let share = create_share(&mut conn, "u1", &p, None, &assets).unwrap();
        assert_eq!(share.assets, vec!["file://m/a.png".to_string()]);
        assert!(list_shares(&conn, "u2", None).unwrap().is_empty());
        assert!(list_shares(&conn, "u1", Some("other")).unwrap().is_empty());
        assert_eq!(list_shares(&conn, "u1", Some(&d.id)).unwrap().len(), 1);
        // u2 cannot revoke it.
        assert!(!revoke_share(&mut conn, "u2", &share.row.id).unwrap());
        assert!(resolve_token(&conn, &share.row.token).unwrap().is_some());
        assert!(revoke_share(&mut conn, "u1", &share.row.id).unwrap());
        assert!(get_asset(&conn, &share.row.id, 0).unwrap().is_none());
        assert!(resolve_token(&conn, &share.row.token).unwrap().is_none());
    }

    fn db_with_rows(conn: &mut Connection) -> (dd::Database, Vec<String>) {
        let cols = vec![
            ColumnInput { id: None, name: "Status".into(), ty: Some(dd::ColumnType::Select), options: vec![] },
            ColumnInput { id: None, name: "Secret".into(), ty: Some(dd::ColumnType::Text), options: vec![] },
        ];
        let (db, _) = create_database(conn, "u1", "tasks", None, &cols, false).unwrap();
        let mk = |t: &str, s: &str| RowInput {
            title: t.into(),
            properties: json!({"status": s, "secret": format!("secret-{t}")}).as_object().cloned(),
            content: Some(format!("body of {t}")),
        };
        let res = upsert_rows(
            conn,
            "u1",
            &db.id,
            vec![mk("a", "todo"), mk("b", "done"), mk("c", "todo")],
            ConflictMode::Create,
        )
        .unwrap();
        // Shared view: only todo rows, secret hidden.
        let views = vec![View {
            id: "pub".into(),
            name: "Public".into(),
            ty: "table".into(),
            filters: vec![Filter { column: "status".into(), op: "eq".into(), value: Some(json!("todo")) }],
            sorts: vec![],
            group_by: None,
            hidden_columns: Some(vec!["secret".into()]),
        }];
        let db = dd::patch_database(
            conn,
            "u1",
            &db.id,
            DatabasePatch { name: None, columns: None, views: Some(views) },
        )
        .unwrap();
        (db, res.rows.into_iter().map(|r| r.id).collect())
    }

    #[test]
    fn database_share_enforces_filters_hidden_columns_and_row_membership() {
        let mut conn = test_conn();
        let (db, ids) = db_with_rows(&mut conn);
        let p = prepare_share(&conn, "u1", "database", &db.id, None, Some("pub")).unwrap();
        let share = create_share(&mut conn, "u1", &p, None, &[]).unwrap().row;
        let ctx = load_db_context(&conn, &share).unwrap().unwrap();
        assert_eq!(ctx.visible.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["status"]);
        assert_eq!(public_row_count(&conn, &share, &ctx).unwrap(), 2);

        let res = public_query(&conn, &share, &ctx, &PublicQuery::default()).unwrap();
        assert_eq!(res.total, 2);
        assert_eq!(res.rows.len(), 2);
        for r in &res.rows {
            assert!(r.properties.contains_key("status"));
            assert!(!r.properties.contains_key("secret"));
        }
        // Sorting or searching by hidden/unknown columns is refused.
        let q = PublicQuery { sorts: Some(vec![Sort { column: "Secret".into(), dir: "asc".into() }]), ..Default::default() };
        assert!(matches!(public_query(&conn, &share, &ctx, &q), Err(DdError::BadRequest(_))));
        // Limit is capped.
        let q = PublicQuery { limit: Some(10_000), ..Default::default() };
        assert_eq!(public_query(&conn, &share, &ctx, &q).unwrap().limit, 200);

        // Row inside the filter is readable; row outside it is not.
        let (row, content) = public_row(&conn, &share, &ctx, &ids[0]).unwrap().unwrap();
        assert_eq!(row.title, "a");
        assert_eq!(content, "body of a");
        assert!(!row.properties.contains_key("secret"));
        assert!(public_row(&conn, &share, &ctx, &ids[1]).unwrap().is_none());
        assert!(public_row(&conn, &share, &ctx, "nope").unwrap().is_none());

        // A row of another database (even the user's own) is refused.
        let (db2, _) = create_database(&conn, "u1", "other", None, &[], false).unwrap();
        let other = upsert_rows(
            &mut conn,
            "u1",
            &db2.id,
            vec![RowInput { title: "x".into(), properties: None, content: Some("s".into()) }],
            ConflictMode::Create,
        )
        .unwrap();
        assert!(public_row(&conn, &share, &ctx, &other.rows[0].id).unwrap().is_none());

        // Live: edits are picked up; removing the view makes it vanish.
        patch_row(&mut conn, "u1", &db.id, &ids[1], None, json!({"status": "todo"}).as_object(), None).unwrap();
        let ctx = load_db_context(&conn, &share).unwrap().unwrap();
        assert_eq!(public_row_count(&conn, &share, &ctx).unwrap(), 3);
        dd::patch_database(
            &mut conn,
            "u1",
            &db.id,
            DatabasePatch {
                name: None,
                columns: None,
                views: Some(vec![View {
                    id: "other".into(),
                    name: "Other".into(),
                    ty: "table".into(),
                    filters: vec![],
                    sorts: vec![],
                    group_by: None,
                    hidden_columns: None,
                }]),
            },
        )
        .unwrap();
        assert!(load_db_context(&conn, &share).unwrap().is_none());
    }

    #[test]
    fn database_share_rejects_snapshot_and_foreign_database() {
        let mut conn = test_conn();
        let (db, _) = db_with_rows(&mut conn);
        assert!(matches!(
            prepare_share(&conn, "u1", "database", &db.id, Some("snapshot"), None),
            Err(DdError::BadRequest(_))
        ));
        assert!(matches!(
            prepare_share(&conn, "u2", "database", &db.id, None, None),
            Err(DdError::NotFound(_))
        ));
        assert!(matches!(
            prepare_share(&conn, "u1", "database", &db.id, None, Some("missing")),
            Err(DdError::BadRequest(_))
        ));
        assert!(matches!(
            prepare_share(&conn, "u1", "weird", &db.id, None, None),
            Err(DdError::BadRequest(_))
        ));
    }

    #[test]
    fn expiry_validation() {
        assert!(expiry_from_days(None).unwrap().is_none());
        assert!(expiry_from_days(Some(1.0)).unwrap().unwrap() > now_ms());
        assert!(expiry_from_days(Some(0.0)).is_err());
        assert!(expiry_from_days(Some(-1.0)).is_err());
        assert!(expiry_from_days(Some(f64::NAN)).is_err());
        assert!(expiry_from_days(Some(1e9)).is_err());
    }
}
