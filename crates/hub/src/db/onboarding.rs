use rusqlite::{params, Connection};

use super::now_ms;

/// What a person has dismissed in onboarding. Each mark is its own row, so the Mac and
/// the phone can add theirs at the same moment without one overwriting the other.
pub fn marks(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT mark FROM onboarding_marks WHERE user_id = ?1 ORDER BY created_at, mark")?;
    let rows = stmt.query_map(params![user_id], |row| row.get(0))?;
    rows.collect()
}

pub fn add_mark(conn: &Connection, user_id: &str, mark: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO onboarding_marks (user_id, mark, created_at) VALUES (?1, ?2, ?3)",
        params![user_id, mark, now_ms()],
    )?;
    Ok(())
}

pub fn remove_mark(conn: &Connection, user_id: &str, mark: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM onboarding_marks WHERE user_id = ?1 AND mark = ?2",
        params![user_id, mark],
    )?;
    Ok(())
}

/// Closed terminals keep their row, so this stays true after the first one ends.
pub fn has_started_a_session(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM terminal_sessions t
             JOIN machines m ON m.id = t.machine_id
             WHERE m.user_id = ?1
         )",
        params![user_id],
        |row| row.get(0),
    )
}
