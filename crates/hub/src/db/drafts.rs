use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::now_ms;

/// Unpinned drafts untouched for 7 days are automatically surfaced under Archived.
pub const AUTO_ARCHIVE_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftRow {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub content: String,
    pub project_group: String,
    pub source_terminal_id: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn map_draft_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftRow> {
    let pinned_i: i64 = row.get(6)?;
    let archived_i: i64 = row.get(7)?;
    let updated_at: i64 = row.get(9)?;
    let database_id: Option<String> = row.get(10)?;
    let pinned = pinned_i != 0;
    let explicitly_archived = archived_i != 0;
    // Draft-database rows never auto-archive.
    let stale_archived = database_id.is_none()
        && !pinned
        && (now_ms().saturating_sub(updated_at) > AUTO_ARCHIVE_AFTER_MS);
    Ok(DraftRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        project_group: row.get(4)?,
        source_terminal_id: row.get(5)?,
        pinned,
        archived: explicitly_archived || stale_archived,
        created_at: row.get(8)?,
        updated_at,
    })
}

pub fn list_drafts(
    conn: &Connection,
    user_id: &str,
    project_group: Option<&str>,
    include_archived: bool,
) -> rusqlite::Result<Vec<DraftRow>> {
    let mut rows = Vec::new();
    if let Some(proj) = project_group.filter(|p| !p.trim().is_empty()) {
        let mut stmt = conn.prepare(
            "SELECT id, user_id, title, content, project_group, source_terminal_id,
                    pinned, archived, created_at, updated_at, database_id
             FROM drafts
             WHERE user_id = ?1 AND project_group = ?2 AND database_id IS NULL
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let iter = stmt.query_map(params![user_id, proj.trim()], map_draft_row)?;
        for r in iter {
            rows.push(r?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, user_id, title, content, project_group, source_terminal_id,
                    pinned, archived, created_at, updated_at, database_id
             FROM drafts
             WHERE user_id = ?1 AND database_id IS NULL
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let iter = stmt.query_map(params![user_id], map_draft_row)?;
        for r in iter {
            rows.push(r?);
        }
    }
    if !include_archived {
        rows.retain(|d| !d.archived);
    }
    Ok(rows)
}

pub fn get_draft(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
) -> rusqlite::Result<Option<DraftRow>> {
    conn.query_row(
        "SELECT id, user_id, title, content, project_group, source_terminal_id,
                pinned, archived, created_at, updated_at, database_id
         FROM drafts
         WHERE id = ?1 AND user_id = ?2",
        params![draft_id, user_id],
        map_draft_row,
    )
    .optional()
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_draft(
    conn: &Connection,
    user_id: &str,
    title: &str,
    content: &str,
    project_group: &str,
    source_terminal_id: Option<&str>,
    pinned: bool,
    force_new: bool,
) -> rusqlite::Result<DraftRow> {
    // IMMEDIATE: take the write lock up front so busy_timeout applies; the
    // version snapshot and the overwrite must be one atomic step.
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let conn: &Connection = &tx;
    let now = now_ms();
    let title = title.trim();
    let project_group = if project_group.trim().is_empty() {
        "~"
    } else {
        project_group.trim()
    };

    if !force_new {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, content FROM drafts
                 WHERE user_id = ?1 AND project_group = ?2 AND title = ?3 AND archived = 0
                   AND database_id IS NULL
                 ORDER BY updated_at DESC LIMIT 1",
                params![user_id, project_group, title],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, old_content)) = existing {
            // The title matched exactly, so only the content can change.
            if old_content != content {
                super::draft_shares::record_version(conn, user_id, &id, title, &old_content)?;
            }
            conn.execute(
                "UPDATE drafts
                 SET content = ?1,
                     source_terminal_id = COALESCE(?2, source_terminal_id),
                     pinned = CASE WHEN ?3 != 0 THEN 1 ELSE pinned END,
                     archived = 0,
                     updated_at = ?4
                 WHERE id = ?5 AND user_id = ?6",
                params![content, source_terminal_id, i64::from(pinned), now, id, user_id],
            )?;
            let out = get_draft(conn, user_id, &id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            tx.commit()?;
            return Ok(out);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO drafts (
            id, user_id, title, content, project_group, source_terminal_id,
            pinned, archived, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![
            id,
            user_id,
            title,
            content,
            project_group,
            source_terminal_id,
            i64::from(pinned),
            now,
            now
        ],
    )?;
    tx.commit()?;
    Ok(DraftRow {
        id,
        user_id: user_id.to_string(),
        title: title.to_string(),
        content: content.to_string(),
        project_group: project_group.to_string(),
        source_terminal_id: source_terminal_id.map(str::to_string),
        pinned,
        archived: false,
        created_at: now,
        updated_at: now,
    })
}

pub struct DraftPatch<'a> {
    pub title: Option<&'a str>,
    pub content: Option<&'a str>,
    pub project_group: Option<&'a str>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

pub fn update_draft(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
    patch: DraftPatch<'_>,
) -> rusqlite::Result<Option<DraftRow>> {
    // IMMEDIATE: the version snapshot and the overwrite are one atomic step.
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let conn: &Connection = &tx;
    let Some(existing) = get_draft(conn, user_id, draft_id)? else {
        return Ok(None);
    };
    let next_title = patch
        .title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&existing.title);
    let next_content = patch.content.unwrap_or(&existing.content);
    let next_group = patch
        .project_group
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&existing.project_group);
    let next_pinned = patch.pinned.unwrap_or(existing.pinned);
    let next_archived = patch.archived.unwrap_or(existing.archived);
    let now = now_ms();

    if next_title != existing.title || next_content != existing.content {
        super::draft_shares::record_version(
            conn,
            user_id,
            draft_id,
            &existing.title,
            &existing.content,
        )?;
    }

    conn.execute(
        "UPDATE drafts
         SET title = ?1, content = ?2, project_group = ?3,
             pinned = ?4, archived = ?5, updated_at = ?6
         WHERE id = ?7 AND user_id = ?8",
        params![
            next_title,
            next_content,
            next_group,
            i64::from(next_pinned),
            i64::from(next_archived),
            now,
            draft_id,
            user_id
        ],
    )?;
    let out = get_draft(conn, user_id, draft_id)?;
    tx.commit()?;
    Ok(out)
}

pub fn delete_draft(
    conn: &Connection,
    user_id: &str,
    draft_id: &str,
) -> rusqlite::Result<bool> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "DELETE FROM drafts WHERE id = ?1 AND user_id = ?2",
        params![draft_id, user_id],
    )?;
    if affected > 0 {
        tx.execute(
            "DELETE FROM draft_versions WHERE draft_id = ?1 AND user_id = ?2",
            params![draft_id, user_id],
        )?;
    }
    tx.commit()?;
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (id, provider, provider_id, display_name, role, created_at)
             VALUES ('u1', 'local', 'u1', 'Test', 'admin', 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_updates_same_title_and_supports_pin_archive_filter() {
        let conn = test_conn();
        let d1 = upsert_draft(&conn, "u1", "客户回复", "v1", "jiashun", Some("t1"), false, false).unwrap();
        let d2 = upsert_draft(&conn, "u1", "客户回复", "v2", "jiashun", Some("t1"), false, false).unwrap();
        assert_eq!(d1.id, d2.id);
        assert_eq!(d2.content, "v2");

        let d3 = upsert_draft(&conn, "u1", "SQL排查", "SELECT 1", "webmux", None, true, false).unwrap();
        assert_ne!(d3.id, d1.id);

        let all = list_drafts(&conn, "u1", None, false).unwrap();
        assert_eq!(all.len(), 2);
        // Pinned draft sorts first.
        assert_eq!(all[0].id, d3.id);

        let only_jiashun = list_drafts(&conn, "u1", Some("jiashun"), false).unwrap();
        assert_eq!(only_jiashun.len(), 1);
        assert_eq!(only_jiashun[0].title, "客户回复");

        // Archive d1 -> hidden from default list, visible with include_archived.
        let archived = update_draft(
            &conn,
            "u1",
            &d1.id,
            DraftPatch {
                title: None,
                content: None,
                project_group: None,
                pinned: None,
                archived: Some(true),
            },
        )
        .unwrap()
        .unwrap();
        assert!(archived.archived);
        assert_eq!(list_drafts(&conn, "u1", None, false).unwrap().len(), 1);
        assert_eq!(list_drafts(&conn, "u1", None, true).unwrap().len(), 2);

        assert!(delete_draft(&conn, "u1", &d1.id).unwrap());
        assert_eq!(list_drafts(&conn, "u1", None, true).unwrap().len(), 1);
    }
}
