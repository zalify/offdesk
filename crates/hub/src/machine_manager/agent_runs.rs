//! Agent runs from what nodes report (docs/plans/2026-10-14-agent-runs.md, phase A1):
//! a coding agent in a terminal's foreground opens a run, a confirmation on its screen
//! makes it wait on a person, the process leaving ends it Done, and its terminal or
//! machine going away ends it Gone. A machine coming back with the same agent still in
//! the terminal carries the Gone run on rather than starting another.

use offdesk_protocol::{
    AgentRequestKind, AgentRunStatus, BrowserEvent, RunAgent, TerminalAttention,
};

use super::MachineManager;
use crate::db::agent_runs::{self, AgentRunRow};

/// How long ended runs stay in the bootstrap snapshot.
pub(super) const RECENT_RUNS_MS: i64 = 24 * 3600 * 1000;
const SNAPSHOT_RUN_LIMIT: i64 = 200;

impl MachineManager {
    /// A node reported which coding agent is in a terminal's foreground, if any.
    pub(super) async fn on_terminal_agent(
        &self,
        machine_id: &str,
        terminal_id: &str,
        agent: Option<RunAgent>,
    ) {
        let (user_id, cwd, attention) = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                return;
            };
            let Some(terminal) = conn.terminals.get(terminal_id) else {
                return;
            };
            (
                conn.user_id.clone(),
                terminal.cwd.clone(),
                terminal.attention,
            )
        };
        let Ok(db) = self.db.get() else { return };
        let result = (|| -> rusqlite::Result<Vec<AgentRunRow>> {
            let latest = agent_runs::latest_for_terminal(&db, terminal_id)?;
            let mut changed = Vec::new();
            match (latest, agent) {
                // The same agent still running: nothing new
                (Some(run), Some(agent)) if run.agent == agent && run.ended_at.is_none() => {}
                // Its machine came back with the same agent in the terminal: carry the run on
                (Some(run), Some(agent))
                    if run.agent == agent && run.status == AgentRunStatus::Gone =>
                {
                    changed.extend(begin(&db, &run.id, attention)?);
                }
                (latest, Some(agent)) => {
                    if let Some(open) = latest.filter(|run| run.ended_at.is_none()) {
                        changed.extend(agent_runs::set_status(
                            &db,
                            &open.id,
                            AgentRunStatus::Done,
                        )?);
                    }
                    let run = agent_runs::insert(
                        &db,
                        machine_id,
                        terminal_id,
                        agent,
                        &cwd,
                        AgentRunStatus::Working,
                    )?;
                    changed.extend(begin(&db, &run.id, attention)?);
                }
                // The agent left the foreground: it exited (the exit code isn't known yet)
                (Some(run), None) if run.ended_at.is_none() => {
                    changed.extend(agent_runs::set_status(&db, &run.id, AgentRunStatus::Done)?);
                }
                _ => {}
            }
            Ok(changed)
        })();
        self.announce_runs(user_id, &db, result, terminal_id);
    }

    /// A terminal's attention changed: its open run waits on a person while the screen
    /// shows a confirmation, and works again once it's gone.
    pub(super) fn on_run_attention(
        &self,
        user_id: Option<String>,
        terminal_id: &str,
        attention: Option<TerminalAttention>,
    ) {
        let Ok(db) = self.db.get() else { return };
        let result = (|| -> rusqlite::Result<Vec<AgentRunRow>> {
            let Some(run) = agent_runs::latest_for_terminal(&db, terminal_id)?
                .filter(|run| run.ended_at.is_none())
            else {
                return Ok(Vec::new());
            };
            match (attention, run.status) {
                (Some(_), status) if status != AgentRunStatus::Waiting => {
                    Ok(begin(&db, &run.id, attention)?.into_iter().collect())
                }
                (None, AgentRunStatus::Waiting) => {
                    agent_runs::resolve_open_request(&db, &run.id, "cleared")?;
                    Ok(
                        agent_runs::set_status(&db, &run.id, AgentRunStatus::Working)?
                            .into_iter()
                            .collect(),
                    )
                }
                _ => Ok(Vec::new()),
            }
        })();
        self.announce_runs(user_id, &db, result, terminal_id);
    }

    /// A terminal closed (or its machine says it no longer exists): its open run is Gone.
    pub(super) fn end_terminal_runs(&self, user_id: Option<String>, terminal_id: &str) {
        let Ok(db) = self.db.get() else { return };
        let result = (|| -> rusqlite::Result<Vec<AgentRunRow>> {
            match agent_runs::latest_for_terminal(&db, terminal_id)?
                .filter(|run| run.ended_at.is_none())
            {
                Some(run) => Ok(agent_runs::set_status(&db, &run.id, AgentRunStatus::Gone)?
                    .into_iter()
                    .collect()),
                None => Ok(Vec::new()),
            }
        })();
        self.announce_runs(user_id, &db, result, terminal_id);
    }

    /// A machine disconnected: its open runs are Gone until it comes back.
    pub(super) fn end_machine_runs(&self, user_id: Option<String>, machine_id: &str) {
        let Ok(db) = self.db.get() else { return };
        let result = agent_runs::end_open_for_machine(&db, machine_id, AgentRunStatus::Gone);
        self.announce_runs(user_id, &db, result, machine_id);
    }

    /// Open runs and those ended in the last day, for the bootstrap snapshot.
    pub(super) fn runs_for_snapshot(&self, user_id: &str) -> Vec<offdesk_protocol::AgentRunInfo> {
        let Ok(db) = self.db.get() else {
            return Vec::new();
        };
        let since = crate::db::now_ms() - RECENT_RUNS_MS;
        agent_runs::list_for_user(&db, user_id, since, None, SNAPSHOT_RUN_LIMIT)
            .and_then(|rows| {
                rows.iter()
                    .map(|row| agent_runs::to_info(&db, row))
                    .collect()
            })
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to list agent runs: {}", e);
                Vec::new()
            })
    }

    fn announce_runs(
        &self,
        user_id: Option<String>,
        db: &rusqlite::Connection,
        result: rusqlite::Result<Vec<AgentRunRow>>,
        subject: &str,
    ) {
        match result.and_then(|rows| {
            rows.iter()
                .map(|row| agent_runs::to_info(db, row))
                .collect::<rusqlite::Result<Vec<_>>>()
        }) {
            Ok(runs) => {
                for run in runs {
                    self.send_event(user_id.clone(), BrowserEvent::AgentRunUpdated { run });
                }
            }
            Err(e) => tracing::warn!("Failed to update agent runs of {}: {}", subject, e),
        }
    }
}

/// (Re)starts a run: Waiting with a request when the screen shows a confirmation,
/// otherwise Working.
fn begin(
    db: &rusqlite::Connection,
    run_id: &str,
    attention: Option<TerminalAttention>,
) -> rusqlite::Result<Option<AgentRunRow>> {
    if attention.is_some() {
        agent_runs::insert_request(db, run_id, AgentRequestKind::Approval, "screen")?;
        agent_runs::set_status(db, run_id, AgentRunStatus::Waiting)
    } else {
        agent_runs::set_status(db, run_id, AgentRunStatus::Working)
    }
}
