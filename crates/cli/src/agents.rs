//! What coding agents in Offdesk terminals say about their runs
//! (docs/plans/2026-10-14-agent-runs.md, A2): `offdesk hook` turns Claude Code and Codex
//! hook events into signals, `offdesk run` lets an agent report a note, that it's
//! blocked, or that it finished, and `offdesk agents hooks` adds the hooks to Claude
//! Code's settings. All of it goes to the node's agent socket; none of it needs a hub
//! token, and a hook never changes what the agent does: it prints nothing and always
//! exits 0.

use std::io::{IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use indexmap::IndexMap;
use offdesk_protocol::{
    AgentQuestionOption, AgentReportKind, AgentRequestKind, AgentRunProgress, AgentSignal,
    LocalAgentReport, RunAgent,
};
use serde_json::value::RawValue;
use serde_json::Value;

use crate::CliError;

/// A hook gets this long to hand its signal over (Claude Code's SessionEnd hooks share 1.5 s).
const SOCKET_TIMEOUT: Duration = Duration::from_millis(500);
/// Hook input beyond this is ignored.
const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 300;

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text,
    }
}

/// "Bash: npm test", "Edit: src/app.ts": what a tool is about to do, for a person.
fn tool_summary(tool: &str, input: &Value) -> String {
    let detail = [
        "command",
        "file_path",
        "path",
        "url",
        "pattern",
        "query",
        "description",
    ]
    .iter()
    .find_map(|key| match input.get(key)? {
        Value::String(text) => Some(text.clone()),
        // Codex gives its command as argv
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    });
    clip(
        &match detail {
            Some(detail) if !detail.trim().is_empty() => format!("{tool}: {detail}"),
            _ => tool.to_string(),
        },
        MAX_PROMPT_CHARS,
    )
}

/// AskUserQuestion's first question and its options, as far as the input shows them.
fn question(input: &Value) -> AgentSignal {
    let first = input
        .get("questions")
        .and_then(|q| q.get(0))
        .unwrap_or(input);
    let prompt = ["question", "header"]
        .iter()
        .find_map(|key| first.get(key).and_then(Value::as_str))
        .map(|text| clip(text, MAX_PROMPT_CHARS));
    let options = first
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    option
                        .get("label")
                        .and_then(Value::as_str)
                        .or(option.as_str())
                })
                .take(10)
                .enumerate()
                .map(|(i, label)| AgentQuestionOption {
                    id: (i + 1).to_string(),
                    label: clip(label, 80),
                    detail: None,
                })
                .collect()
        })
        .unwrap_or_default();
    AgentSignal::Waiting {
        request: AgentRequestKind::Question,
        prompt,
        options,
    }
}

/// TodoWrite's list as progress: how many are done, and the one in progress.
fn todo_progress(input: &Value) -> Option<AgentSignal> {
    let todos = input.get("todos")?.as_array()?;
    if todos.is_empty() {
        return None;
    }
    let status = |todo: &Value| {
        todo.get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let current = todos
        .iter()
        .find(|todo| status(todo) == "in_progress")
        .and_then(|todo| {
            ["activeForm", "content"]
                .iter()
                .find_map(|key| todo.get(key).and_then(Value::as_str))
        });
    Some(AgentSignal::Progress(AgentRunProgress {
        done: todos
            .iter()
            .filter(|todo| status(todo) == "completed")
            .count() as u32,
        total: todos.len() as u32,
        current: current.map(|text| clip(text, MAX_PROMPT_CHARS)),
    }))
}

/// A Claude Code (or Codex: same event and field names) hook event as a signal; None
/// for events that say nothing about the run's state.
pub fn hook_signal(event: &str, input: &Value) -> Option<AgentSignal> {
    let tool = input
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_input = input.get("tool_input").cloned().unwrap_or(Value::Null);
    match event {
        // At its prompt, waiting for the first instruction
        "SessionStart" => Some(AgentSignal::Idle),
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" => Some(AgentSignal::Working),
        "PreToolUse" => match tool {
            "AskUserQuestion" => Some(question(&tool_input)),
            "TodoWrite" => todo_progress(&tool_input).or(Some(AgentSignal::Working)),
            _ => Some(AgentSignal::Working),
        },
        "PermissionRequest" => Some(AgentSignal::Waiting {
            request: AgentRequestKind::Approval,
            prompt: Some(tool_summary(tool, &tool_input)),
            options: Vec::new(),
        }),
        "Notification" => {
            let message = input
                .get("message")
                .and_then(Value::as_str)
                .map(|text| clip(text, MAX_PROMPT_CHARS));
            match input.get("notification_type").and_then(Value::as_str)? {
                "idle_prompt" => Some(AgentSignal::Idle),
                "agent_needs_input" | "elicitation_dialog" => Some(AgentSignal::Waiting {
                    request: AgentRequestKind::Input,
                    prompt: message,
                    options: Vec::new(),
                }),
                // PermissionRequest already said what it asks, more precisely
                _ => None,
            }
        }
        "Stop" => Some(AgentSignal::Idle),
        _ => None,
    }
}

/// Codex's `notify` program gets one JSON argument; only turn completion is sent.
pub fn codex_notify_signal(payload: &str) -> Option<AgentSignal> {
    let value: Value = serde_json::from_str(payload).ok()?;
    (value.get("type")?.as_str()? == "agent-turn-complete").then_some(AgentSignal::Idle)
}

/// The pane this process runs in, if it's inside tmux: (`$TMUX_PANE`, the socket from `$TMUX`).
fn tmux_pane() -> Option<(String, String)> {
    let pane = std::env::var("TMUX_PANE").ok().filter(|p| !p.is_empty())?;
    let socket = std::env::var("TMUX").ok()?.split(',').next()?.to_string();
    Some((pane, socket))
}

fn send(report: &LocalAgentReport, socket: &Path) -> std::io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    let mut line = serde_json::to_vec(report).map_err(std::io::Error::other)?;
    line.push(b'\n');
    stream.write_all(&line)
}

