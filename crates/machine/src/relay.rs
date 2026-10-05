//! Agent relay on the Node: which agent runs in each terminal, its
//! usage-limit notice, handoff briefs read from the agent's own session
//! files, and the startup command that hands a prompt to a new agent without
//! turning the prompt into shell syntax.
//!
//! Everything here is best effort and bounded: transcripts are read only at
//! their head and tail, git gets a short timeout, and anything unreadable
//! becomes a warning on the brief instead of an error.
use crate::codex_title::{find_named_descendants, Process};
use crate::pty::PaneInfo;
use offdesk_protocol::relay::{
    RelayAgent, RelayBrief, RelayGit, RelayTask, RelayTaskStatus, StartupPrompt, TerminalAgent,
};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Native Claude builds can name their process `claude.exe`, even on macOS.
const CLAUDE_PROCESS_NAMES: [&str; 2] = ["claude", "claude.exe"];
/// Only the bottom of the screen counts: a limit notice that has scrolled up
/// belongs to the past.
const USAGE_LIMIT_WINDOW: usize = 12;
const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_TITLE_CHARS: usize = 120;
const MAX_GOAL_CHARS: usize = 800;
const MAX_LATEST_CHARS: usize = 1500;
const MAX_TASKS: usize = 40;
const MAX_CHANGED_FILES: usize = 40;
const GIT_TIMEOUT: Duration = Duration::from_secs(3);

/// What the Node knows about the agent in one pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneAgent {
    pub kind: RelayAgent,
    pub session_id: Option<String>,
    /// Codex only: the open rollout file of its thread.
    pub rollout: Option<PathBuf>,
}

impl PaneAgent {
    pub fn report(&self, usage_limit: Option<String>) -> TerminalAgent {
        TerminalAgent {
            kind: self.kind,
            session_id: self.session_id.clone(),
            usage_limit,
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
    panes
        .iter()
        .filter_map(|(id, pane)| {
            pane_agent(
                id,
                pane,
                &processes,
                &claude_files,
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
                        .and_then(|job| attached_session_id(&claude_config_dir(), &job)),
                    _ => None,
                });
        return Some(PaneAgent {
            kind: RelayAgent::Claude,
            session_id,
            rollout: None,
        });
    }
    if find_named_descendants(processes, root, "codex").is_empty() {
        return None;
    }
    let rollout = crate::codex_title::rollout_for_pane(pane, processes, open_files);
    Some(PaneAgent {
        kind: RelayAgent::Codex,
        session_id: rollout.as_ref().map(|(_, thread, _)| thread.clone()),
        rollout: rollout.map(|(_, _, path)| path),
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

/// The agent's usage-limit line when it is near the bottom of the visible
/// screen. Claude: "Usage limit reached · resets 3pm" (and "5-hour limit
/// reached ∙ resets 3pm" in older builds). Codex: "You’ve hit your usage
/// limit". Context and fast-mode limits are not usage limits.
pub fn usage_limit_line(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines
        .iter()
        .rev()
        .take(USAGE_LIMIT_WINDOW)
        .find_map(|line| {
            let lower = line.to_lowercase().replace('’', "'");
            let usage = lower.contains("usage limit reached")
                || lower.contains("hit your usage limit")
                || (lower.contains("limit reached")
                    && lower.contains("reset")
                    && !lower.contains("fast limit")
                    && !lower.contains("context limit"));
            usage.then(|| clean_line(line))
        })
}

fn clean_line(line: &str) -> String {
    let start = line
        .char_indices()
        .find(|(_, c)| c.is_alphanumeric())
        .map(|(i, _)| i)
        .unwrap_or(0);
    truncate_chars(line[start..].trim(), 160)
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

// ── Briefs ─────────────────────────────────────────────────────────

/// Assemble a brief from the agent's own files and the working tree.
pub fn build_brief(pane: &PaneInfo, agent: &PaneAgent, usage_limit: Option<String>) -> RelayBrief {
    let cwd = pane.cwd.clone().unwrap_or_default();
    let mut brief = RelayBrief {
        agent: agent.kind,
        cwd: cwd.clone(),
        session_id: agent.session_id.clone(),
        title: None,
        goal: None,
        latest: None,
        tasks: Vec::new(),
        git: None,
        usage_limit,
        warnings: Vec::new(),
    };
    match agent.kind {
        RelayAgent::Claude => fill_claude(&mut brief, &claude_config_dir()),
        RelayAgent::Codex => fill_codex(&mut brief, agent.rollout.as_deref()),
    }
    if !cwd.is_empty() {
        brief.git = git_state(Path::new(&cwd));
    }
    brief
}

fn claude_config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => dirs::home_dir().unwrap_or_default().join(".claude"),
    }
}

fn fill_claude(brief: &mut RelayBrief, config: &Path) {
    let Some(session_id) = brief.session_id.clone() else {
        brief
            .warnings
            .push("Could not match this Claude session, so only git changes are included.".into());
        return;
    };
    match find_claude_transcript(config, &session_id) {
        Some(path) => {
            let (head, tail) = read_head_tail(&path);
            let head_facts = claude_head(&head);
            brief.title = head_facts.title;
            brief.goal = head_facts.goal;
            brief.latest = claude_latest(&tail);
            if brief.goal.is_none() {
                brief
                    .warnings
                    .push("The session's first request could not be read.".into());
            }
        }
        None => brief
            .warnings
            .push("The Claude session transcript was not found.".into()),
    }
    brief.tasks = claude_tasks(&config.join("tasks").join(&session_id));
}

fn find_claude_transcript(config: &Path, session_id: &str) -> Option<PathBuf> {
    // Session ids are UUIDs; anything else must not become a path.
    uuid::Uuid::parse_str(session_id).ok()?;
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(config.join("projects"))
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file))
        .find(|path| path.is_file())
}

/// The first `HEAD_BYTES` and the last `TAIL_BYTES` of a file, decoded
/// lossily. The tail drops its first, probably partial, line.
fn read_head_tail(path: &Path) -> (String, String) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (String::new(), String::new());
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = Vec::new();
    let _ = (&mut file).take(HEAD_BYTES).read_to_end(&mut head);
    let mut tail = Vec::new();
    if len > HEAD_BYTES {
        let start = len.saturating_sub(TAIL_BYTES).max(HEAD_BYTES);
        if file.seek(SeekFrom::Start(start)).is_ok() {
            let _ = file.read_to_end(&mut tail);
            if let Some(newline) = tail.iter().position(|b| *b == b'\n') {
                tail.drain(..=newline);
            }
        }
    } else {
        tail = head.clone();
    }
    (
        String::from_utf8_lossy(&head).into_owned(),
        String::from_utf8_lossy(&tail).into_owned(),
    )
}

#[derive(Default)]
struct HeadFacts {
    title: Option<String>,
    goal: Option<String>,
}

fn claude_head(text: &str) -> HeadFacts {
    let mut facts = HeadFacts::default();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => {
                if let Some(title) = value.get("customTitle").and_then(|t| t.as_str()) {
                    facts.title = Some(truncate_chars(title, MAX_TITLE_CHARS));
                }
            }
            Some("user") if facts.goal.is_none() => {
                if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
                    || value.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
                {
                    continue;
                }
                let text =
                    message_text(value.get("message").and_then(|m| m.get("content")), "text");
                if let Some(text) = text.filter(|t| is_user_request(t)) {
                    facts.goal = Some(truncate_chars(&text, MAX_GOAL_CHARS));
                }
            }
            _ => {}
        }
    }
    facts
}

