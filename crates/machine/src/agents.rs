//! Agents on the Node: which agent runs in each terminal, with Claude's own
//! status and task list, and the startup command that hands a prompt to a
//! new agent without turning the prompt into shell syntax.
use crate::codex_title::{find_named_descendants, Process};
use crate::pty::PaneInfo;
use offdesk_protocol::agents::{
    AgentActivity, AgentTask, AgentTaskStatus, AgentTasks, StartupPrompt, TerminalAgent,
    TerminalAgentKind,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Native Claude builds can name their process `claude.exe`, even on macOS.
const CLAUDE_PROCESS_NAMES: [&str; 2] = ["claude", "claude.exe"];
const MAX_TASKS: usize = 40;

/// What the Node knows about the agent in one pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneAgent {
    pub kind: TerminalAgentKind,
    pub session_id: Option<String>,
    /// Claude only, from its session file.
    pub activity: Option<AgentActivity>,
    /// Claude only: its task list, while it has one.
    pub tasks: Option<AgentTasks>,
}

impl PaneAgent {
    pub fn report(&self) -> TerminalAgent {
        TerminalAgent {
            kind: self.kind,
            session_id: self.session_id.clone(),
            activity: self.activity,
            tasks: self.tasks.clone(),
        }
    }
}

/// Identify the agent of every pane that could run one. One process snapshot
/// and one Claude session scan per call; panes running only a shell cost
/// nothing.
pub fn resolve_agents(panes: &HashMap<String, PaneInfo>) -> HashMap<String, PaneAgent> {
    if !panes
        .values()
        .any(|pane| crate::terminal_attention::supports_command(pane.current_command.as_deref()))
    {
        return HashMap::new();
    }
    let processes = crate::codex_title::snapshot_processes();
    let claude_files = crate::revive::scan_claude_sessions();
    let claude_config = claude_config_dir();
    panes
        .iter()
        .filter_map(|(id, pane)| {
            pane_agent(
                id,
                pane,
                &processes,
                &claude_files,
                &claude_config,
                crate::codex_title::open_files,
            )
            .map(|agent| (id.clone(), agent))
        })
        .collect()
}

fn pane_agent(
    terminal_id: &str,
    pane: &PaneInfo,
    processes: &[Process],
    claude_files: &[crate::revive::ClaudeSessionFile],
    claude_config: &Path,
    open_files: impl Fn(u32) -> Vec<PathBuf>,
) -> Option<PaneAgent> {
    if !crate::terminal_attention::supports_command(pane.current_command.as_deref()) {
        return None;
    }
    let root = pane.pid?;
    let claude_pids: Vec<u32> = CLAUDE_PROCESS_NAMES
        .iter()
        .flat_map(|name| find_named_descendants(processes, root, name))
        .collect();
    if !claude_pids.is_empty() {
        let tmux_name = crate::pty::tmux_session_name(terminal_id);
        let session_id =
            crate::revive::match_claude_session(claude_files, &tmux_name, root, processes)
                .map(|(session_id, _)| session_id)
                .or_else(|| match claude_pids.as_slice() {
                    // `claude attach <id>` shows a background session; its
                    // live session id is in the job's state file.
                    [pid] => process_args(*pid)
                        .and_then(|args| attach_job_id(&args))
                        .and_then(|job| attached_session_id(claude_config, &job)),
                    _ => None,
                })
                // Session ids become paths below; only UUIDs qualify.
                .filter(|id| uuid::Uuid::parse_str(id).is_ok());
        let activity = session_id
            .as_deref()
            .and_then(|id| claude_activity(claude_config, id));
        let tasks = session_id.as_deref().and_then(|id| {
            AgentTasks::summarize(&claude_tasks(&claude_config.join("tasks").join(id)))
        });
        return Some(PaneAgent {
            kind: TerminalAgentKind::Claude,
            session_id,
            activity,
            tasks,
        });
    }
    if find_named_descendants(processes, root, "codex").is_empty() {
        return None;
    }
    let rollout = crate::codex_title::rollout_for_pane(pane, processes, open_files);
    Some(PaneAgent {
        kind: TerminalAgentKind::Codex,
        session_id: rollout.map(|(_, thread, _)| thread),
        activity: None,
        tasks: None,
    })
}