fn report(agent: Option<RunAgent>, source: &str, signal: AgentSignal) -> std::io::Result<()> {
    let (pane, socket) = tmux_pane().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not inside an Offdesk terminal",
        )
    })?;
    send(
        &LocalAgentReport {
            tmux_pane: pane,
            tmux_socket: Some(socket),
            agent,
            source: source.to_string(),
            signal,
        },
        &offdesk_protocol::agent_socket_path(),
    )
}

/// `offdesk hook <agent> <event> [args]`: never fails, never prints. For Codex's
/// `notify`, the last argument is Codex's JSON and any before it are the person's own
/// notify program, which then runs with that JSON as Codex would have run it.
pub fn hook(agent: &str, event: &str, args: &[String]) {
    let run_agent = match agent {
        "claude" => RunAgent::Claude,
        "codex" => RunAgent::Codex,
        _ => return,
    };
    if event == "notify" {
        let Some((payload, chained)) = args.split_last() else {
            return;
        };
        if let Some(signal) = codex_notify_signal(payload) {
            let _ = report(Some(run_agent), "hooks", signal);
        }
        if let Some((program, program_args)) = chained.split_first() {
            use std::os::unix::process::CommandExt;
            // Replaces this process; if it can't run, there's nothing to report
            let _ = std::process::Command::new(program)
                .args(program_args)
                .arg(payload)
                .exec();
        }
        return;
    }
    let signal = {
        let mut input = String::new();
        let stdin = std::io::stdin();
        if !stdin.is_terminal() {
            let _ = stdin
                .lock()
                .take(MAX_INPUT_BYTES)
                .read_to_string(&mut input);
        }
        let value = serde_json::from_str(&input).unwrap_or(Value::Null);
        hook_signal(event, &value)
    };
    if let Some(signal) = signal {
        let _ = report(Some(run_agent), "hooks", signal);
    }
}

/// `offdesk run note|blocked|done`: an agent's report about its own work.
pub fn run_report(kind: AgentReportKind, text: &str, link: Option<&str>) -> Result<(), CliError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(CliError::Usage(
            "say what happened, e.g. offdesk run note \"Found the bug\"".into(),
        ));
    }
    let signal = AgentSignal::Report {
        kind,
        text: text.to_string(),
        link: link.map(str::to_string),
    };
    report(None, "report", signal).map_err(|error| {
        CliError::Usage(format!(
            "couldn't report to Offdesk ({error}); run this from an agent inside an Offdesk terminal"
        ))
    })
}

// ── `offdesk agents hooks install|uninstall` ──

/// Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
pub fn claude_settings_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join("settings.json")),
        None => dirs::home_dir().map(|home| home.join(".claude").join("settings.json")),
    }
}

