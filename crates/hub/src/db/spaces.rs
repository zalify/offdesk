use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::now_ms;
use super::types::SpaceRow;

fn space_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SpaceRow> {
    Ok(SpaceRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        icon: row.get(3)?,
        color: row.get(4)?,
        default_cwd: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub fn list_spaces(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<SpaceRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, name, icon, color, default_cwd, sort_order, created_at, updated_at
         FROM spaces
         WHERE user_id = ?1
         ORDER BY sort_order ASC, created_at ASC, name ASC",
    )?;
    let rows = stmt.query_map(params![user_id], space_from_row)?;
    rows.collect()
}

pub fn get_space(
    conn: &Connection,
    user_id: &str,
    space_id: &str,
) -> rusqlite::Result<Option<SpaceRow>> {
    conn.query_row(
        "SELECT id, user_id, name, icon, color, default_cwd, sort_order, created_at, updated_at
         FROM spaces
         WHERE id = ?1 AND user_id = ?2",
        params![space_id, user_id],
        space_from_row,
    )
    .optional()
}

pub fn space_belongs_to_user(
    conn: &Connection,
    user_id: &str,
    space_id: &str,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM spaces WHERE id = ?1 AND user_id = ?2",
        params![space_id, user_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn next_sort_order(conn: &Connection, user_id: &str) -> rusqlite::Result<i64> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(sort_order) FROM spaces WHERE user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )?;
    Ok(max.map_or(0, |sort_order| sort_order + 1))
}

#[allow(clippy::too_many_arguments)]
pub fn create_space(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    icon: Option<&str>,
    color: Option<&str>,
    default_cwd: Option<&str>,
    sort_order: i64,
) -> rusqlite::Result<SpaceRow> {
    let now = now_ms();
    let icon = icon.map(str::trim).filter(|s| !s.is_empty());
    let color = color.map(str::trim).filter(|s| !s.is_empty());
    let default_cwd = default_cwd.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO spaces
             (id, user_id, name, icon, color, default_cwd, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            user_id,
            name.trim(),
            icon,
            color,
            default_cwd,
            sort_order,
            now,
            now,
        ],
    )?;
    Ok(SpaceRow {
        id: id.to_string(),
        user_id: user_id.to_string(),
        name: name.trim().to_string(),
        icon: icon.map(str::to_string),
        color: color.map(str::to_string),
        default_cwd: default_cwd.map(str::to_string),
        sort_order,
        created_at: now,
        updated_at: now,
    })
}

#[derive(Default)]
pub struct SpacePatch<'a> {
    pub name: Option<&'a str>,
    pub icon: Option<Option<&'a str>>,
    pub color: Option<Option<&'a str>>,
    pub default_cwd: Option<Option<&'a str>>,
    pub sort_order: Option<i64>,
}

pub fn update_space(
    conn: &Connection,
    user_id: &str,
    space_id: &str,
    patch: SpacePatch<'_>,
) -> rusqlite::Result<Option<SpaceRow>> {
    let Some(existing) = get_space(conn, user_id, space_id)? else {
        return Ok(None);
    };
    let next_name = patch
        .name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&existing.name);
    let next_icon = match patch.icon {
        Some(v) => v.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        None => existing.icon.clone(),
    };
    let next_color = match patch.color {
        Some(v) => v.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        None => existing.color.clone(),
    };
    let next_default_cwd = match patch.default_cwd {
        Some(v) => v.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        None => existing.default_cwd.clone(),
    };
    let next_sort_order = patch.sort_order.unwrap_or(existing.sort_order);
    let now = now_ms();

    conn.execute(
        "UPDATE spaces
         SET name = ?1, icon = ?2, color = ?3, default_cwd = ?4, sort_order = ?5, updated_at = ?6
         WHERE id = ?7 AND user_id = ?8",
        params![
            next_name,
            next_icon,
            next_color,
            next_default_cwd,
            next_sort_order,
            now,
            space_id,
            user_id,
        ],
    )?;

    Ok(Some(SpaceRow {
        id: existing.id,
        user_id: existing.user_id,
        name: next_name.to_string(),
        icon: next_icon,
        color: next_color,
        default_cwd: next_default_cwd,
        sort_order: next_sort_order,
        created_at: existing.created_at,
        updated_at: now,
    }))
}