/// Claude's own status for a live session, from `sessions/<pid>.json`
/// (interactive and background sessions both write one).
fn claude_activity(config: &Path, session_id: &str) -> Option<AgentActivity> {
    std::fs::read_dir(config.join("sessions"))
        .ok()?
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .find_map(|entry| {
            let value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(entry.path()).ok()?).ok()?;
            if value.get("sessionId")?.as_str()? != session_id {
                return None;
            }
            match value.get("status")?.as_str()? {
                "busy" => Some(AgentActivity::Busy),
                "idle" => Some(AgentActivity::Idle),
                "waiting" => Some(AgentActivity::Waiting),
                _ => None,
            }
        })
}

/// The full command line of one process (`ps` works on macOS and Linux).
fn process_args(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let args = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!args.is_empty()).then_some(args)
}

/// The job id in `claude … attach <id>`: short lowercase hex only.
fn attach_job_id(args: &str) -> Option<String> {
    let mut tokens = args.split_whitespace();
    tokens.find(|token| *token == "attach")?;
    let id = tokens.next()?;
    (id.len() >= 6 && id.len() <= 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| id.to_string())
}

/// A background job's current session: `resumeSessionId` once the job has
/// been resumed (the original `sessionId` then goes stale), else `sessionId`.
fn attached_session_id(config: &Path, job: &str) -> Option<String> {
    let state = std::fs::read_to_string(config.join("jobs").join(job).join("state.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&state).ok()?;
    ["resumeSessionId", "sessionId"].iter().find_map(|key| {
        let id = value.get(key)?.as_str()?;
        uuid::Uuid::parse_str(id).ok().map(|_| id.to_string())
    })
}

fn truncate_chars(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn claude_config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => dirs::home_dir().unwrap_or_default().join(".claude"),
    }
}

fn claude_tasks(dir: &Path) -> Vec<AgentTask> {
    let mut tasks: Vec<(u64, AgentTask)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
            // Claude hides its own bookkeeping tasks; so do we.
            if value
                .get("metadata")
                .and_then(|m| m.get("_internal"))
                .is_some_and(|v| !v.is_null() && v != &serde_json::Value::Bool(false))
            {
                return None;
            }
            let order = value.get("id")?.as_str()?.parse::<u64>().ok()?;
            let subject = value.get("subject")?.as_str()?.trim();
            let status = match value.get("status")?.as_str()? {
                "pending" => AgentTaskStatus::Pending,
                "in_progress" => AgentTaskStatus::InProgress,
                "completed" => AgentTaskStatus::Completed,
                _ => return None,
            };
            (!subject.is_empty()).then(|| {
                (
                    order,
                    AgentTask {
                        subject: truncate_chars(subject, 200),
                        status,
                    },
                )
            })
        })
        .collect();
    tasks.sort_by_key(|(order, _)| *order);
    tasks
        .into_iter()
        .take(MAX_TASKS)
        .map(|(_, task)| task)
        .collect()
}

// ── Startup prompt ─────────────────────────────────────────────────

/// Write the prompt to a private file and return the command line that
/// starts the agent with it. The prompt is read by `$(cat …)` inside double
/// quotes, so its text is never parsed as shell syntax.
pub fn startup_command(terminal_id: &str, prompt: &StartupPrompt) -> Result<String, String> {
    startup_command_in(
        &offdesk_protocol::config_dir().join("agent-prompts"),
        terminal_id,
        prompt,
    )
}