/// Settings with Offdesk's hooks removed (`install` false) or added once per event.
/// Other keys keep their order and text; the person's own hooks stay as they are.
pub fn update_claude_settings(original: &str, exe: &Path, install: bool) -> Result<String, String> {
    let mut settings: IndexMap<String, Box<RawValue>> = if original.trim().is_empty() {
        IndexMap::new()
    } else {
        serde_json::from_str(original).map_err(|error| format!("isn't a JSON object: {error}"))?
    };
    let mut hooks: IndexMap<String, Vec<Value>> = match settings.get("hooks") {
        Some(raw) => serde_json::from_str(raw.get())
            .map_err(|error| format!("its \"hooks\" isn't valid: {error}"))?,
        None => IndexMap::new(),
    };
    // Drop ours first, so installing twice (or with a moved binary) leaves one each
    for groups in hooks.values_mut() {
        for group in groups.iter_mut() {
            if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                handlers.retain(|handler| !offdesk_protocol::is_offdesk_claude_hook(handler));
            }
        }
        groups.retain(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|h| !h.is_empty())
        });
    }
    hooks.retain(|_, groups| !groups.is_empty());
    if install {
        for (event, group) in offdesk_protocol::claude_hook_groups(&exe.to_string_lossy()) {
            hooks.entry(event.to_string()).or_default().push(group);
        }
    }
    if hooks.is_empty() {
        settings.shift_remove("hooks");
    } else {
        let raw = serde_json::to_string(&hooks).map_err(|error| error.to_string())?;
        settings.insert(
            "hooks".into(),
            RawValue::from_string(raw).map_err(|error| error.to_string())?,
        );
    }
    // Two-space JSON; other keys keep their own text, only "hooks" is laid out anew
    let mut out = String::from("{\n");
    for (i, (key, raw)) in settings.iter().enumerate() {
        let pretty = match serde_json::from_str::<Value>(raw.get()) {
            Ok(v) if key == "hooks" => {
                serde_json::to_string_pretty(&v).unwrap_or_else(|_| raw.get().to_string())
            }
            _ => raw.get().to_string(),
        };
        let indented = pretty.replace('\n', "\n  ");
        out.push_str(&format!(
            "  {}: {}{}\n",
            serde_json::to_string(key).unwrap(),
            indented,
            if i + 1 < settings.len() { "," } else { "" }
        ));
    }
    out.push_str("}\n");
    Ok(out)
}

