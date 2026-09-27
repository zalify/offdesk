//! User-authored manual handoff records. These are not agent delivery receipts.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct HandoffContent {
    pub source_terminal_id: String,
    pub target_terminal_id: String,
    pub source_agent: String,
    pub target_agent: String,
    pub cwd: String,
    pub goal: String,
    pub intent: String,
    pub summary: String,
    pub artifacts: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionHandoff {
    pub id: String,
    pub machine_id: String,
    #[serde(flatten)]
    pub content: HandoffContent,
    pub created_at: i64,
    pub submitted_at: Option<i64>,
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_handoffs (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            source_terminal_id TEXT NOT NULL,
            target_terminal_id TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            submitted_at INTEGER,
            PRIMARY KEY (user_id, machine_id, id)
        );
        CREATE INDEX IF NOT EXISTS session_handoffs_source
            ON session_handoffs(user_id, machine_id, source_terminal_id, created_at);
        CREATE INDEX IF NOT EXISTS session_handoffs_target
            ON session_handoffs(user_id, machine_id, target_terminal_id, created_at);",
    )
}

fn decode(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionHandoff> {
    let json: String = row.get(2)?;
    let content = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(SessionHandoff {
        id: row.get(0)?,
        machine_id: row.get(1)?,
        content,
        created_at: row.get(3)?,
        submitted_at: row.get(4)?,
    })
}

pub fn find(
    conn: &Connection,
    user: &str,
    machine: &str,
    id: &str,
) -> rusqlite::Result<Option<SessionHandoff>> {
    conn.query_row(
        "SELECT id, machine_id, content_json, created_at, submitted_at FROM session_handoffs
         WHERE user_id = ?1 AND machine_id = ?2 AND id = ?3",
        params![user, machine, id],
        decode,
    )
    .optional()
}

pub fn list(
    conn: &Connection,
    user: &str,
    machine: &str,
    terminal: &str,
) -> rusqlite::Result<Vec<SessionHandoff>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, content_json, created_at, submitted_at FROM session_handoffs
         WHERE user_id = ?1 AND machine_id = ?2 AND (source_terminal_id = ?3 OR target_terminal_id = ?3)
         ORDER BY created_at DESC, rowid DESC LIMIT 25",
    )?;
    let rows = stmt.query_map(params![user, machine, terminal], decode)?;
    rows.collect()
}

/// The first request wins, including across concurrent connections. Callers
/// compare the returned content and reject ID reuse with different input.
pub fn save(
    conn: &Connection,
    user: &str,
    machine: &str,
    id: &str,
    content: &HandoffContent,
) -> rusqlite::Result<SessionHandoff> {
    let json = serde_json::to_string(content).expect("handoff contains only strings");
    conn.execute(
        "INSERT INTO session_handoffs
         (user_id, machine_id, id, source_terminal_id, target_terminal_id, content_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, machine_id, id) DO NOTHING",
        params![
            user,
            machine,
            id,
            content.source_terminal_id,
            content.target_terminal_id,
            json,
            super::now_ms()
        ],
    )?;
    find(conn, user, machine, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn confirm(
    conn: &Connection,
    user: &str,
    machine: &str,
    id: &str,
) -> rusqlite::Result<Option<SessionHandoff>> {
    conn.execute(
        "UPDATE session_handoffs SET submitted_at = COALESCE(submitted_at, ?4)
         WHERE user_id = ?1 AND machine_id = ?2 AND id = ?3",
        params![user, machine, id, super::now_ms()],
    )?;
    find(conn, user, machine, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn content() -> HandoffContent {
        HandoffContent {
            source_terminal_id: "a".into(),
            target_terminal_id: "b".into(),
            source_agent: "claude".into(),
            target_agent: "codex".into(),
            cwd: "/repo".into(),
            goal: "Keep my changes".into(),
            intent: "Build API".into(),
            summary: "UI done".into(),
            artifacts: "".into(),
        }
    }
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE machines(id TEXT PRIMARY KEY);
            INSERT INTO users VALUES ('u'), ('other'); INSERT INTO machines VALUES ('m'), ('other');").unwrap();
        init(&conn).unwrap();
        conn
    }
    #[test]
    fn handoff_save_is_immutable_and_replay_safe() {
        let conn = database();
        let first = save(&conn, "u", "m", "id", &content()).unwrap();
        let mut edited = content();
        edited.intent = "overwrite".into();
        let second = save(&conn, "u", "m", "id", &edited).unwrap();
        assert_eq!(first.content, second.content);
        assert_eq!(list(&conn, "u", "m", "a").unwrap().len(), 1);
        assert_eq!(list(&conn, "u", "m", "b").unwrap().len(), 1);
    }
    #[test]
    fn handoff_confirmation_is_scoped_and_does_not_rewrite_content() {
        let conn = database();
        save(&conn, "u", "m", "id", &content()).unwrap();
        assert!(confirm(&conn, "other", "m", "id").unwrap().is_none());
        assert!(confirm(&conn, "u", "other", "id").unwrap().is_none());
        assert!(list(&conn, "other", "m", "a").unwrap().is_empty());
        let first = confirm(&conn, "u", "m", "id").unwrap().unwrap();
        let second = confirm(&conn, "u", "m", "id").unwrap().unwrap();
        assert!(first.submitted_at.is_some());
        assert_eq!(first.submitted_at, second.submitted_at);
        assert_eq!(first.content, content());
    }

    #[test]
    fn handoff_survives_reopening_the_database() {
        let path =
            std::env::temp_dir().join(format!("offdesk-handoff-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE machines(id TEXT PRIMARY KEY);
                INSERT INTO users VALUES ('u'); INSERT INTO machines VALUES ('m');").unwrap();
            init(&conn).unwrap();
            save(&conn, "u", "m", "id", &content()).unwrap();
            confirm(&conn, "u", "m", "id").unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            init(&conn).unwrap();
            let record = find(&conn, "u", "m", "id").unwrap().unwrap();
            assert_eq!(record.content, content());
            assert!(record.submitted_at.is_some());
            save(&conn, "u", "m", "id", &content()).unwrap();
            assert_eq!(list(&conn, "u", "m", "a").unwrap().len(), 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}