fn startup_command_in(
    dir: &Path,
    terminal_id: &str,
    prompt: &StartupPrompt,
) -> Result<String, String> {
    let prompt = StartupPrompt::normalized(prompt.agent, &prompt.text)?;
    uuid::Uuid::parse_str(terminal_id).map_err(|_| "Invalid terminal id".to_string())?;
    create_private_dir(dir).map_err(|e| format!("Could not prepare the prompt: {e}"))?;
    let path = dir.join(format!("{terminal_id}.md"));
    write_private_file(&path, prompt.text.as_bytes())
        .map_err(|e| format!("Could not save the prompt: {e}"))?;
    let quoted = crate::revive::shell_quote_token(&path.to_string_lossy())
        .ok_or_else(|| "The Offdesk config path cannot be quoted for the shell".to_string())?;
    Ok(format!("{} \"$(cat {quoted})\"", prompt.agent.command()))
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("offdesk-agents-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn process(pid: u32, parent: Option<u32>, name: &str) -> Process {
        Process {
            pid,
            parent,
            name: name.into(),
        }
    }

    fn pane(pid: u32, command: &str) -> PaneInfo {
        PaneInfo {
            pid: Some(pid),
            title: None,
            cwd: Some("/tmp/project".into()),
            current_command: Some(command.into()),
        }
    }

    #[test]
    fn agents_are_identified_from_the_process_tree() {
        let processes = vec![
            process(10, None, "zsh"),
            process(11, Some(10), "claude.exe"),
            process(20, None, "zsh"),
            process(21, Some(20), "node"),
            process(22, Some(21), "codex"),
            process(30, None, "zsh"),
            process(31, Some(30), "vim"),
        ];
        let id = "11111111-1111-4111-8111-111111111111";
        let session = "66666666-6666-4666-8666-666666666666";
        let config = temp_dir("agent-config");
        std::fs::create_dir_all(config.join("sessions")).unwrap();
        std::fs::write(
            config.join("sessions").join("11.json"),
            format!(r#"{{"pid":11,"sessionId":"{session}","status":"busy"}}"#),
        )
        .unwrap();
        let tasks = config.join("tasks").join(session);
        std::fs::create_dir_all(&tasks).unwrap();
        std::fs::write(tasks.join("1.json"), r#"{"id":"1","subject":"Backfill","description":"","status":"completed","blocks":[],"blockedBy":[]}"#).unwrap();
        std::fs::write(tasks.join("2.json"), r#"{"id":"2","subject":"Alert","description":"","status":"in_progress","blocks":[],"blockedBy":[]}"#).unwrap();
        let files = vec![crate::revive::ClaudeSessionFile {
            pid: 11,
            session_id: session.into(),
            tmux: format!("{}:@1.%1", crate::pty::tmux_session_name(id)),
        }];
        let claude = pane_agent(
            id,
            &pane(10, "claude.exe"),
            &processes,
            &files,
            &config,
            |_| Vec::new(),
        )
        .unwrap();
        assert_eq!(claude.kind, TerminalAgentKind::Claude);
        assert_eq!(claude.session_id.as_deref(), Some(session));
        assert_eq!(claude.activity, Some(AgentActivity::Busy));
        let summary = claude.tasks.clone().unwrap();
        assert_eq!((summary.done, summary.total), (1, 2));
        assert_eq!(summary.items[0].subject, "Alert", "open work comes first");
        let report = claude.report();
        assert_eq!(report.activity, Some(AgentActivity::Busy));
        assert_eq!(report.tasks, Some(summary));

        // A session id that is not a UUID never becomes a path.
        let odd = vec![crate::revive::ClaudeSessionFile {
            session_id: "../../etc".into(),
            ..files[0].clone()
        }];
        let unmatched = pane_agent(
            id,
            &pane(10, "claude.exe"),
            &processes,
            &odd,
            &config,
            |_| Vec::new(),
        )
        .unwrap();
        assert_eq!((unmatched.session_id, unmatched.tasks), (None, None));

        let rollout = PathBuf::from(
            "/home/u/.codex/sessions/2026/10/05/rollout-2026-10-05T10-00-00-0199b2a0-0000-7000-8000-000000000001.jsonl",
        );
        let codex = pane_agent("t2", &pane(20, "node"), &processes, &[], &config, |pid| {
            if pid == 22 {
                vec![rollout.clone()]
            } else {
                Vec::new()
            }
        })
        .unwrap();
        assert_eq!(codex.kind, TerminalAgentKind::Codex);
        assert_eq!(
            codex.session_id.as_deref(),
            Some("0199b2a0-0000-7000-8000-000000000001")
        );

        assert_eq!(
            pane_agent("t3", &pane(30, "vim"), &processes, &[], &config, |_| {
                Vec::new()
            }),
            None
        );
    }

    #[test]
    fn attached_background_sessions_resolve_through_their_job_state() {
        assert_eq!(
            attach_job_id("/usr/lib/node_modules/claude-code/bin/claude.exe attach 86b81834")
                .as_deref(),
            Some("86b81834")
        );
        assert_eq!(attach_job_id("claude --resume abc"), None);
        assert_eq!(attach_job_id("claude attach ../../etc"), None);

        let config = temp_dir("jobs");
        let job = config.join("jobs").join("86b81834");
        std::fs::create_dir_all(&job).unwrap();
        let original = "86b81834-0000-4000-8000-000000000000";
        let resumed = "0548066e-0000-4000-8000-000000000000";
        std::fs::write(
            job.join("state.json"),
            format!(
                r#"{{"sessionId":"{original}","resumeSessionId":"{resumed}","state":"working"}}"#
            ),
        )
        .unwrap();
        assert_eq!(
            attached_session_id(&config, "86b81834").as_deref(),
            Some(resumed)
        );
        std::fs::write(
            job.join("state.json"),
            format!(r#"{{"sessionId":"{original}"}}"#),
        )
        .unwrap();
        assert_eq!(
            attached_session_id(&config, "86b81834").as_deref(),
            Some(original)
        );
        assert_eq!(attached_session_id(&config, "missing"), None);
    }

    #[test]
    fn claude_task_lists_follow_their_ids_and_skip_internal_tasks() {
        let tasks = temp_dir("tasks");
        std::fs::write(tasks.join("2.json"), r#"{"id":"2","subject":"Add a stall alert","description":"","status":"pending","blocks":[],"blockedBy":[]}"#).unwrap();
        std::fs::write(tasks.join("1.json"), r#"{"id":"1","subject":"Backfill orders","description":"","status":"in_progress","blocks":[],"blockedBy":[]}"#).unwrap();
        std::fs::write(tasks.join("3.json"), r#"{"id":"3","subject":"internal","description":"","status":"pending","blocks":[],"blockedBy":[],"metadata":{"_internal":true}}"#).unwrap();
        std::fs::write(tasks.join(".highwatermark"), "3").unwrap();
        assert_eq!(
            claude_tasks(&tasks),
            vec![
                AgentTask {
                    subject: "Backfill orders".into(),
                    status: AgentTaskStatus::InProgress
                },
                AgentTask {
                    subject: "Add a stall alert".into(),
                    status: AgentTaskStatus::Pending
                },
            ]
        );
        assert!(claude_tasks(&tasks.join("missing")).is_empty());
    }

    #[test]
    fn startup_commands_read_a_private_prompt_file() {
        let dir = temp_dir("prompt").join("prompt dir");
        let id = "33333333-3333-4333-8333-333333333333";
        let prompt = StartupPrompt {
            agent: TerminalAgentKind::Codex,
            text: "Continue: it's \"quoted\" $(rm -rf ~) `x`\nline two".into(),
        };
        let command = startup_command_in(&dir, id, &prompt).unwrap();
        let path = dir.join(format!("{id}.md"));
        assert_eq!(command, format!("codex \"$(cat '{}')\"", path.display()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), prompt.text);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        // The shell reads the file verbatim: nothing in the prompt runs.
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(command.replacen("codex", "printf %s", 1))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), prompt.text);

        assert!(startup_command_in(&dir, "../x", &prompt).is_err());
        let dash = StartupPrompt {
            agent: TerminalAgentKind::Claude,
            text: "-p hi".into(),
        };
        assert!(startup_command_in(&dir, id, &dash).is_err());
    }
}