/// `offdesk agents hooks install|uninstall [--print]`
pub fn hooks(install: bool, print: bool) -> Result<(), CliError> {
    let path = claude_settings_path()
        .ok_or_else(|| CliError::Usage("can't find your home directory".into()))?;
    let exe = std::env::current_exe()
        .map_err(|error| CliError::Usage(format!("can't find this program: {error}")))?;
    let original = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(CliError::Usage(format!(
                "can't read {}: {error}",
                path.display()
            )))
        }
    };
    let updated = update_claude_settings(&original, &exe, install).map_err(|error| {
        CliError::Usage(format!(
            "{} {error}; fix it, then try again",
            path.display()
        ))
    })?;
    if print {
        crate::commands::out_line(updated.trim_end());
        return Ok(());
    }
    if updated == original {
        crate::commands::out_line(&format!("Nothing to change in {}", path.display()));
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|error| CliError::Usage(format!("can't create {}: {error}", dir.display())))?;
    }
    if !original.is_empty() {
        let backup = path.with_extension("json.offdesk-backup");
        std::fs::write(&backup, &original).map_err(|error| {
            CliError::Usage(format!("can't back up to {}: {error}", backup.display()))
        })?;
    }
    let temp = path.with_extension("json.offdesk-tmp");
    std::fs::write(&temp, &updated)
        .and_then(|_| std::fs::rename(&temp, &path))
        .map_err(|error| CliError::Usage(format!("can't write {}: {error}", path.display())))?;
    crate::commands::out_line(&if install {
        format!(
            "Added Offdesk's hooks to {}. Claude Code sessions started in Offdesk terminals now report their state (new sessions; restart running ones).",
            path.display()
        )
    } else {
        format!("Removed Offdesk's hooks from {}", path.display())
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_hook_events_become_signals() {
        assert_eq!(
            hook_signal("SessionStart", &json!({"source": "startup"})),
            Some(AgentSignal::Idle)
        );
        assert_eq!(
            hook_signal("UserPromptSubmit", &json!({})),
            Some(AgentSignal::Working)
        );
        assert_eq!(
            hook_signal("PreToolUse", &json!({"tool_name": "Bash"})),
            Some(AgentSignal::Working)
        );
        assert_eq!(hook_signal("Stop", &json!({})), Some(AgentSignal::Idle));
        assert_eq!(hook_signal("SessionEnd", &json!({})), None);
        assert_eq!(
            hook_signal(
                "PermissionRequest",
                &json!({"tool_name": "Bash", "tool_input": {"command": "psql $PROD\n  -f 0012.sql"}})
            ),
            Some(AgentSignal::Waiting {
                request: AgentRequestKind::Approval,
                prompt: Some("Bash: psql $PROD -f 0012.sql".into()),
                options: vec![]
            })
        );
        // Codex gives argv
        assert_eq!(
            hook_signal(
                "PermissionRequest",
                &json!({"tool_name": "shell", "tool_input": {"command": ["cargo", "test"]}})
            ),
            Some(AgentSignal::Waiting {
                request: AgentRequestKind::Approval,
                prompt: Some("shell: cargo test".into()),
                options: vec![]
            })
        );
        assert_eq!(
            hook_signal(
                "Notification",
                &json!({"notification_type": "idle_prompt", "message": "waiting"})
            ),
            Some(AgentSignal::Idle)
        );
        assert_eq!(
            hook_signal(
                "Notification",
                &json!({"notification_type": "permission_prompt", "message": "needs permission"})
            ),
            None
        );
        assert!(matches!(
            hook_signal("Notification", &json!({"notification_type": "agent_needs_input", "message": "Need the API key name"})),
            Some(AgentSignal::Waiting { request: AgentRequestKind::Input, prompt: Some(p), .. }) if p == "Need the API key name"
        ));
    }

    #[test]
    fn questions_and_task_lists_are_read_as_far_as_they_go() {
        let asked = hook_signal(
            "PreToolUse",
            &json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Which plan?", "options": [{"label": "Pro"}, {"label": "Team"}]}]}}),
        );
        assert_eq!(
            asked,
            Some(AgentSignal::Waiting {
                request: AgentRequestKind::Question,
                prompt: Some("Which plan?".into()),
                options: vec![
                    AgentQuestionOption {
                        id: "1".into(),
                        label: "Pro".into(),
                        detail: None
                    },
                    AgentQuestionOption {
                        id: "2".into(),
                        label: "Team".into(),
                        detail: None
                    },
                ],
            })
        );
        // An unknown shape still says it's a question
        assert_eq!(
            hook_signal(
                "PreToolUse",
                &json!({"tool_name": "AskUserQuestion", "tool_input": {"something": 1}})
            ),
            Some(AgentSignal::Waiting {
                request: AgentRequestKind::Question,
                prompt: None,
                options: vec![]
            })
        );
        let todos = json!({"tool_name": "TodoWrite", "tool_input": {"todos": [
            {"content": "Find the bug", "status": "completed"},
            {"content": "Fix it", "activeForm": "Fixing it", "status": "in_progress"},
            {"content": "Add a test", "status": "pending"}
        ]}});
        assert_eq!(
            hook_signal("PreToolUse", &todos),
            Some(AgentSignal::Progress(AgentRunProgress {
                done: 1,
                total: 3,
                current: Some("Fixing it".into())
            }))
        );
        assert_eq!(
            codex_notify_signal(r#"{"type":"agent-turn-complete","thread-id":"t"}"#),
            Some(AgentSignal::Idle)
        );
        assert_eq!(codex_notify_signal(r#"{"type":"other"}"#), None);
        assert_eq!(codex_notify_signal("not json"), None);
    }

    #[test]
    fn installing_hooks_keeps_the_persons_settings_and_hooks() {
        let exe = Path::new("/Users/a/.local/bin/offdesk");
        let original = r#"{
  "model": "opus",
  "permissions": {"allow": ["Bash(npm test)"], "deny": []},
  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}
}
"#;
        let installed = update_claude_settings(original, exe, true).unwrap();
        let value: Value = serde_json::from_str(&installed).unwrap();
        // Key order and the other keys' text stay
        assert!(installed.find("\"model\"").unwrap() < installed.find("\"permissions\"").unwrap());
        assert!(installed.contains(r#""permissions": {"allow": ["Bash(npm test)"], "deny": []}"#));
        // Their own Stop hook stays beside ours
        let stop = value["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert_eq!(
            stop[1]["hooks"][0]["command"],
            "/Users/a/.local/bin/offdesk hook claude Stop"
        );
        assert_eq!(
            value["hooks"].as_object().unwrap().len(),
            offdesk_protocol::CLAUDE_HOOK_EVENTS.len()
        );
        // Installing again changes nothing; uninstalling gives their hooks back alone
        assert_eq!(
            update_claude_settings(&installed, exe, true).unwrap(),
            installed
        );
        let removed: Value =
            serde_json::from_str(&update_claude_settings(&installed, exe, false).unwrap()).unwrap();
        assert_eq!(
            removed["hooks"],
            json!({"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]})
        );
        assert_eq!(removed["model"], "opus");
        // No settings yet; and an odd path is quoted
        let fresh: Value = serde_json::from_str(
            &update_claude_settings("", Path::new("/Applications/Off Desk/offdesk"), true).unwrap(),
        )
        .unwrap();
        assert_eq!(
            fresh["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "'/Applications/Off Desk/offdesk' hook claude PreToolUse"
        );
        // Uninstalling with only ours leaves no hooks key
        let empty = update_claude_settings(
            &update_claude_settings("{}", exe, true).unwrap(),
            exe,
            false,
        )
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&empty).unwrap(), json!({}));
        assert!(update_claude_settings("[1]", exe, true).is_err());
    }
}
