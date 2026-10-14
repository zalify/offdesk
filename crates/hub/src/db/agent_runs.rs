//! Agent runs and their requests (docs/plans/2026-10-14-agent-runs.md). A run is one
//! coding agent process's life in one terminal; the machine manager opens and ends
//! them from what nodes report (`MachineToHub::TerminalAgent`, attention, terminal
//! and machine lifecycle). Runs belong to a machine, so they're visible to its owner.

use offdesk_protocol::{
    AgentQuestionOption, AgentRequestKind, AgentRunInfo, AgentRunRequest, AgentRunStatus, RunAgent,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunRow {
    pub id: String,
    pub machine_id: String,
    pub terminal_id: Option<String>,
    pub agent: RunAgent,
    pub cwd: String,
    pub status: AgentRunStatus,
    pub started_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
}

const COLUMNS: &str =
    "id, machine_id, terminal_id, agent, cwd, status, started_at, updated_at, ended_at";

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<AgentRunRow> {
    Ok(AgentRunRow {
        id: row.get(0)?,
        machine_id: row.get(1)?,
        terminal_id: row.get(2)?,
        agent: RunAgent::from_name(&row.get::<_, String>(3)?),
        cwd: row.get(4)?,
        status: AgentRunStatus::from_name(&row.get::<_, String>(5)?),
        started_at: row.get(6)?,
        updated_at: row.get(7)?,
        ended_at: row.get(8)?,
    })
}

pub fn find(conn: &Connection, id: &str) -> rusqlite::Result<Option<AgentRunRow>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM agent_runs WHERE id = ?1"),
        params![id],
        map_row,
    )
    .optional()
}

/// The newest run in a terminal, open or not.
pub fn latest_for_terminal(
    conn: &Connection,
    terminal_id: &str,
) -> rusqlite::Result<Option<AgentRunRow>> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM agent_runs WHERE terminal_id = ?1
             ORDER BY started_at DESC, rowid DESC LIMIT 1"
        ),
        params![terminal_id],
        map_row,
    )
    .optional()
}