fn claude_latest(text: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
        if value.get("type").and_then(|t| t.as_str()) != Some("assistant")
            || value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
        {
            return None;
        }
        message_text(value.get("message").and_then(|m| m.get("content")), "text")
            .map(|text| truncate_chars(&text, MAX_LATEST_CHARS))
    })
}

/// Text of a message whose content is a string or a list of typed blocks.
/// Tool calls and results are not prose and are skipped.
fn message_text(content: Option<&serde_json::Value>, block_type: &str) -> Option<String> {
    let text = match content? {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some(block_type))
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Injected wrappers (slash-command echoes, reminders, environment context)
/// start with a tag; a person's request does not.
fn is_user_request(text: &str) -> bool {
    let text = text.trim_start();
    !(text.starts_with('<') || text.starts_with("Caveat:") || text.starts_with("# AGENTS.md"))
}

fn claude_tasks(dir: &Path) -> Vec<RelayTask> {
    let mut tasks: Vec<(u64, RelayTask)> = std::fs::read_dir(dir)
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
                "pending" => RelayTaskStatus::Pending,
                "in_progress" => RelayTaskStatus::InProgress,
                "completed" => RelayTaskStatus::Completed,
                _ => return None,
            };
            (!subject.is_empty()).then(|| {
                (
                    order,
                    RelayTask {
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

fn fill_codex(brief: &mut RelayBrief, rollout: Option<&Path>) {
    let Some(rollout) = rollout else {
        brief
            .warnings
            .push("Could not match this Codex session, so only git changes are included.".into());
        return;
    };
    let (head, tail) = read_head_tail(rollout);
    brief.goal = codex_messages(&head, "user_message")
        .into_iter()
        .find(|text| is_user_request(text))
        .map(|text| truncate_chars(&text, MAX_GOAL_CHARS));
    brief.latest = codex_messages(&tail, "agent_message")
        .pop()
        .map(|text| truncate_chars(&text, MAX_LATEST_CHARS));
    if brief.goal.is_none() {
        brief
            .warnings
            .push("The session's first request could not be read.".into());
    }
}

/// `event_msg` payload messages of one kind, in file order.
fn codex_messages(text: &str, kind: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
            if value.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
                return None;
            }
            let payload = value.get("payload")?;
            if payload.get("type").and_then(|t| t.as_str()) != Some(kind) {
                return None;
            }
            let message = payload.get("message")?.as_str()?.trim();
            (!message.is_empty()).then(|| message.to_string())
        })
        .collect()
}

// ── Git ────────────────────────────────────────────────────────────

fn git_state(cwd: &Path) -> Option<RelayGit> {
    if run_git(cwd, &["rev-parse", "--is-inside-work-tree"])?.trim() != "true" {
        return None;
    }
    // Works before the first commit; empty when HEAD is detached.
    let branch = run_git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default();
    let status = run_git(
        cwd,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .unwrap_or_default();
    let mut changed: Vec<String> = status
        .lines()
        .filter_map(|line| line.get(3..))
        .map(|path| path.trim().trim_matches('"').to_string())
        .filter(|path| !path.is_empty())
        .collect();
    let more = changed.len().saturating_sub(MAX_CHANGED_FILES);
    changed.truncate(MAX_CHANGED_FILES);
    let branch = branch.trim();
    Some(RelayGit {
        branch: (!branch.is_empty()).then(|| branch.to_string()),
        changed,
        more,
    })
}

/// Run git with a hard timeout; None when git is missing, the directory is
/// not a repository, or git is too slow.
fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    Some(output)
}

// ── Startup prompt ─────────────────────────────────────────────────

/// Write the prompt to a private file and return the command line that
/// starts the agent with it. The prompt is read by `$(cat …)` inside double
/// quotes, so its text is never parsed as shell syntax.
pub fn startup_command(terminal_id: &str, prompt: &StartupPrompt) -> Result<String, String> {
    startup_command_in(
        &offdesk_protocol::config_dir().join("relay"),
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
            std::env::temp_dir().join(format!("offdesk-relay-{name}-{}", uuid::Uuid::new_v4()));
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
    fn usage_limits_are_recognized_only_near_the_bottom() {
        let claude = "⏺ Backfilling\n\n✻ Usage limit reached · resets 3pm (Asia/Shanghai)\n\n❯ \n";
        assert_eq!(
            usage_limit_line(claude).as_deref(),
            Some("Usage limit reached · resets 3pm (Asia/Shanghai)")
        );
        let older = "  ⎿ 5-hour limit reached ∙ resets 3pm\n❯";
        assert_eq!(
            usage_limit_line(older).as_deref(),
            Some("5-hour limit reached ∙ resets 3pm")
        );
        let codex =
            "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro).\n› ";
        assert!(usage_limit_line(codex)
            .unwrap()
            .starts_with("You’ve hit your usage limit"));
        // Not usage limits.
        assert_eq!(
            usage_limit_line("Context limit reached · /compact or /clear to continue"),
            None
        );
        assert_eq!(
            usage_limit_line("Fast limit reached and temporarily disabled · resets in 8m"),
            None
        );
        // A notice that has scrolled far up is history, not the current state.
        let mut scrolled = String::from("Usage limit reached · resets 3pm\n");
        for i in 0..USAGE_LIMIT_WINDOW {
            scrolled.push_str(&format!("line {i}\n"));
        }
        assert_eq!(usage_limit_line(&scrolled), None);
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
        let files = vec![crate::revive::ClaudeSessionFile {
            pid: 11,
            session_id: "session-a".into(),
            tmux: format!("{}:@1.%1", crate::pty::tmux_session_name(id)),
        }];
        let claude = pane_agent(id, &pane(10, "claude.exe"), &processes, &files, |_| {
            Vec::new()
        })
        .unwrap();
        assert_eq!(claude.kind, RelayAgent::Claude);
        assert_eq!(claude.session_id.as_deref(), Some("session-a"));

        let rollout = PathBuf::from(
            "/home/u/.codex/sessions/2026/10/05/rollout-2026-10-05T10-00-00-0199b2a0-0000-7000-8000-000000000001.jsonl",
        );
        let codex = pane_agent("t2", &pane(20, "node"), &processes, &[], |pid| {
            if pid == 22 {
                vec![rollout.clone()]
            } else {
                Vec::new()
            }
        })
        .unwrap();
        assert_eq!(codex.kind, RelayAgent::Codex);
        assert_eq!(
            codex.session_id.as_deref(),
            Some("0199b2a0-0000-7000-8000-000000000001")
        );
        assert_eq!(codex.rollout.as_deref(), Some(rollout.as_path()));

        assert_eq!(
            pane_agent("t3", &pane(30, "vim"), &processes, &[], |_| Vec::new()),
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
    fn claude_briefs_read_the_request_latest_reply_and_visible_tasks() {
        let config = temp_dir("claude");
        let session = "22222222-2222-4222-8222-222222222222";
        let project = config.join("projects").join("-tmp-project");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = [
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: local commands"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"custom-title","customTitle":"Fix order enrichment"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Restore order enrichment and backfill"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent noise"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Backfill is at 31,240 of 76,000."}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"later subagent noise"}]}}"#,
        ]
        .join("\n");
        std::fs::write(project.join(format!("{session}.jsonl")), transcript).unwrap();
        let tasks = config.join("tasks").join(session);
        std::fs::create_dir_all(&tasks).unwrap();
        std::fs::write(tasks.join("2.json"), r#"{"id":"2","subject":"Add a stall alert","description":"","status":"pending","blocks":[],"blockedBy":[]}"#).unwrap();
        std::fs::write(tasks.join("1.json"), r#"{"id":"1","subject":"Backfill orders","description":"","status":"in_progress","blocks":[],"blockedBy":[]}"#).unwrap();
        std::fs::write(tasks.join("3.json"), r#"{"id":"3","subject":"internal","description":"","status":"pending","blocks":[],"blockedBy":[],"metadata":{"_internal":true}}"#).unwrap();
        std::fs::write(tasks.join(".highwatermark"), "3").unwrap();

        let mut brief = RelayBrief {
            agent: RelayAgent::Claude,
            cwd: "/tmp/project".into(),
            session_id: Some(session.into()),
            title: None,
            goal: None,
            latest: None,
            tasks: Vec::new(),
            git: None,
            usage_limit: None,
            warnings: Vec::new(),
        };
        fill_claude(&mut brief, &config);
        assert_eq!(brief.title.as_deref(), Some("Fix order enrichment"));
        assert_eq!(
            brief.goal.as_deref(),
            Some("Restore order enrichment and backfill")
        );
        assert_eq!(
            brief.latest.as_deref(),
            Some("Backfill is at 31,240 of 76,000.")
        );
        assert_eq!(
            brief.tasks,
            vec![
                RelayTask {
                    subject: "Backfill orders".into(),
                    status: RelayTaskStatus::InProgress
                },
                RelayTask {
                    subject: "Add a stall alert".into(),
                    status: RelayTaskStatus::Pending
                },
            ]
        );
        assert!(brief.warnings.is_empty(), "{:?}", brief.warnings);

        // An unmatched session says so instead of looking complete.
        let mut unmatched = RelayBrief {
            session_id: None,
            ..brief.clone()
        };
        unmatched.warnings.clear();
        fill_claude(&mut unmatched, &config);
        assert_eq!(unmatched.warnings.len(), 1);
        // Session ids never become arbitrary paths.
        assert_eq!(find_claude_transcript(&config, "../../etc/passwd"), None);
    }

    #[test]
    fn codex_briefs_skip_injected_context_and_take_the_last_reply() {
        let dir = temp_dir("codex");
        let rollout = dir.join("rollout.jsonl");
        std::fs::write(
            &rollout,
            [
                r#"{"type":"session_meta","payload":{"id":"x","cwd":"/tmp/project"}}"#,
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>cwd</environment_context>"}}"#,
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"Write the release notes"}}"#,
                r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Drafted the outline."}}"#,
                r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Notes are in docs/releases/0.7.6.md."}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let mut brief = RelayBrief {
            agent: RelayAgent::Codex,
            cwd: "/tmp/project".into(),
            session_id: Some("x".into()),
            title: None,
            goal: None,
            latest: None,
            tasks: Vec::new(),
            git: None,
            usage_limit: None,
            warnings: Vec::new(),
        };
        fill_codex(&mut brief, Some(&rollout));
        assert_eq!(brief.goal.as_deref(), Some("Write the release notes"));
        assert_eq!(
            brief.latest.as_deref(),
            Some("Notes are in docs/releases/0.7.6.md.")
        );
    }

    #[test]
    fn git_state_lists_changes_and_ignores_non_repositories() {
        let repo = temp_dir("git");
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
        };
        if !git(&["init", "-q", "-b", "main"]).status.success() {
            return; // git unavailable on this runner
        }
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        let state = git_state(&repo).unwrap();
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.changed, vec!["a.txt".to_string()]);
        assert_eq!(git_state(&temp_dir("plain")), None);
    }

    #[test]
    fn startup_commands_read_a_private_prompt_file() {
        let dir = temp_dir("prompt").join("relay dir");
        let id = "33333333-3333-4333-8333-333333333333";
        let prompt = StartupPrompt {
            agent: RelayAgent::Codex,
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
            agent: RelayAgent::Claude,
            text: "-p hi".into(),
        };
        assert!(startup_command_in(&dir, id, &dash).is_err());
    }
}
