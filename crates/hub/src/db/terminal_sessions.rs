use rusqlite::{params, Connection};
use offdesk_protocol::TerminalTitleSource;

use super::now_ms;
use super::types::TerminalSessionRow;

#[derive(Debug, PartialEq, Eq)]
pub enum TitleUpdateOutcome {
    Updated,
    Unchanged,
    Rejected,
}

fn title_source_name(source: TerminalTitleSource) -> &'static str {
    match source {
        TerminalTitleSource::Osc => "osc",
        TerminalTitleSource::Process => "process",
        TerminalTitleSource::None => "none",
    }
}

/// Inverse of `title_source_name` for hydrating `TerminalInfo` from DB rows.
/// Unknown values fall back to `None` (the serde default) rather than failing.
pub fn title_source_from_name(name: &str) -> TerminalTitleSource {
    match name {
        "osc" => TerminalTitleSource::Osc,
        "process" => TerminalTitleSource::Process,
        _ => TerminalTitleSource::None,
    }
}

/// Live cwd reported by the machine (tmux `pane_current_path`). Skips no-op
/// writes; returns true only when a row actually changed (false for unknown
/// or destroyed terminals, mirroring the title flow's silent ignore).
pub fn apply_cwd_update(conn: &Connection, id: &str, cwd: &str) -> rusqlite::Result<bool> {
    let updated = conn.execute(
        "UPDATE terminal_sessions SET cwd = ?1
         WHERE id = ?2 AND destroyed_at IS NULL AND cwd != ?1",
        params![cwd, id],
    )?;
    Ok(updated > 0)
}

pub fn insert(
    conn: &Connection,
    id: &str,
    machine_id: &str,
    title: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> rusqlite::Result<()> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO terminal_sessions (id, machine_id, title, cwd, cols, rows, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
             machine_id = excluded.machine_id,
             title = excluded.title,
             cwd = excluded.cwd,
             cols = excluded.cols,
             rows = excluded.rows",
        params![
            id,
            machine_id,
            title,
            cwd,
            cols as i64,
            rows as i64,
            created_at
        ],
    )?;
    Ok(())
}

pub fn mark_destroyed(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let destroyed_at = now_ms();
    conn.execute(
        "UPDATE terminal_sessions SET destroyed_at = ?1 WHERE id = ?2 AND destroyed_at IS NULL",
        params![destroyed_at, id],
    )?;
    Ok(())
}

pub fn update_size(conn: &Connection, id: &str, cols: u16, rows: u16) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE terminal_sessions SET cols = ?1, rows = ?2 WHERE id = ?3",
        params![cols as i64, rows as i64, id],
    )?;
    Ok(())
}

pub fn update_metadata(
    conn: &Connection,
    id: &str,
    title: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE terminal_sessions SET title = ?1, cwd = ?2, cols = ?3, rows = ?4 WHERE id = ?5",
        params![title, cwd, cols as i64, rows as i64, id],
    )?;
    Ok(())
}

pub fn apply_title_update(
    conn: &Connection,
    id: &str,
    title: &str,
    source: TerminalTitleSource,
) -> rusqlite::Result<TitleUpdateOutcome> {
    let current = conn.query_row(
        "SELECT title, title_source FROM terminal_sessions WHERE id = ?1 AND destroyed_at IS NULL",
        params![id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (current_title, current_source) = match current {
        Ok(current) => current,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(TitleUpdateOutcome::Rejected),
        Err(error) => return Err(error),
    };
    let next_source = title_source_name(source);
    // Empty-to-empty "updates" carry no information — treat them as no-ops
    // regardless of source, so a source flip alone never broadcasts a
    // TerminalUpdated with an unchanged (empty) title.
    if title.is_empty() && current_title.is_empty() {
        return Ok(TitleUpdateOutcome::Unchanged);
    }
    if current_source == "osc" && source == TerminalTitleSource::Process {
        return Ok(TitleUpdateOutcome::Rejected);
    }
    if current_title == title && current_source == next_source {
        return Ok(TitleUpdateOutcome::Unchanged);
    }
    conn.execute(
        "UPDATE terminal_sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
        params![title, next_source, id],
    )?;
    Ok(TitleUpdateOutcome::Updated)
}

pub fn assign_workspace_group(
    conn: &Connection,
    id: &str,
    workspace_group_id: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE terminal_sessions SET workspace_group_id = ?1 WHERE id = ?2",
        params![workspace_group_id, id],
    )?;
    Ok(())
}

pub fn clear_workspace_group(conn: &Connection, workspace_group_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE terminal_sessions SET workspace_group_id = NULL WHERE workspace_group_id = ?1",
        params![workspace_group_id],
    )?;
    Ok(())
}

/// Live panes still in a tab — 0 means the tab is empty and a hub-created one
/// can go.
pub fn count_active_in_workspace_group(
    conn: &Connection,
    workspace_group_id: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM terminal_sessions
         WHERE workspace_group_id = ?1 AND destroyed_at IS NULL",
        params![workspace_group_id],
        |row| row.get(0),
    )
}

