//! Personal to-dos, one list per user. Ids come from the client and the
//! first write wins, so a retried create never adds a second row.
use offdesk_protocol::todos::{TodoInfo, TodoStatus};
use rusqlite::{params, Connection, OptionalExtension, Row};

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS todos (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open',
            position REAL NOT NULL,
            machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
            cwd TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            PRIMARY KEY (user_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_todos_user_position ON todos(user_id, position);",
    )
}

const COLUMNS: &str =
    "id, title, notes, status, position, machine_id, cwd, created_at, updated_at, completed_at";

fn row_to_todo(row: &Row<'_>) -> rusqlite::Result<TodoInfo> {
    let status: String = row.get(3)?;
    Ok(TodoInfo {
        id: row.get(0)?,
        title: row.get(1)?,
        notes: row.get(2)?,
        status: if status == "done" {
            TodoStatus::Done
        } else {
            TodoStatus::Open
        },
        position: row.get(4)?,
        machine_id: row.get(5)?,
        cwd: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}

fn status_name(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Open => "open",
        TodoStatus::Done => "done",
    }
}

pub fn list(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<TodoInfo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM todos WHERE user_id = ?1 ORDER BY position ASC, created_at DESC"
    ))?;
    let rows = stmt.query_map(params![user_id], row_to_todo)?;
    rows.collect()
}

pub fn find(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<Option<TodoInfo>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM todos WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        row_to_todo,
    )
    .optional()
}

pub fn count(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM todos WHERE user_id = ?1",
        params![user_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
}

pub struct NewTodo<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub notes: &'a str,
    pub machine_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
}

/// Insert at the top of the list. Returns the stored row, which is the
/// earlier one when this id already exists.
pub fn create(conn: &Connection, user_id: &str, todo: NewTodo<'_>) -> rusqlite::Result<TodoInfo> {
    let now = super::now_ms();
    conn.execute(
        "INSERT INTO todos (user_id, id, title, notes, status, position, machine_id, cwd, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'open',
                 COALESCE((SELECT MIN(position) FROM todos WHERE user_id = ?1), 0) - 1,
                 ?5, ?6, ?7, ?7)
         ON CONFLICT(user_id, id) DO NOTHING",
        params![user_id, todo.id, todo.title, todo.notes, todo.machine_id, todo.cwd, now],
    )?;
    find(conn, user_id, todo.id).map(|row| row.expect("row exists after insert"))
}

/// Fields to change; `None` leaves a field as it is. For the nullable
/// location fields, `Some(None)` clears them.
#[derive(Default)]
pub struct TodoPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub status: Option<TodoStatus>,
    pub position: Option<f64>,
    pub machine_id: Option<Option<String>>,
    pub cwd: Option<Option<String>>,
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    patch: TodoPatch,
) -> rusqlite::Result<Option<TodoInfo>> {
    let Some(mut todo) = find(conn, user_id, id)? else {
        return Ok(None);
    };
    let now = super::now_ms();
    if let Some(title) = patch.title {
        todo.title = title;
    }
    if let Some(notes) = patch.notes {
        todo.notes = notes;
    }
    if let Some(status) = patch.status {
        if status != todo.status {
            todo.completed_at = (status == TodoStatus::Done).then_some(now);
        }
        todo.status = status;
    }
    if let Some(position) = patch.position.filter(|p| p.is_finite()) {
        todo.position = position;
    }
    if let Some(machine_id) = patch.machine_id {
        todo.machine_id = machine_id;
    }
    if let Some(cwd) = patch.cwd {
        todo.cwd = cwd;
    }
    todo.updated_at = now;
    conn.execute(
        "UPDATE todos SET title = ?3, notes = ?4, status = ?5, position = ?6, machine_id = ?7,
                cwd = ?8, updated_at = ?9, completed_at = ?10
         WHERE user_id = ?1 AND id = ?2",
        params![
            user_id,
            id,
            todo.title,
            todo.notes,
            status_name(todo.status),
            todo.position,
            todo.machine_id,
            todo.cwd,
            todo.updated_at,
            todo.completed_at
        ],
    )?;
    Ok(Some(todo))
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    conn.execute(
        "DELETE FROM todos WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )
    .map(|changed| changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        for user in ["user-a", "user-b"] {
            crate::db::users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
        }
        crate::db::machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("macos"),
            Some("/Users/a"),
        )
        .unwrap();
        conn
    }

    fn new<'a>(id: &'a str, title: &'a str) -> NewTodo<'a> {
        NewTodo {
            id,
            title,
            notes: "",
            machine_id: None,
            cwd: None,
        }
    }

    #[test]
    fn new_to_dos_go_on_top_and_retries_keep_the_first_write() {
        let conn = db();
        let first = create(&conn, "user-a", new("1", "First")).unwrap();
        let second = create(&conn, "user-a", new("2", "Second")).unwrap();
        assert!(second.position < first.position);
        let retried = create(&conn, "user-a", new("1", "Changed")).unwrap();
        assert_eq!(retried.title, "First");
        let titles: Vec<_> = list(&conn, "user-a")
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(titles, ["Second", "First"]);
        // Lists are per user, even with the same id.
        create(&conn, "user-b", new("1", "Other user")).unwrap();
        assert_eq!(count(&conn, "user-a").unwrap(), 2);
        assert_eq!(
            find(&conn, "user-b", "1").unwrap().unwrap().title,
            "Other user"
        );
    }

    #[test]
    fn completing_records_when_and_reopening_clears_it() {
        let conn = db();
        create(&conn, "user-a", new("1", "Ship")).unwrap();
        let done = update(
            &conn,
            "user-a",
            "1",
            TodoPatch {
                status: Some(TodoStatus::Done),
                machine_id: Some(Some("machine-a".into())),
                cwd: Some(Some("/Users/a/repo".into())),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        assert!(done.completed_at.is_some());
        assert_eq!(done.cwd.as_deref(), Some("/Users/a/repo"));
        let reopened = update(
            &conn,
            "user-a",
            "1",
            TodoPatch {
                status: Some(TodoStatus::Open),
                cwd: Some(None),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(reopened.completed_at, None);
        assert_eq!(reopened.cwd, None);
        assert_eq!(reopened.machine_id.as_deref(), Some("machine-a"));
        assert_eq!(find(&conn, "user-a", "1").unwrap().unwrap(), reopened);
        assert!(update(&conn, "user-b", "1", TodoPatch::default())
            .unwrap()
            .is_none());
        assert!(!delete(&conn, "user-b", "1").unwrap());
        assert!(delete(&conn, "user-a", "1").unwrap());
        assert!(list(&conn, "user-a").unwrap().is_empty());
    }

    #[test]
    fn forgetting_a_machine_keeps_its_to_dos() {
        let conn = db();
        create(
            &conn,
            "user-a",
            NewTodo {
                machine_id: Some("machine-a"),
                cwd: Some("/Users/a/repo"),
                ..new("1", "Ship")
            },
        )
        .unwrap();
        conn.execute("DELETE FROM machines WHERE id = 'machine-a'", [])
            .unwrap();
        let todo = find(&conn, "user-a", "1").unwrap().unwrap();
        assert_eq!(todo.machine_id, None);
        assert_eq!(todo.cwd.as_deref(), Some("/Users/a/repo"));
    }
}