/// Safely delete a Space without deleting any of its workspace groups,
/// terminals, drafts, or draft databases: all references are unassigned
/// (`SET space_id = NULL`) atomically before the Space row is removed.
pub fn delete_space(conn: &Connection, user_id: &str, space_id: &str) -> rusqlite::Result<bool> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM spaces WHERE id = ?1 AND user_id = ?2",
            params![space_id, user_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(false);
    }
    tx.execute(
        "UPDATE workspace_groups SET space_id = NULL WHERE user_id = ?1 AND space_id = ?2",
        params![user_id, space_id],
    )?;
    tx.execute(
        "UPDATE drafts SET space_id = NULL WHERE user_id = ?1 AND space_id = ?2",
        params![user_id, space_id],
    )?;
    tx.execute(
        "UPDATE draft_databases SET space_id = NULL WHERE user_id = ?1 AND space_id = ?2",
        params![user_id, space_id],
    )?;
    let affected = tx.execute(
        "DELETE FROM spaces WHERE id = ?1 AND user_id = ?2",
        params![space_id, user_id],
    )?;
    tx.commit()?;
    Ok(affected > 0)
}

/// Resolve the `space_id` for a terminal via its `workspace_group_id`.
/// Used when creating a draft with `source_terminal_id` and no explicit
/// `space_id` so CLI `offdesk draft write` auto-files into the right Space.
pub fn resolve_space_id_for_terminal(
    conn: &Connection,
    user_id: &str,
    terminal_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT wg.space_id
         FROM terminal_sessions ts
         JOIN workspace_groups wg ON wg.id = ts.workspace_group_id
         WHERE ts.id = ?1 AND wg.user_id = ?2",
        params![terminal_id, user_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{draft_databases, drafts, init_db, machines, terminal_sessions, users, workspace_groups};

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        users::create_user(&conn, "u1", "local", "u1", "Test", None, "admin").unwrap();
        machines::ensure_machine_for_user(&conn, "m1", "u1", "Mac", Some("macos"), Some("/Users/t")).unwrap();
        conn
    }

    #[test]
    fn init_db_is_idempotent_with_spaces_migration() {
        let conn = test_conn();
        // Calling init_db again must succeed without error.
        init_db(&conn).unwrap();
        assert!(list_spaces(&conn, "u1").unwrap().is_empty());
    }

    #[test]
    fn spaces_crud_lifecycle() {
        let conn = test_conn();

        let s1 = create_space(
            &conn,
            "sp-1",
            "u1",
            "Work",
            Some("briefcase"),
            Some("#3b82f6"),
            Some("/work"),
            0,
        )
        .unwrap();
        assert_eq!(s1.name, "Work");
        assert_eq!(s1.icon.as_deref(), Some("briefcase"));
        assert_eq!(s1.color.as_deref(), Some("#3b82f6"));
        assert_eq!(s1.default_cwd.as_deref(), Some("/work"));

        let next = next_sort_order(&conn, "u1").unwrap();
        assert_eq!(next, 1);

        let s2 = create_space(&conn, "sp-2", "u1", "Personal", None, None, None, next).unwrap();
        let listed = list_spaces(&conn, "u1").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, s1.id);
        assert_eq!(listed[1].id, s2.id);

        let updated = update_space(
            &conn,
            "u1",
            "sp-1",
            SpacePatch {
                name: Some("Engineering"),
                icon: Some(None),
                color: Some(Some("#10b981")),
                default_cwd: Some(Some("/work/eng")),
                sort_order: Some(5),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.name, "Engineering");
        assert_eq!(updated.icon, None);
        assert_eq!(updated.color.as_deref(), Some("#10b981"));
        assert_eq!(updated.default_cwd.as_deref(), Some("/work/eng"));
        assert_eq!(updated.sort_order, 5);

        assert!(delete_space(&conn, "u1", "sp-2").unwrap());
        assert!(!delete_space(&conn, "u1", "sp-2").unwrap());
        assert_eq!(list_spaces(&conn, "u1").unwrap().len(), 1);
    }

    #[test]
    fn delete_space_unassigns_groups_drafts_and_databases_without_deleting_them() {
        let conn = test_conn();
        let sp = create_space(&conn, "sp-1", "u1", "Proj", None, None, None, 0).unwrap();

        let grp = workspace_groups::create_workspace_group_in_space(
            &conn,
            "grp-1",
            "u1",
            "m1",
            "Backend",
            0,
            Some(&sp.id),
        )
        .unwrap();
        assert_eq!(grp.space_id.as_deref(), Some("sp-1"));

        conn.execute(
            "INSERT INTO terminal_sessions (id, machine_id, title, title_source, cwd, workspace_group_id, cols, rows, created_at)
             VALUES ('term-1', 'm1', 'bash', 'none', '/work', ?1, 80, 24, 1)",
            params![grp.id],
        )
        .unwrap();

        let draft = drafts::upsert_draft_with_tags_and_space(
            &conn,
            "u1",
            "Notes",
            "hello",
            "proj",
            Some("term-1"),
            false,
            false,
            None,
            Some(&sp.id),
        )
        .unwrap();
        assert_eq!(draft.space_id.as_deref(), Some("sp-1"));

        let (ddb, _) = draft_databases::create_database_in_space(
            &conn,
            "u1",
            "Tasks",
            Some("proj"),
            &[],
            false,
            Some(&sp.id),
        )
        .unwrap();
        assert_eq!(ddb.space_id.as_deref(), Some("sp-1"));

        // Delete the space.
        assert!(delete_space(&conn, "u1", &sp.id).unwrap());

        // Space is gone.
        assert!(get_space(&conn, "u1", &sp.id).unwrap().is_none());

        // Group still exists with space_id = None.
        let groups = workspace_groups::find_workspace_groups_by_user(&conn, "u1").unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "grp-1");
        assert_eq!(groups[0].space_id, None);

        // Terminal still exists and stays in grp-1.
        let terms = terminal_sessions::find_active_by_machine(&conn, "m1").unwrap();
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].workspace_group_id.as_deref(), Some("grp-1"));

        // Draft still exists with space_id = None.
        let d_after = drafts::get_draft(&conn, "u1", &draft.id).unwrap().unwrap();
        assert_eq!(d_after.space_id, None);

        // Draft database still exists with space_id = None.
        let db_after = draft_databases::get_database(&conn, "u1", &ddb.id).unwrap();
        assert_eq!(db_after.space_id, None);
    }

    #[test]
    fn draft_creation_auto_resolves_space_from_source_terminal() {
        let conn = test_conn();
        let sp = create_space(&conn, "sp-auto", "u1", "AutoSpace", None, None, None, 0).unwrap();
        let grp = workspace_groups::create_workspace_group_in_space(
            &conn,
            "grp-auto",
            "u1",
            "m1",
            "API",
            0,
            Some(&sp.id),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_sessions (id, machine_id, title, title_source, cwd, workspace_group_id, cols, rows, created_at)
             VALUES ('term-auto', 'm1', 'claude', 'none', '/work', ?1, 80, 24, 1)",
            params![grp.id],
        )
        .unwrap();

        // No explicit space_id -> automatically resolves to sp-auto.
        let d = drafts::upsert_draft_with_tags_and_space(
            &conn,
            "u1",
            "Auto-filed draft",
            "body",
            "~",
            Some("term-auto"),
            false,
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(d.space_id.as_deref(), Some("sp-auto"));

        // Explicit space_id overrides terminal's space.
        let sp2 = create_space(&conn, "sp-explicit", "u1", "Explicit", None, None, None, 1).unwrap();
        let d2 = drafts::upsert_draft_with_tags_and_space(
            &conn,
            "u1",
            "Explicit draft",
            "body2",
            "~",
            Some("term-auto"),
            false,
            false,
            None,
            Some(&sp2.id),
        )
        .unwrap();
        assert_eq!(d2.space_id.as_deref(), Some("sp-explicit"));

        // Filtering list_drafts by space_id works.
        let in_auto = drafts::list_drafts_in_space(&conn, "u1", None, Some("sp-auto"), false).unwrap();
        assert_eq!(in_auto.len(), 1);
        assert_eq!(in_auto[0].id, d.id);
    }
}