pub fn find_active_by_machine(
    conn: &Connection,
    machine_id: &str,
) -> rusqlite::Result<Vec<TerminalSessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, title, title_source, cwd, workspace_group_id, cols, rows, created_at, destroyed_at
         FROM terminal_sessions WHERE machine_id = ?1 AND destroyed_at IS NULL
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![machine_id], |row| {
        Ok(TerminalSessionRow {
            id: row.get(0)?,
            machine_id: row.get(1)?,
            title: row.get(2)?,
            title_source: row.get(3)?,
            cwd: row.get(4)?,
            workspace_group_id: row.get(5)?,
            cols: row.get(6)?,
            rows: row.get(7)?,
            created_at: row.get(8)?,
            destroyed_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn find_all_active(conn: &Connection) -> rusqlite::Result<Vec<TerminalSessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, title, title_source, cwd, workspace_group_id, cols, rows, created_at, destroyed_at
         FROM terminal_sessions WHERE destroyed_at IS NULL
         ORDER BY machine_id ASC, created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TerminalSessionRow {
            id: row.get(0)?,
            machine_id: row.get(1)?,
            title: row.get(2)?,
            title_source: row.get(3)?,
            cwd: row.get(4)?,
            workspace_group_id: row.get(5)?,
            cols: row.get(6)?,
            rows: row.get(7)?,
            created_at: row.get(8)?,
            destroyed_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};
    use offdesk_protocol::TerminalTitleSource;

    use super::{
        apply_cwd_update, apply_title_update, find_active_by_machine, find_all_active,
        TitleUpdateOutcome,
    };

    fn insert_session(conn: &Connection, id: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO terminal_sessions
                (id, machine_id, title, cwd, cols, rows, created_at)
             VALUES (?1, 'machine-a', ?2, '/tmp', 80, 24, ?3)",
            params![id, format!("Terminal {id}"), created_at],
        )
        .unwrap();
    }

    #[test]
    fn active_sessions_are_returned_in_stable_creation_order() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin")
            .unwrap();
        crate::db::machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("linux"),
            Some("/tmp"),
        )
        .unwrap();

        insert_session(&conn, "late", 200);
        insert_session(&conn, "same-b", 100);
        insert_session(&conn, "same-a", 100);

        let machine_ids: Vec<String> = find_active_by_machine(&conn, "machine-a")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(machine_ids, ["same-a", "same-b", "late"]);

        let all_ids: Vec<String> = find_all_active(&conn)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(all_ids, ["same-a", "same-b", "late"]);
    }

    #[test]
    fn process_title_never_overwrites_an_osc_title() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin")
            .unwrap();
        crate::db::machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("linux"),
            Some("/tmp"),
        )
        .unwrap();
        insert_session(&conn, "term-a", 100);

        assert_eq!(
            apply_title_update(&conn, "term-a", "editor", TerminalTitleSource::Osc).unwrap(),
            TitleUpdateOutcome::Updated
        );
        assert_eq!(
            apply_title_update(
                &conn,
                "term-a",
                "foreground-process",
                TerminalTitleSource::Process,
            )
            .unwrap(),
            TitleUpdateOutcome::Rejected
        );

        let row = find_active_by_machine(&conn, "machine-a")
            .unwrap()
            .remove(0);
        assert_eq!(row.title, "editor");
        assert_eq!(row.title_source, "osc");
    }

    #[test]
    fn empty_to_empty_title_updates_are_no_ops_regardless_of_source() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin")
            .unwrap();
        crate::db::machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("linux"),
            Some("/tmp"),
        )
        .unwrap();
        // A terminal whose stored title is still empty (source "none").
        conn.execute(
            "INSERT INTO terminal_sessions
                (id, machine_id, title, cwd, cols, rows, created_at)
             VALUES ('term-a', 'machine-a', '', '/tmp', 80, 24, 100)",
            [],
        )
        .unwrap();

        for source in [TerminalTitleSource::Osc, TerminalTitleSource::Process] {
            assert_eq!(
                apply_title_update(&conn, "term-a", "", source).unwrap(),
                TitleUpdateOutcome::Unchanged
            );
        }
        // The source flip must not have been persisted either.
        let row = find_active_by_machine(&conn, "machine-a")
            .unwrap()
            .remove(0);
        assert_eq!(row.title, "");
        assert_eq!(row.title_source, "none");

        // A real title still applies normally from the same state.
        assert_eq!(
            apply_title_update(&conn, "term-a", "editor", TerminalTitleSource::Osc).unwrap(),
            TitleUpdateOutcome::Updated
        );
    }

    #[test]
    fn cwd_update_applies_only_on_real_changes() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin")
            .unwrap();
        crate::db::machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("linux"),
            Some("/tmp"),
        )
        .unwrap();
        insert_session(&conn, "term-a", 100);

        // Changed cwd → applied.
        assert!(apply_cwd_update(&conn, "term-a", "/home/user/project").unwrap());
        let row = find_active_by_machine(&conn, "machine-a")
            .unwrap()
            .remove(0);
        assert_eq!(row.cwd, "/home/user/project");

        // Same cwd again → no-op.
        assert!(!apply_cwd_update(&conn, "term-a", "/home/user/project").unwrap());

        // Unknown terminal → silently ignored.
        assert!(!apply_cwd_update(&conn, "term-missing", "/elsewhere").unwrap());

        // Destroyed terminal → silently ignored.
        super::mark_destroyed(&conn, "term-a").unwrap();
        assert!(!apply_cwd_update(&conn, "term-a", "/elsewhere").unwrap());
    }
}
