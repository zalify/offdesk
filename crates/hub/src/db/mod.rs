use std::collections::HashMap;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use serde::Deserialize;
use offdesk_protocol::{WorkspaceLayoutNode, WorkspaceSplitDirection};

pub mod agent_runs;
pub mod agent_sessions;
pub mod bookmarks;
pub mod hub_state;
pub mod machines;
pub mod settings;
pub mod terminal_sessions;
pub mod tokens;
pub mod types;
pub mod user_focus;
pub mod users;
pub mod workspace_groups;
pub mod workspace_layouts;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn create_pool(path: &str) -> Result<DbPool, Box<dyn std::error::Error>> {
    let manager = SqliteConnectionManager::file(path);
    let pool = Pool::builder().max_size(8).build(manager)?;
    let conn = pool.get()?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(pool)
}

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    crate::composer::init(conn)?;
    crate::secure::store::init(conn)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            avatar_url TEXT,
            role TEXT NOT NULL DEFAULT 'user',
            created_at INTEGER NOT NULL,
            UNIQUE(provider, provider_id)
        );

        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            machine_secret_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'offline',
            os TEXT,
            home_dir TEXT,
            last_seen_at INTEGER,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS registration_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            machine_name TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS login_codes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_groups (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            auto_created INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS workspace_layouts (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            group_key TEXT NOT NULL,
            root_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, machine_id, group_key)
        );

        CREATE TABLE IF NOT EXISTS api_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            expires_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS user_focus (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            terminal_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_machine ON bookmarks(machine_id);
        CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
        CREATE INDEX IF NOT EXISTS idx_workspace_groups_machine
            ON workspace_groups(user_id, machine_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_workspace_layouts_machine
            ON workspace_layouts(user_id, machine_id);

        CREATE TABLE IF NOT EXISTS terminal_sessions (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            title_source TEXT NOT NULL DEFAULT 'none',
            cwd TEXT NOT NULL,
            workspace_group_id TEXT REFERENCES workspace_groups(id) ON DELETE SET NULL,
            cols INTEGER NOT NULL,
            rows INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            destroyed_at INTEGER,
            opened_by_kind TEXT,
            opened_by_label TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_machine
            ON terminal_sessions(machine_id);

        CREATE INDEX IF NOT EXISTS idx_terminal_sessions_active
            ON terminal_sessions(machine_id) WHERE destroyed_at IS NULL;

        CREATE TABLE IF NOT EXISTS hub_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            agent_kind TEXT NOT NULL,
            cwd TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'starting',
            auto_run INTEGER NOT NULL DEFAULT 1,
            acp_session_id TEXT,
            workspace_group_id TEXT REFERENCES workspace_groups(id) ON DELETE SET NULL,
            last_event_seq INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_sessions_user
            ON agent_sessions(user_id);

        CREATE INDEX IF NOT EXISTS idx_agent_sessions_machine
            ON agent_sessions(machine_id);

        CREATE TABLE IF NOT EXISTS agent_session_events (
            session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, seq)
        );

        CREATE TABLE IF NOT EXISTS agent_session_seen (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
            last_seen_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, session_id)
        );

        -- Agent runs: one coding agent process's life in one terminal
        -- (docs/plans/2026-10-14-agent-runs.md). terminal_id has no foreign key:
        -- a run outlives its terminal's row being marked destroyed.
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            terminal_id TEXT,
            agent TEXT NOT NULL,
            cwd TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            ended_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_agent_runs_machine
            ON agent_runs(machine_id, started_at);

        CREATE INDEX IF NOT EXISTS idx_agent_runs_terminal
            ON agent_runs(terminal_id, started_at);

        -- What a run waits on a person for; one open (resolved_at IS NULL) at a time.
        CREATE TABLE IF NOT EXISTS agent_run_requests (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            prompt TEXT,
            options TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            resolved_at INTEGER,
            resolution TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_agent_run_requests_open
            ON agent_run_requests(run_id) WHERE resolved_at IS NULL;

        -- A run's history: requests, reports and status changes (not terminal output).
        CREATE TABLE IF NOT EXISTS agent_run_events (
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, seq)
        );
    ",
    )?;

    // Agent run requests: when a person's answer was typed in, and what it was (A3)
    for (column, definition) in [("answered_at", "INTEGER"), ("answer", "TEXT")] {
        if !column_exists(conn, "agent_run_requests", column)? {
            conn.execute(&format!("ALTER TABLE agent_run_requests ADD COLUMN {column} {definition}"), [])?;
        }
    }

    // Agent runs: progress from the agent's task list and its latest own report (A2)
    for (column, definition) in [
        ("progress_done", "INTEGER"),
        ("progress_total", "INTEGER"),
        ("progress_current", "TEXT"),
        ("report_kind", "TEXT"),
        ("report_text", "TEXT"),
        ("report_link", "TEXT"),
        ("report_at", "INTEGER"),
    ] {
        if !column_exists(conn, "agent_runs", column)? {
            conn.execute(&format!("ALTER TABLE agent_runs ADD COLUMN {column} {definition}"), [])?;
        }
    }

    if !column_exists(conn, "terminal_sessions", "workspace_group_id")? {
        conn.execute(
            "ALTER TABLE terminal_sessions ADD COLUMN workspace_group_id TEXT REFERENCES workspace_groups(id) ON DELETE SET NULL",
            [],
        )?;
    }

    if !column_exists(conn, "terminal_sessions", "title_source")? {
        conn.execute(
            "ALTER TABLE terminal_sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'none'",
            [],
        )?;
    }

    // Who opened a terminal when it wasn't a person in an app (an API-token
    // client such as the `offdesk` CLI). NULL for everything created before.
    if !column_exists(conn, "terminal_sessions", "opened_by_kind")? {
        conn.execute(
            "ALTER TABLE terminal_sessions ADD COLUMN opened_by_kind TEXT",
            [],
        )?;
    }

    if !column_exists(conn, "terminal_sessions", "opened_by_label")? {
        conn.execute(
            "ALTER TABLE terminal_sessions ADD COLUMN opened_by_label TEXT",
            [],
        )?;
    }

    if !column_exists(conn, "workspace_groups", "auto_created")? {
        conn.execute(
            "ALTER TABLE workspace_groups ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    if !column_exists(conn, "machines", "production")? {
        conn.execute(
            "ALTER TABLE machines ADD COLUMN production INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    if !column_exists(conn, "agent_sessions", "available_models")? {
        conn.execute(
            "ALTER TABLE agent_sessions ADD COLUMN available_models TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }

    if !column_exists(conn, "agent_sessions", "current_model_id")? {
        conn.execute(
            "ALTER TABLE agent_sessions ADD COLUMN current_model_id TEXT",
            [],
        )?;
    }

    if !column_exists(conn, "agent_sessions", "requested_model_id")? {
        conn.execute(
            "ALTER TABLE agent_sessions ADD COLUMN requested_model_id TEXT",
            [],
        )?;
    }

    migrate_scrollable_workspace_layouts(conn)?;
    migrate_ungrouped_terminals_into_tabs(conn)?;
    delete_empty_auto_tabs(conn)?;

    // Startup recovery: mark all machines offline
    conn.execute("UPDATE machines SET status = 'offline'", [])?;

    Ok(())
}

/// Terminals created before the hub gave every terminal a tab carry no
/// workspace_group_id, and clients rendered them in a derived "cwd:<path>"
/// tab. Those derived tabs have no sort_order and always sort after the real
/// ones, so a newly created tab shows up to their left. Give each pre-existing
/// cwd bucket a real workspace_groups row — carrying its saved pane layout
/// over — so the strip is one ordered list. Idempotent: once every active
/// terminal has a tab the query returns nothing.
fn migrate_ungrouped_terminals_into_tabs(conn: &Connection) -> rusqlite::Result<()> {
    let ungrouped: Vec<(String, String, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT t.id, t.cwd, t.machine_id, m.user_id
             FROM terminal_sessions t
             JOIN machines m ON m.id = t.machine_id
             WHERE t.destroyed_at IS NULL AND t.workspace_group_id IS NULL
             ORDER BY t.created_at ASC, t.rowid ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // One tab per (owner, machine, cwd) bucket — exactly the tabs the clients
    // used to derive, so the strip looks unchanged apart from being ordered.
    let mut group_ids: HashMap<(String, String, String), String> = HashMap::new();
    for (terminal_id, cwd, machine_id, user_id) in ungrouped {
        let bucket = (user_id.clone(), machine_id.clone(), cwd.clone());
        let group_id = match group_ids.get(&bucket) {
            Some(group_id) => group_id.clone(),
            None => {
                let sort_order = workspace_groups::next_sort_order(conn, &user_id, &machine_id)?;
                let group_id = uuid::Uuid::new_v4().to_string();
                workspace_groups::create_auto_workspace_group(
                    conn,
                    &group_id,
                    &user_id,
                    &machine_id,
                    &workspace_groups::workspace_group_name_from_cwd(&cwd),
                    sort_order,
                )?;
                conn.execute(
                    "UPDATE workspace_layouts SET group_key = ?1
                     WHERE user_id = ?2 AND machine_id = ?3 AND group_key = ?4",
                    params![group_id, user_id, machine_id, format!("cwd:{cwd}")],
                )?;
                group_ids.insert(bucket, group_id.clone());
                group_id
            }
        };
        conn.execute(
            "UPDATE terminal_sessions SET workspace_group_id = ?1 WHERE id = ?2",
            params![group_id, terminal_id],
        )?;
    }

    Ok(())
}

/// Tabs the hub opened for a terminal disappear with their last pane. A hub
/// that went down between the two loses that chance, so the leftovers go at
/// startup — a tab the user created or renamed is never touched.
fn delete_empty_auto_tabs(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM workspace_groups
         WHERE auto_created = 1
           AND NOT EXISTS (
               SELECT 1 FROM terminal_sessions
               WHERE workspace_group_id = workspace_groups.id
                 AND destroyed_at IS NULL
           )",
        [],
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct LegacyScrollableLayout {
    columns: Vec<LegacyScrollableColumn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyScrollableColumn {
    terminal_id: String,
}

fn migrate_scrollable_workspace_layouts(conn: &Connection) -> rusqlite::Result<()> {
    if !column_exists(conn, "workspace_layouts", "layout_mode")?
        || !column_exists(conn, "workspace_layouts", "aux_json")?
    {
        return Ok(());
    }

    let legacy_rows = {
        let mut statement = conn.prepare(
            "SELECT rowid, aux_json FROM workspace_layouts WHERE layout_mode = 'scrollable'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (row_id, aux_json) in legacy_rows {
        let Some(layout) = aux_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<LegacyScrollableLayout>(json).ok())
        else {
            continue;
        };
        let terminal_ids = layout
            .columns
            .into_iter()
            .map(|column| column.terminal_id)
            .collect::<Vec<_>>();
        let root_json = serde_json::to_string(&split_tree_from_terminal_ids(&terminal_ids))
            .expect("workspace split trees are serializable");
        conn.execute(
            "UPDATE workspace_layouts SET root_json = ?1 WHERE rowid = ?2",
            rusqlite::params![root_json, row_id],
        )?;
    }

    conn.execute(
        "UPDATE workspace_layouts SET layout_mode = NULL, aux_json = NULL",
        [],
    )?;
    Ok(())
}

fn split_tree_from_terminal_ids(terminal_ids: &[String]) -> Option<WorkspaceLayoutNode> {
    match terminal_ids {
        [] => None,
        [terminal_id] => Some(WorkspaceLayoutNode::Leaf {
            terminal_id: terminal_id.clone(),
        }),
        [terminal_id, remaining @ ..] => Some(WorkspaceLayoutNode::Split {
            direction: WorkspaceSplitDirection::Horizontal,
            ratio: 0.5,
            first: Box::new(WorkspaceLayoutNode::Leaf {
                terminal_id: terminal_id.clone(),
            }),
            second: Box::new(
                split_tree_from_terminal_ids(remaining)
                    .expect("a non-empty remainder produces a split tree"),
            ),
        }),
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        users::create_user(&conn, "user-a", "test", "user-a", "User A", None, "admin").unwrap();
        machines::ensure_machine_for_user(
            &conn,
            "machine-a",
            "user-a",
            "Machine A",
            Some("linux"),
            Some("/tmp"),
        )
        .unwrap();
        conn
    }

    #[test]
    fn terminal_opener_columns_are_added_to_an_existing_table() {
        let conn = Connection::open_in_memory().unwrap();
        // terminal_sessions as hubs created it before openers were recorded.
        conn.execute_batch(
            "CREATE TABLE terminal_sessions (
                id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                title TEXT NOT NULL,
                title_source TEXT NOT NULL DEFAULT 'none',
                cwd TEXT NOT NULL,
                workspace_group_id TEXT,
                cols INTEGER NOT NULL,
                rows INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                destroyed_at INTEGER
            );",
        )
        .unwrap();

        init_db(&conn).unwrap();

        assert!(column_exists(&conn, "terminal_sessions", "opened_by_kind").unwrap());
        assert!(column_exists(&conn, "terminal_sessions", "opened_by_label").unwrap());
        // Running it again is a no-op.
        init_db(&conn).unwrap();
    }

    #[test]
    fn terminal_opener_round_trips_and_defaults_to_none() {
        use offdesk_protocol::{TerminalOpener, TerminalOpenerKind};

        let conn = migrated_db();
        terminal_sessions::insert(&conn, "by-cli", "machine-a", "claude", "/repo", 80, 24)
            .unwrap();
        terminal_sessions::insert(&conn, "by-app", "machine-a", "bash", "/repo", 80, 24).unwrap();
        let opener = TerminalOpener {
            kind: TerminalOpenerKind::Cli,
            label: Some("ci-bot".to_string()),
        };
        terminal_sessions::set_opened_by(&conn, "by-cli", &opener).unwrap();

        let rows = terminal_sessions::find_all_active(&conn).unwrap();
        let opener_of = |id: &str| {
            terminal_sessions::opener_from_row(rows.iter().find(|row| row.id == id).unwrap())
        };
        assert_eq!(opener_of("by-cli"), Some(opener));
        assert_eq!(opener_of("by-app"), None);

        // A later machine report (insert's upsert) keeps the opener.
        terminal_sessions::insert(&conn, "by-cli", "machine-a", "claude", "/repo2", 100, 30)
            .unwrap();
        let rows = terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        let row = rows.iter().find(|row| row.id == "by-cli").unwrap();
        assert_eq!(row.opened_by_kind.as_deref(), Some("cli"));
        assert_eq!(row.opened_by_label.as_deref(), Some("ci-bot"));
    }

    #[test]
    fn migration_gives_every_live_terminal_a_tab_of_its_cwd() {
        let conn = migrated_db();
        terminal_sessions::insert(&conn, "t1", "machine-a", "T1", "/work/repo", 80, 24).unwrap();
        terminal_sessions::insert(&conn, "t2", "machine-a", "T2", "/work/repo", 80, 24).unwrap();
        terminal_sessions::insert(&conn, "t3", "machine-a", "T3", "/work/other", 80, 24).unwrap();
        terminal_sessions::insert(&conn, "t4", "machine-a", "T4", "/work/gone", 80, 24).unwrap();
        terminal_sessions::mark_destroyed(&conn, "t4").unwrap();
        conn.execute(
            "INSERT INTO workspace_layouts (user_id, machine_id, group_key, root_json, updated_at)
             VALUES ('user-a', 'machine-a', 'cwd:/work/repo', '{}', 1)",
            [],
        )
        .unwrap();

        migrate_ungrouped_terminals_into_tabs(&conn).unwrap();

        let groups =
            workspace_groups::find_workspace_groups_by_machine(&conn, "user-a", "machine-a")
                .unwrap();
        assert_eq!(
            groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            vec!["repo", "other"],
            "one tab per cwd bucket, destroyed terminals ignored"
        );
        let repo_group = &groups[0];

        let sessions = terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        let tab_of = |id: &str| {
            sessions
                .iter()
                .find(|row| row.id == id)
                .unwrap()
                .workspace_group_id
                .clone()
        };
        assert_eq!(tab_of("t1"), Some(repo_group.id.clone()));
        assert_eq!(tab_of("t2"), Some(repo_group.id.clone()));
        assert_eq!(tab_of("t3"), Some(groups[1].id.clone()));

        let layout_key: String = conn
            .query_row(
                "SELECT group_key FROM workspace_layouts WHERE machine_id = 'machine-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            layout_key, repo_group.id,
            "the derived tab's saved pane layout follows it into the real tab"
        );

        migrate_ungrouped_terminals_into_tabs(&conn).unwrap();
        assert_eq!(
            workspace_groups::find_workspace_groups_by_machine(&conn, "user-a", "machine-a")
                .unwrap()
                .len(),
            2,
            "rerunning the migration creates nothing"
        );
    }

    #[test]
    fn migrated_tabs_append_after_existing_ones() {
        let conn = migrated_db();
        workspace_groups::create_workspace_group(
            &conn,
            "group-a",
            "user-a",
            "machine-a",
            "tab 1",
            3,
        )
        .unwrap();
        terminal_sessions::insert(&conn, "t1", "machine-a", "T1", "/work/repo", 80, 24).unwrap();

        migrate_ungrouped_terminals_into_tabs(&conn).unwrap();

        let groups =
            workspace_groups::find_workspace_groups_by_machine(&conn, "user-a", "machine-a")
                .unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[1].name, "repo");
        assert_eq!(groups[1].sort_order, 4);
    }
}
