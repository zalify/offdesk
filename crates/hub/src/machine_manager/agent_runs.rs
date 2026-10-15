//! Agent runs from what nodes report (docs/plans/2026-10-14-agent-runs.md): a coding
//! agent in a terminal's foreground opens a run, a confirmation on its screen makes it
//! wait on a person, the process leaving ends it Done, and its terminal or machine going
//! away ends it Gone. A machine coming back with the same agent still in the terminal
//! carries the Gone run on rather than starting another. What the agent says itself
//! (its hooks, `offdesk run …`) refines that: working or idle, a request with its text,
//! progress, and its own notes (A2).

use offdesk_protocol::{
    AgentAnswer, AgentKey, AgentReportKind, AgentRequestKind, AgentRunInfo, AgentRunRequest,
    AgentRunStatus, AgentSignal, AgentStart, BrowserEvent, HubToMachine, InstalledAgent, RunAgent,
    StartAgentRun, TerminalAttention, TerminalInfo, TerminalOpener, AGENT_CHOOSE_CAPABILITY,
    AGENT_KEYS_CAPABILITY, AGENT_START_CAPABILITY, AGENT_START_DIRS_CAPABILITY, FOLDER_TRUST_PROMPT,
    FOLDER_TRUST_SOURCE, FOLDER_TRUST_YES,
};

use super::MachineManager;
use crate::db::agent_runs::{self, AgentRunRow};

