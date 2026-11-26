use rusqlite::{params, Connection};

use super::now_ms;
use super::types::WorkspaceGroupRow;

pub fn find_workspace_groups_by_user(
    conn: &Connection,
    user_id: &str,
) -> rusqlite::Result<Vec<WorkspaceGroupRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, machine_id, name, sort_order, created_at, space_id
         FROM workspace_groups WHERE user_id = ?1
         ORDER BY machine_id ASC, sort_order ASC, name ASC",
    )?;
    let rows = stmt.query_map(params![user_id], workspace_group_from_row)?;
    rows.collect()
}

pub fn find_workspace_groups_by_machine(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
) -> rusqlite::Result<Vec<WorkspaceGroupRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, machine_id, name, sort_order, created_at, space_id
         FROM workspace_groups WHERE user_id = ?1 AND machine_id = ?2
         ORDER BY sort_order ASC, name ASC",
    )?;
    let rows = stmt.query_map(params![user_id, machine_id], workspace_group_from_row)?;
    rows.collect()
}

pub fn find_workspace_groups_by_space(
    conn: &Connection,
    user_id: &str,
    space_id: &str,
) -> rusqlite::Result<Vec<WorkspaceGroupRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, machine_id, name, sort_order, created_at, space_id
         FROM workspace_groups WHERE user_id = ?1 AND space_id = ?2
         ORDER BY machine_id ASC, sort_order ASC, name ASC",
    )?;
    let rows = stmt.query_map(params![user_id, space_id], workspace_group_from_row)?;
    rows.collect()
}

pub fn workspace_group_belongs_to_machine(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM workspace_groups
         WHERE id = ?1 AND user_id = ?2 AND machine_id = ?3",
        params![group_id, user_id, machine_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn create_workspace_group(
    conn: &Connection,
    id: &str,
    user_id: &str,
    machine_id: &str,
    name: &str,
    sort_order: i64,
) -> rusqlite::Result<WorkspaceGroupRow> {
    insert_workspace_group(conn, id, user_id, machine_id, name, sort_order, false, None)
}

pub fn create_workspace_group_in_space(
    conn: &Connection,
    id: &str,
    user_id: &str,
    machine_id: &str,
    name: &str,
    sort_order: i64,
    space_id: Option<&str>,
) -> rusqlite::Result<WorkspaceGroupRow> {
    insert_workspace_group(conn, id, user_id, machine_id, name, sort_order, false, space_id)
}

/// A tab the hub opened for a terminal created without one. It lives as long
/// as its panes — `delete_workspace_group_if_auto` drops it once the last one
/// closes, the way the client-derived cwd tabs it replaced used to vanish —
/// until the user renames it and makes it their own.
pub fn create_auto_workspace_group(
    conn: &Connection,
    id: &str,
    user_id: &str,
    machine_id: &str,
    name: &str,
    sort_order: i64,
) -> rusqlite::Result<WorkspaceGroupRow> {
    insert_workspace_group(conn, id, user_id, machine_id, name, sort_order, true, None)
}

#[allow(clippy::too_many_arguments)]
fn insert_workspace_group(
    conn: &Connection,
    id: &str,
    user_id: &str,
    machine_id: &str,
    name: &str,
    sort_order: i64,
    auto_created: bool,
    space_id: Option<&str>,
) -> rusqlite::Result<WorkspaceGroupRow> {
    let created_at = now_ms();
    let space_id = space_id.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO workspace_groups
             (id, user_id, machine_id, name, sort_order, created_at, auto_created, space_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            user_id,
            machine_id,
            name,
            sort_order,
            created_at,
            auto_created as i64,
            space_id
        ],
    )?;
    Ok(WorkspaceGroupRow {
        id: id.to_string(),
        user_id: user_id.to_string(),
        machine_id: machine_id.to_string(),
        name: name.to_string(),
        sort_order,
        created_at,
        space_id: space_id.map(str::to_string),
    })
}

pub fn update_workspace_group_sort_order(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
    sort_order: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE workspace_groups SET sort_order = ?1
         WHERE id = ?2 AND user_id = ?3 AND machine_id = ?4",
        params![sort_order, group_id, user_id, machine_id],
    )
}

/// Renaming adopts a hub-created tab: a tab the user has named is theirs and
/// outlives its panes, like one they created from the tab bar.
pub fn update_workspace_group_name(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
    name: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE workspace_groups SET name = ?1, auto_created = 0
         WHERE id = ?2 AND user_id = ?3 AND machine_id = ?4",
        params![name, group_id, user_id, machine_id],
    )
}

pub fn update_workspace_group_space(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
    space_id: Option<&str>,
) -> rusqlite::Result<usize> {
    let space_id = space_id.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE workspace_groups SET space_id = ?1
         WHERE id = ?2 AND user_id = ?3 AND machine_id = ?4",
        params![space_id, group_id, user_id, machine_id],
    )
}

/// Drop a hub-created tab; a tab the user created or renamed is left alone.
pub fn delete_workspace_group_if_auto(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM workspace_groups
         WHERE id = ?1 AND user_id = ?2 AND machine_id = ?3 AND auto_created = 1",
        params![group_id, user_id, machine_id],
    )
}

pub fn delete_workspace_group(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
    group_id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM workspace_groups
         WHERE id = ?1 AND user_id = ?2 AND machine_id = ?3",
        params![group_id, user_id, machine_id],
    )
}

fn workspace_group_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceGroupRow> {
    Ok(WorkspaceGroupRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        machine_id: row.get(2)?,
        name: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        space_id: row.get(6)?,
    })
}

/// Sort order for a tab appended to the end of a machine's strip. Every tab
/// is a row with a sort_order, so "append" is always max + 1.
pub fn next_sort_order(
    conn: &Connection,
    user_id: &str,
    machine_id: &str,
) -> rusqlite::Result<i64> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(sort_order) FROM workspace_groups WHERE user_id = ?1 AND machine_id = ?2",
        params![user_id, machine_id],
        |row| row.get(0),
    )?;
    Ok(max.map_or(0, |sort_order| sort_order + 1))
}

/// Tab name for a terminal created without one: the cwd's last segment.
/// Mirrors labelFromCwd in packages/app/lib/terminalWorkspaceLayout.ts so a
/// hub-created tab reads exactly like the cwd tab clients used to derive.
pub fn workspace_group_name_from_cwd(cwd: &str) -> String {
    cwd.trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if cwd.is_empty() {
                "workspace".to_string()
            } else {
                cwd.to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::workspace_group_name_from_cwd;

    #[test]
    fn tab_name_is_the_cwd_tail() {
        assert_eq!(workspace_group_name_from_cwd("/work/repo"), "repo");
        assert_eq!(workspace_group_name_from_cwd("/work/repo/"), "repo");
        assert_eq!(workspace_group_name_from_cwd("/"), "/");
        assert_eq!(workspace_group_name_from_cwd("~"), "~");
        assert_eq!(workspace_group_name_from_cwd(""), "workspace");
    }
}