pub fn insert(
    conn: &Connection,
    machine_id: &str,
    terminal_id: &str,
    agent: RunAgent,
    cwd: &str,
    status: AgentRunStatus,
) -> rusqlite::Result<AgentRunRow> {
    let now = now_ms();
    let row = AgentRunRow {
        id: uuid::Uuid::new_v4().to_string(),
        machine_id: machine_id.to_string(),
        terminal_id: Some(terminal_id.to_string()),
        agent,
        cwd: cwd.to_string(),
        status,
        started_at: now,
        updated_at: now,
        ended_at: status.ends_run().then_some(now),
    };
    conn.execute(
        &format!("INSERT INTO agent_runs ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
        params![
            row.id,
            row.machine_id,
            row.terminal_id,
            row.agent.as_str(),
            row.cwd,
            row.status.as_str(),
            row.started_at,
            row.updated_at,
            row.ended_at
        ],
    )?;
    Ok(row)
}

/// Sets a run's status: an ending status (Done, Error, Gone) stamps `ended_at` and
/// resolves its open request; any other status reopens it.
pub fn set_status(
    conn: &Connection,
    id: &str,
    status: AgentRunStatus,
) -> rusqlite::Result<Option<AgentRunRow>> {
    let now = now_ms();
    conn.execute(
        "UPDATE agent_runs SET status = ?1, updated_at = ?2,
             ended_at = CASE WHEN ?3 THEN coalesce(ended_at, ?2) ELSE NULL END
         WHERE id = ?4",
        params![status.as_str(), now, status.ends_run(), id],
    )?;
    if status.ends_run() {
        resolve_open_request(conn, id, "ended")?;
    }
    find(conn, id)
}

/// Ends every open run on a machine with `status`; returns the runs it ended.
pub fn end_open_for_machine(
    conn: &Connection,
    machine_id: &str,
    status: AgentRunStatus,
) -> rusqlite::Result<Vec<AgentRunRow>> {
    let mut stmt =
        conn.prepare("SELECT id FROM agent_runs WHERE machine_id = ?1 AND ended_at IS NULL")?;
    let ids = stmt
        .query_map(params![machine_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ended = Vec::new();
    for id in ids {
        if let Some(row) = set_status(conn, &id, status)? {
            ended.push(row);
        }
    }
    Ok(ended)
}

/// Runs on the user's machines, newest first: open ones, and those that ended at or
/// after `ended_since` (ms). `machine_id` narrows it to one machine.
pub fn list_for_user(
    conn: &Connection,
    user_id: &str,
    ended_since: i64,
    machine_id: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<AgentRunRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM agent_runs r JOIN machines m ON m.id = r.machine_id
         WHERE m.user_id = ?1 AND (r.ended_at IS NULL OR r.ended_at >= ?2)
           AND (?3 IS NULL OR r.machine_id = ?3)
         ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?4",
        COLUMNS
            .split(", ")
            .map(|c| format!("r.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))?;
    let rows = stmt.query_map(params![user_id, ended_since, machine_id, limit], map_row)?;
    rows.collect()
}

/// The run, if it's on one of the user's machines.
pub fn find_for_user(
    conn: &Connection,
    id: &str,
    user_id: &str,
) -> rusqlite::Result<Option<AgentRunRow>> {
    let row = find(conn, id)?;
    let Some(row) = row else { return Ok(None) };
    let owner: Option<String> = conn
        .query_row(
            "SELECT user_id FROM machines WHERE id = ?1",
            params![row.machine_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok((owner.as_deref() == Some(user_id)).then_some(row))
}

pub fn open_request(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<AgentRunRequest>> {
    conn.query_row(
        "SELECT id, kind, prompt, options, source, created_at FROM agent_run_requests
         WHERE run_id = ?1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1",
        params![run_id],
        |row| {
            let options: String = row.get(3)?;
            Ok(AgentRunRequest {
                id: row.get(0)?,
                kind: AgentRequestKind::from_name(&row.get::<_, String>(1)?),
                prompt: row.get(2)?,
                options: serde_json::from_str::<Vec<AgentQuestionOption>>(&options)
                    .unwrap_or_default(),
                source: row.get(4)?,
                created_at_ms: row.get(5)?,
            })
        },
    )
    .optional()
}

/// Opens a request on a run, superseding one still open.
pub fn insert_request(
    conn: &Connection,
    run_id: &str,
    kind: AgentRequestKind,
    source: &str,
) -> rusqlite::Result<()> {
    resolve_open_request(conn, run_id, "superseded")?;
    conn.execute(
        "INSERT INTO agent_run_requests (id, run_id, kind, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            run_id,
            kind.as_str(),
            source,
            now_ms()
        ],
    )?;
    Ok(())
}

/// Resolves the run's open request, if any; returns whether there was one.
pub fn resolve_open_request(
    conn: &Connection,
    run_id: &str,
    resolution: &str,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE agent_run_requests SET resolved_at = ?1, resolution = ?2
         WHERE run_id = ?3 AND resolved_at IS NULL",
        params![now_ms(), resolution, run_id],
    )?;
    Ok(changed > 0)
}

pub fn to_info(conn: &Connection, row: &AgentRunRow) -> rusqlite::Result<AgentRunInfo> {
    let request = if row.ended_at.is_none() {
        open_request(conn, &row.id)?
    } else {
        None
    };
    Ok(AgentRunInfo {
        id: row.id.clone(),
        machine_id: row.machine_id.clone(),
        terminal_id: row.terminal_id.clone(),
        agent: row.agent,
        cwd: row.cwd.clone(),
        status: row.status,
        request,
        started_at_ms: row.started_at,
        updated_at_ms: row.updated_at,
        ended_at_ms: row.ended_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_db, machines, users};

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        for (user, machine) in [("user-a", "machine-a"), ("user-b", "machine-b")] {
            users::create_user(&conn, user, "test", user, user, None, "admin").unwrap();
            machines::ensure_machine_for_user(
                &conn,
                machine,
                user,
                machine,
                Some("linux"),
                Some("/tmp"),
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn runs_open_end_reopen_and_stay_with_their_machine_owner() {
        let conn = test_db();
        let run = insert(
            &conn,
            "machine-a",
            "t1",
            RunAgent::Claude,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();
        assert_eq!(
            latest_for_terminal(&conn, "t1").unwrap().unwrap().id,
            run.id
        );

        insert_request(&conn, &run.id, AgentRequestKind::Approval, "screen").unwrap();
        let waiting = set_status(&conn, &run.id, AgentRunStatus::Waiting)
            .unwrap()
            .unwrap();
        let info = to_info(&conn, &waiting).unwrap();
        assert_eq!(
            info.request.as_ref().map(|r| r.kind),
            Some(AgentRequestKind::Approval)
        );
        assert_eq!(info.request.as_ref().and_then(|r| r.prompt.clone()), None);

        let gone = set_status(&conn, &run.id, AgentRunStatus::Gone)
            .unwrap()
            .unwrap();
        assert!(gone.ended_at.is_some());
        assert!(
            open_request(&conn, &run.id).unwrap().is_none(),
            "ending resolves the request"
        );
        let reopened = set_status(&conn, &run.id, AgentRunStatus::Working)
            .unwrap()
            .unwrap();
        assert_eq!(reopened.ended_at, None);

        assert_eq!(
            list_for_user(&conn, "user-a", 0, None, 50).unwrap().len(),
            1
        );
        assert!(list_for_user(&conn, "user-b", 0, None, 50)
            .unwrap()
            .is_empty());
        assert!(find_for_user(&conn, &run.id, "user-b").unwrap().is_none());
        assert!(find_for_user(&conn, &run.id, "user-a").unwrap().is_some());
    }

    #[test]
    fn a_machine_going_away_ends_only_its_open_runs() {
        let conn = test_db();
        let open = insert(
            &conn,
            "machine-a",
            "t1",
            RunAgent::Codex,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();
        let done = insert(
            &conn,
            "machine-a",
            "t2",
            RunAgent::Claude,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();
        set_status(&conn, &done.id, AgentRunStatus::Done).unwrap();
        let other = insert(
            &conn,
            "machine-b",
            "t3",
            RunAgent::Claude,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();

        let ended = end_open_for_machine(&conn, "machine-a", AgentRunStatus::Gone).unwrap();
        assert_eq!(
            ended.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            vec![open.id]
        );
        assert_eq!(
            find(&conn, &done.id).unwrap().unwrap().status,
            AgentRunStatus::Done
        );
        assert_eq!(find(&conn, &other.id).unwrap().unwrap().ended_at, None);
    }

    #[test]
    fn listing_skips_runs_that_ended_before_the_window() {
        let conn = test_db();
        let old = insert(
            &conn,
            "machine-a",
            "t1",
            RunAgent::Claude,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();
        set_status(&conn, &old.id, AgentRunStatus::Done).unwrap();
        conn.execute(
            "UPDATE agent_runs SET ended_at = 1 WHERE id = ?1",
            params![old.id],
        )
        .unwrap();
        let live = insert(
            &conn,
            "machine-a",
            "t2",
            RunAgent::Codex,
            "/w",
            AgentRunStatus::Working,
        )
        .unwrap();
        let listed = list_for_user(&conn, "user-a", 1000, None, 50).unwrap();
        assert_eq!(
            listed.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            vec![live.id]
        );
        assert!(list_for_user(&conn, "user-a", 0, Some("machine-b"), 50)
            .unwrap()
            .is_empty());
    }
}