/// Why an answer wasn't typed in.
#[derive(Debug, PartialEq, Eq)]
pub enum AnswerError {
    NotFound,
    /// The request moved on, was answered already, or the device lacks control.
    Conflict(&'static str),
    BadRequest(&'static str),
    /// The machine is offline or its node can't type answers yet.
    Unavailable(&'static str),
    Internal,
}

impl From<rusqlite::Error> for AnswerError {
    fn from(error: rusqlite::Error) -> Self {
        tracing::warn!("agent run answer: {}", error);
        AnswerError::Internal
    }
}

/// Why a run wasn't started.
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    BadRequest(String),
    /// The node can't start agents yet.
    Unavailable(String),
    /// The machine couldn't open the terminal (offline, a missing folder).
    Machine(String),
    Internal,
}

impl From<rusqlite::Error> for StartError {
    fn from(error: rusqlite::Error) -> Self {
        tracing::warn!("agent run start: {}", error);
        StartError::Internal
    }
}

/// How long a started run may stay Starting: after that its agent never showed up in
/// the terminal (not installed, not logged in, it exited at once) and the run is an Error.
pub const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// The size of a started agent's terminal until someone opens it.
const START_SIZE: (u16, u16) = (120, 36);

/// The keys that answer a request: an approval's yes is the menu's first option
/// (Claude and Codex both put "Yes" there) and no is Escape (their "cancel"); a
/// question's option is its number; words are typed and sent with Enter. Claude Code's
/// folder trust prompt is chosen by its label instead.
pub fn keys_for(
    request: &AgentRunRequest,
    answer: &AgentAnswer,
) -> Result<Vec<AgentKey>, AnswerError> {
    let text = answer
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let typed = |text: &str| {
        let key = AgentKey::Text(text.to_string());
        if key.is_allowed() {
            Ok(vec![key, AgentKey::Enter])
        } else {
            Err(AnswerError::BadRequest(
                "Answer in one line of at most 2000 characters",
            ))
        }
    };
    match request.kind {
        // Claude Code's folder trust prompt has no numbers, and its highlight starts on
        // "No, exit": the node moves it to the yes before Enter
        AgentRequestKind::Approval if request.source == FOLDER_TRUST_SOURCE => match answer.approve {
            Some(true) => Ok(vec![AgentKey::Choose(FOLDER_TRUST_YES.to_string())]),
            Some(false) => Ok(vec![AgentKey::Escape]),
            None => Err(AnswerError::BadRequest("Approve (true) or decline (false)")),
        },
        AgentRequestKind::Approval => match answer.approve {
            Some(true) => Ok(vec![AgentKey::Digit(1)]),
            Some(false) => Ok(vec![AgentKey::Escape]),
            None => Err(AnswerError::BadRequest("Approve (true) or decline (false)")),
        },
        AgentRequestKind::Question => match (&answer.option_id, text) {
            (Some(option_id), _) => {
                let index = request
                    .options
                    .iter()
                    .position(|option| &option.id == option_id)
                    .ok_or(AnswerError::BadRequest("No such option"))?;
                if index >= 9 {
                    return Err(AnswerError::BadRequest(
                        "Only the first nine options can be picked from here",
                    ));
                }
                Ok(vec![AgentKey::Digit(index as u8 + 1)])
            }
            (None, Some(text)) => typed(text),
            (None, None) => Err(AnswerError::BadRequest("Pick an option or write an answer")),
        },
        _ => match text {
            Some(text) => typed(text),
            None => Err(AnswerError::BadRequest("Write an answer")),
        },
    }
}

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
                // A run someone started: its agent showed up
                (Some(run), Some(agent))
                    if run.agent == agent && run.status == AgentRunStatus::Starting =>
                {
                    changed.extend(begin(&db, &run.id, attention)?);
                }
                // Still starting: the shell runs before the agent does (a start that
                // never comes is ended by `expire_start`)
                (Some(run), None) if run.status == AgentRunStatus::Starting => {}
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

    /// The agent in a terminal said something about its run, through its hooks or its own
    /// report. A run opens for it if none is open (hooks often beat the 5-second poll).
    pub(super) async fn on_agent_signal(
        &self,
        machine_id: &str,
        terminal_id: &str,
        agent: Option<RunAgent>,
        source: &str,
        signal: AgentSignal,
    ) {
        let (user_id, cwd) = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                return;
            };
            let Some(terminal) = conn.terminals.get(terminal_id) else {
                return;
            };
            (conn.user_id.clone(), terminal.cwd.clone())
        };
        let Ok(db) = self.db.get() else { return };
        let result = (|| -> rusqlite::Result<Vec<AgentRunRow>> {
            let open = agent_runs::latest_for_terminal(&db, terminal_id)?
                .filter(|run| run.ended_at.is_none());
            let (run, opened) = match open {
                Some(run) => (run, false),
                // Nothing to open a run for: an unknown signal, or a finish with no work open
                None if matches!(
                    signal,
                    AgentSignal::Other
                        | AgentSignal::Report {
                            kind: AgentReportKind::Finished,
                            ..
                        }
                ) =>
                {
                    return Ok(Vec::new())
                }
                None => {
                    let run = agent_runs::insert(
                        &db,
                        machine_id,
                        terminal_id,
                        agent.unwrap_or(RunAgent::Other),
                        &cwd,
                        AgentRunStatus::Working,
                    )?;
                    (run, true)
                }
            };
            let status_to = |status: AgentRunStatus| -> rusqlite::Result<Option<AgentRunRow>> {
                agent_runs::insert_event(
                    &db,
                    &run.id,
                    "status",
                    &serde_json::json!({ "status": status, "source": source }),
                )?;
                agent_runs::set_status(&db, &run.id, status)
            };
            let changed = match signal {
                AgentSignal::Working | AgentSignal::Idle => {
                    let status = if signal == AgentSignal::Working {
                        AgentRunStatus::Working
                    } else {
                        AgentRunStatus::Idle
                    };
                    let answered = agent_runs::resolve_open_request(&db, &run.id, "answered")?;
                    if answered || run.status != status {
                        status_to(status)?
                    } else {
                        None
                    }
                }
                AgentSignal::Waiting {
                    request,
                    prompt,
                    options,
                } => {
                    agent_runs::insert_request(
                        &db,
                        &run.id,
                        request,
                        prompt.as_deref(),
                        &options,
                        source,
                    )?;
                    agent_runs::insert_event(
                        &db,
                        &run.id,
                        "request",
                        &serde_json::json!({ "request": request, "prompt": prompt, "options": options, "source": source }),
                    )?;
                    agent_runs::set_status(&db, &run.id, AgentRunStatus::Waiting)?
                }
                AgentSignal::Progress(progress) => {
                    if run.progress.as_ref() != Some(&progress) {
                        agent_runs::set_progress(&db, &run.id, &progress)?
                    } else {
                        None
                    }
                }
                AgentSignal::Report { kind, text, link } => {
                    agent_runs::insert_event(
                        &db,
                        &run.id,
                        "report",
                        &serde_json::json!({ "kind": kind, "text": agent_runs::clip(&text), "link": link, "source": source }),
                    )?;
                    let reported =
                        agent_runs::set_report(&db, &run.id, kind, &text, link.as_deref())?;
                    match kind {
                        // It stopped and needs help: it waits for instructions
                        AgentReportKind::Blocked => {
                            agent_runs::resolve_open_request(&db, &run.id, "blocked")?;
                            status_to(AgentRunStatus::Idle)?
                        }
                        AgentReportKind::Finished => status_to(AgentRunStatus::Done)?,
                        _ => reported,
                    }
                }
                AgentSignal::Other => None,
            };
            Ok(match (changed, opened) {
                (Some(row), _) => vec![row],
                (None, true) => agent_runs::find(&db, &run.id)?.into_iter().collect(),
                (None, false) => Vec::new(),
            })
        })();
        self.announce_runs(user_id, &db, result, terminal_id);
    }

    /// A person answers a run's open request: the answer is typed into its terminal by
    /// the node. The request stays open until the agent's signals show it moved on, but
    /// a second answer is refused so nothing is typed twice.
    pub async fn answer_agent_run(
        &self,
        user_id: &str,
        run_id: &str,
        answer: AgentAnswer,
    ) -> Result<AgentRunInfo, AnswerError> {
        let (run, request) = {
            let db = self.db.get().map_err(|_| AnswerError::Internal)?;
            let run =
                agent_runs::find_for_user(&db, run_id, user_id)?.ok_or(AnswerError::NotFound)?;
            if run.ended_at.is_some() {
                return Err(AnswerError::Conflict("This agent run has ended"));
            }
            let request = agent_runs::open_request(&db, &run.id)?
                .filter(|request| request.id == answer.request_id)
                .ok_or(AnswerError::Conflict(
                    "This request isn't waiting for an answer any more",
                ))?;
            if request.answer_sent_at_ms.is_some() {
                return Err(AnswerError::Conflict(
                    "An answer was already sent; check the terminal",
                ));
            }
            (run, request)
        };
        let terminal_id = run.terminal_id.clone().ok_or(AnswerError::Conflict(
            "This run has no terminal to answer in",
        ))?;
        let keys = keys_for(&request, &answer)?;
        if !self.user_can_access_machine(user_id, &run.machine_id).await {
            return Err(AnswerError::Unavailable("The machine is offline"));
        }
        let choosing = keys.iter().any(|key| matches!(key, AgentKey::Choose(_)));
        if !self
            .machine_supports(&run.machine_id, AGENT_KEYS_CAPABILITY)
            .await
            || (choosing && !self.machine_supports(&run.machine_id, AGENT_CHOOSE_CAPABILITY).await)
        {
            return Err(AnswerError::Unavailable(
                "Update Offdesk on that machine to answer from here",
            ));
        }
        let device = answer
            .device_id
            .as_deref()
            .filter(|device| !device.is_empty());
        if device.is_none() || self.get_controller(user_id, &run.machine_id).as_deref() != device {
            return Err(AnswerError::Conflict("Take control of the machine first"));
        }

        let summary = serde_json::json!({ "approve": answer.approve, "option_id": answer.option_id, "text": answer.text, "device_id": device });
        let db = self.db.get().map_err(|_| AnswerError::Internal)?;
        if !agent_runs::mark_answer_sent(&db, &request.id, &summary)? {
            return Err(AnswerError::Conflict(
                "An answer was already sent; check the terminal",
            ));
        }
        if self
            .send_to_machine(
                &run.machine_id,
                HubToMachine::SendAgentKeys { terminal_id, keys },
            )
            .await
            .is_err()
        {
            db.execute(
                "UPDATE agent_run_requests SET answered_at = NULL, answer = NULL WHERE id = ?1",
                rusqlite::params![request.id],
            )?;
            return Err(AnswerError::Unavailable("The machine is offline"));
        }
        agent_runs::insert_event(
            &db,
            &run.id,
            "answer",
            &serde_json::json!({ "request_id": request.id, "answer": summary }),
        )?;
        // Declining (Escape) cancels the call and ends the agent's turn, and nothing says
        // so: Claude Code fires no hook when it's interrupted (seen in a real session). The
        // request is over and the run waits for its next instruction
        if request.kind == AgentRequestKind::Approval && answer.approve == Some(false) {
            agent_runs::resolve_open_request(&db, &run.id, "declined")?;
            agent_runs::insert_event(
                &db,
                &run.id,
                "status",
                &serde_json::json!({ "status": AgentRunStatus::Idle, "source": "answer" }),
            )?;
            agent_runs::set_status(&db, &run.id, AgentRunStatus::Idle)?;
        }
        let row = agent_runs::find(&db, &run.id)?.ok_or(AnswerError::NotFound)?;
        let info = agent_runs::to_info(&db, &row)?;
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentRunUpdated { run: info.clone() },
        );
        Ok(info)
    }

    /// Starts a coding agent in a new terminal: the node builds its command from `start`
    /// (the prompt is one argument, never shell syntax) and the run waits in Starting
    /// until the agent shows up there. The caller has checked the machine and control.
    pub async fn start_agent_run(
        &self,
        user_id: &str,
        start: StartAgentRun,
        opened_by: Option<TerminalOpener>,
        allowed_dirs: Option<Vec<String>>,
    ) -> Result<(AgentRunInfo, TerminalInfo), StartError> {
        let bad = |reason: &str| StartError::BadRequest(reason.to_string());
        let cwd = start.cwd.trim();
        if cwd.is_empty() {
            return Err(bad("Choose the folder to start in"));
        }
        let label = AgentStart::normalize_label(start.label.as_deref().unwrap_or("")).map_err(bad)?;
        let agent_start = AgentStart {
            run_id: uuid::Uuid::new_v4().to_string(),
            agent: start.agent,
            prompt: AgentStart::normalize_prompt(start.prompt.as_deref().unwrap_or("")).map_err(bad)?,
            permission_mode: start.permission_mode,
            external_ref: AgentStart::normalize_label(start.external_ref.as_deref().unwrap_or(""))
                .map_err(bad)?,
            allowed_dirs,
        };
        agent_start.validate().map_err(bad)?;
        // Only a node that checks real paths can keep a token inside its folders
        if agent_start.allowed_dirs.is_some()
            && !self
                .machine_supports(&start.machine_id, AGENT_START_DIRS_CAPABILITY)
                .await
        {
            return Err(StartError::Unavailable(
                "Update Offdesk on that machine to start agents with this token".to_string(),
            ));
        }
        if !self
            .machine_supports(&start.machine_id, AGENT_START_CAPABILITY)
            .await
        {
            return Err(StartError::Unavailable(
                "Update Offdesk on that machine to start agents from here".to_string(),
            ));
        }

        let summary = serde_json::json!({
            "agent": agent_start.agent,
            "permission_mode": agent_start.permission_mode,
            "label": label,
            "external_ref": agent_start.external_ref,
            "prompt_chars": agent_start.prompt.as_deref().map_or(0, |p| p.chars().count()),
        });
        let (run_id, agent, external_ref) = (
            agent_start.run_id.clone(),
            agent_start.agent,
            agent_start.external_ref.clone(),
        );
        let terminal = self
            .create_terminal_with(
                &start.machine_id,
                cwd,
                START_SIZE.0,
                START_SIZE.1,
                None,
                opened_by,
                Some(agent_start),
            )
            .await
            .map_err(StartError::Machine)?;

        let db = self.db.get().map_err(|_| StartError::Internal)?;
        // Its hooks may have beaten this here and opened a run already: that one it is
        let row = match agent_runs::latest_for_terminal(&db, &terminal.id)?
            .filter(|run| run.ended_at.is_none())
        {
            Some(run) => {
                db.execute(
                    "UPDATE agent_runs SET label = ?1, external_ref = ?2 WHERE id = ?3",
                    rusqlite::params![label, external_ref, run.id],
                )?;
                agent_runs::find(&db, &run.id)?.ok_or(StartError::Internal)?
            }
            None => agent_runs::insert_started(
                &db,
                &run_id,
                &start.machine_id,
                &terminal.id,
                agent,
                &terminal.cwd,
                label.as_deref(),
                external_ref.as_deref(),
            )?,
        };
        agent_runs::insert_event(&db, &row.id, "start", &summary)?;
        let info = agent_runs::to_info(&db, &row)?;
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentRunUpdated { run: info.clone() },
        );
        Ok((info, terminal))
    }

    /// A started run whose agent never showed up in `START_TIMEOUT` is an Error.
    pub fn expire_start(&self, user_id: &str, run_id: &str) {
        let Ok(db) = self.db.get() else { return };
        let result = (|| -> rusqlite::Result<Vec<AgentRunRow>> {
            match agent_runs::find(&db, run_id)? {
                Some(run) if run.status == AgentRunStatus::Starting => {
                    agent_runs::insert_event(
                        &db,
                        run_id,
                        "status",
                        &serde_json::json!({ "status": AgentRunStatus::Error, "source": "start", "reason": "The agent didn't start; see its terminal" }),
                    )?;
                    Ok(agent_runs::set_status(&db, run_id, AgentRunStatus::Error)?
                        .into_iter()
                        .collect())
                }
                _ => Ok(Vec::new()),
            }
        })();
        self.announce_runs(Some(user_id.to_string()), &db, result, run_id);
    }

    /// The coding agent CLIs a connected machine reported, or None while it's offline.
    pub async fn installed_agents(&self, machine_id: &str) -> Option<Vec<InstalledAgent>> {
        self.machines
            .lock()
            .await
            .get(machine_id)
            .map(|conn| conn.installed_agents.clone())
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
    match attention {
        Some(TerminalAttention::Confirmation) => {
            agent_runs::insert_request(db, run_id, AgentRequestKind::Approval, None, &[], "screen")?;
            agent_runs::set_status(db, run_id, AgentRunStatus::Waiting)
        }
        // Claude Code's folder trust prompt: an approval, said in Offdesk's own words
        Some(TerminalAttention::FolderTrust) => {
            agent_runs::insert_request(
                db,
                run_id,
                AgentRequestKind::Approval,
                Some(FOLDER_TRUST_PROMPT),
                &[],
                FOLDER_TRUST_SOURCE,
            )?;
            agent_runs::set_status(db, run_id, AgentRunStatus::Waiting)
        }
        None => agent_runs::set_status(db, run_id, AgentRunStatus::Working),
    }
}
