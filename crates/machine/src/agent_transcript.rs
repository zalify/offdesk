//! The conversation of the coding agent in a terminal, read from the agent's own session
//! file (`HubToMachine::AgentTranscript`): Claude Code's
//! `~/.claude/projects/<folder>/<session>.jsonl`, found from `~/.claude/sessions/<pid>.json`,
//! and Codex's rollout, the one its process holds open. What the person and the agent
//! said, and each tool call in one line. Never tool output, thinking or the screen.
//!
//! Message ids are "<byte offset of the line>:<block>", so they only grow as the agent
//! appends, and `after` reads from that line on instead of the whole file.
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use offdesk_protocol::{AgentMessage, AgentMessageRole};
use serde_json::Value;

use crate::codex_title::{find_named_descendants, Process};

/// The most read from the end of a file when there's no `after`.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// The most read after `after` (a long gap: the rest comes on the next call).
const AFTER_BYTES: u64 = 8 * 1024 * 1024;
/// The most messages returned.
pub const MAX_MESSAGES: usize = 200;
const MAX_TEXT_CHARS: usize = 8000;
const MAX_TOOL_CHARS: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Claude,
    Codex,
}

/// The session file of the agent running in the pane whose root process is `pane_pid`.
pub fn locate(pane_pid: u32, processes: &[Process]) -> Option<(Format, PathBuf)> {
    if let [pid] = find_named_descendants(processes, pane_pid, "claude").as_slice() {
        let session = claude_session_id(*pid)?;
        return claude_transcript(&session).map(|path| (Format::Claude, path));
    }
    crate::codex_title::rollout_path_for_pane_pid(pane_pid, processes)
        .map(|path| (Format::Codex, path))
}

fn claude_home() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|home| home.join(".claude")),
    }
}

/// The session a Claude Code process is in now (it changes on /clear and /resume).
fn claude_session_id(pid: u32) -> Option<String> {
    let path = claude_home()?.join("sessions").join(format!("{pid}.json"));
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let id = value.get("sessionId")?.as_str()?;
    is_session_id(id).then(|| id.to_string())
}

fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `<session>.jsonl` in whichever project folder Claude Code keeps it.
fn claude_transcript(session: &str) -> Option<PathBuf> {
    let projects = claude_home()?.join("projects");
    let name = format!("{session}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&name))
        .find(|path| path.is_file())
}

/// Messages from `path`: after `after`, or the last ones; at most `limit`.
pub fn read(
    format: Format,
    path: &Path,
    after: Option<&str>,
    limit: usize,
) -> std::io::Result<Vec<AgentMessage>> {
    let limit = limit.clamp(1, MAX_MESSAGES);
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let after = after.and_then(parse_id).filter(|(offset, _)| *offset < len);
    let (start, max) = match after {
        Some((offset, _)) => (offset, AFTER_BYTES),
        None => (len.saturating_sub(TAIL_BYTES), TAIL_BYTES),
    };
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes)?;
    let mut messages = parse(format, &bytes, start, after.is_none() && start > 0);
    if let Some(after) = after {
        messages.retain(|message| parse_id(&message.id).is_some_and(|id| id > after));
        messages.truncate(limit);
    } else if messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }
    Ok(messages)
}

fn parse_id(id: &str) -> Option<(u64, u32)> {
    let (offset, block) = id.split_once(':')?;
    Some((offset.parse().ok()?, block.parse().ok()?))
}

/// The messages in `bytes`, which start at `base` in the file. `skip_first`: it starts
/// mid-line (a tail), so the first line is cut and skipped. Only whole lines are read.
pub fn parse(format: Format, bytes: &[u8], base: u64, skip_first: bool) -> Vec<AgentMessage> {
    let mut messages = Vec::new();
    let mut offset = 0usize;
    let mut first = true;
    while offset < bytes.len() {
        let Some(end) = bytes[offset..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| offset + i)
        else {
            break; // a line still being written
        };
        let line = &bytes[offset..end];
        let at = base + offset as u64;
        offset = end + 1;
        if std::mem::take(&mut first) && skip_first {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let entries = match format {
            Format::Claude => claude_entries(&value),
            Format::Codex => codex_entries(&value),
        };
        let at_ms = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .map(|time| time.timestamp_millis());
        for (block, (role, text)) in entries.into_iter().enumerate() {
            messages.push(AgentMessage {
                id: format!("{at}:{block}"),
                role,
                text,
                at_ms,
            });
        }
    }
    messages
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}

/// What a person typed, not what the agent's harness wrapped around it: slash-command
/// echoes, reminders and environment context all start with a tag.
fn said_by_person(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && !text.starts_with('<') && !text.starts_with("# AGENTS.md"))
        .then(|| clip(text, MAX_TEXT_CHARS))
}

/// One line for a tool call: its name and what it works on.
fn tool_line(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let detail = match name {
        "Bash" | "shell" | "exec_command" | "local_shell" => field("command")
            .or(field("cmd"))
            .map(str::to_string)
            .or_else(|| {
                input.get("command").and_then(Value::as_array).map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            }),
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => field("file_path")
            .or(field("notebook_path"))
            .map(str::to_string),
        "Grep" | "Glob" => field("pattern").map(str::to_string),
        "WebFetch" => field("url").map(str::to_string),
        "WebSearch" => field("query").map(str::to_string),
        "Task" | "Agent" => field("description").map(str::to_string),
        _ => None,
    };
    let detail = detail
        .map(|detail| detail.lines().next().unwrap_or_default().trim().to_string())
        .filter(|d| !d.is_empty());
    clip(
        &match detail {
            Some(detail) => format!("{name}: {detail}"),
            None => name.to_string(),
        },
        MAX_TOOL_CHARS,
    )
}

fn claude_entries(value: &Value) -> Vec<(AgentMessageRole, String)> {
    let kind = value.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("user" | "assistant"))
        || value.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || value.get("isMeta").and_then(Value::as_bool) == Some(true)
    {
        return Vec::new();
    }
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
    else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    if kind == Some("user") {
        match content {
            Value::String(text) => {
                entries.extend(said_by_person(text).map(|text| (AgentMessageRole::User, text)))
            }
            Value::Array(blocks) => {
                // A tool's result comes back as a user message: not the person's
                if blocks
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                {
                    return Vec::new();
                }
                let text: Vec<String> = blocks
                    .iter()
                    .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                        Some("text") => block
                            .get("text")
                            .and_then(Value::as_str)
                            .and_then(said_by_person),
                        Some("image") => Some("[image]".to_string()),
                        _ => None,
                    })
                    .collect();
                if !text.is_empty() {
                    entries.push((AgentMessageRole::User, text.join("\n\n")));
                }
            }
            _ => {}
        }
        return entries;
    }
    for block in content.as_array().into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| clip(text, MAX_TEXT_CHARS))
                    .filter(|t| !t.is_empty())
                {
                    entries.push((AgentMessageRole::Agent, text));
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                entries.push((
                    AgentMessageRole::Tool,
                    tool_line(name, block.get("input").unwrap_or(&Value::Null)),
                ));
            }
            _ => {}
        }
    }
    entries
}

fn codex_entries(value: &Value) -> Vec<(AgentMessageRole, String)> {
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return Vec::new();
    }
    let Some(payload) = value.get("payload") else {
        return Vec::new();
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = match payload.get("role").and_then(Value::as_str) {
                Some("user") => AgentMessageRole::User,
                Some("assistant") => AgentMessageRole::Agent,
                _ => return Vec::new(),
            };
            let text: Vec<String> = payload
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .filter_map(|text| {
                    if role == AgentMessageRole::User {
                        said_by_person(text)
                    } else {
                        Some(clip(text, MAX_TEXT_CHARS))
                    }
                })
                .filter(|text| !text.is_empty())
                .collect();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![(role, text.join("\n\n"))]
            }
        }
        Some("function_call") => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let input = payload
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
                .unwrap_or(Value::Null);
            vec![(AgentMessageRole::Tool, tool_line(name, &input))]
        }
        Some("custom_tool_call" | "local_shell_call") => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("shell");
            let input = payload
                .get("input")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let first = input
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with("//"));
            vec![(
                AgentMessageRole::Tool,
                clip(
                    &match first {
                        Some(line) => format!("{name}: {line}"),
                        None => name.to_string(),
                    },
                    MAX_TOOL_CHARS,
                ),
            )]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(values: &[Value]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in values {
            bytes.extend(serde_json::to_vec(value).unwrap());
            bytes.push(b'\n');
        }
        bytes
    }

    #[test]
    fn claude_keeps_what_was_said_and_tool_calls_only() {
        let bytes = lines(&[
            serde_json::json!({"type": "permission-mode", "mode": "default"}),
            serde_json::json!({"type": "user", "timestamp": "2026-11-19T10:00:00Z", "message": {"role": "user", "content": "Fix the login bug"}}),
            serde_json::json!({"type": "user", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}}),
            serde_json::json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Caveat: …"}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "secret"}]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "git status\ngit diff"}}]}}),
            serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "On branch main"}]}}),
            serde_json::json!({"type": "assistant", "isSidechain": true, "message": {"role": "assistant", "content": [{"type": "text", "text": "subagent"}]}}),
            serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixed it."}]}}),
        ]);
        let messages = parse(Format::Claude, &bytes, 0, false);
        let said: Vec<_> = messages.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(
            said,
            vec![
                (AgentMessageRole::User, "Fix the login bug"),
                (AgentMessageRole::Tool, "Bash: git status"),
                (AgentMessageRole::Agent, "Fixed it."),
            ]
        );
        assert_eq!(
            messages[0].at_ms,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-11-19T10:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
    }

    #[test]
    fn codex_skips_instructions_and_environment() {
        let bytes = lines(&[
            serde_json::json!({"type": "session_meta", "payload": {}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "rules"}]}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "# AGENTS.md instructions\n…"}, {"type": "input_text", "text": "<environment_context>…"}]}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Add a test"}]}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "reasoning", "summary": []}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{\"command\":[\"bash\",\"-lc\",\"cargo test\"]}"}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": "// @exec: {}\ntext(await run())"}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}}),
        ]);
        let said: Vec<_> = parse(Format::Codex, &bytes, 0, false)
            .into_iter()
            .map(|m| (m.role, m.text))
            .collect();
        assert_eq!(
            said,
            vec![
                (AgentMessageRole::User, "Add a test".to_string()),
                (
                    AgentMessageRole::Tool,
                    "shell: bash -lc cargo test".to_string()
                ),
                (
                    AgentMessageRole::Tool,
                    "exec: text(await run())".to_string()
                ),
                (AgentMessageRole::Agent, "Done.".to_string()),
            ]
        );
    }

    #[test]
    fn ids_grow_and_after_reads_only_newer_whole_lines() {
        let path =
            std::env::temp_dir().join(format!("offdesk-transcript-{}.jsonl", uuid::Uuid::new_v4()));
        let say = |text: &str| serde_json::json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
        let mut bytes = lines(&[say("one"), say("two"), say("three")]);
        // A line still being written isn't read
        bytes.extend(b"{\"type\":\"assistant\",\"mess");
        std::fs::write(&path, &bytes).unwrap();
        let all = read(Format::Claude, &path, None, 50).unwrap();
        assert_eq!(
            all.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
        let last_two = read(Format::Claude, &path, None, 2).unwrap();
        assert_eq!(
            last_two.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["two", "three"]
        );
        let after = read(Format::Claude, &path, Some(&all[0].id), 50).unwrap();
        assert_eq!(
            after.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["two", "three"]
        );
        assert!(read(Format::Claude, &path, Some(&all[2].id), 50)
            .unwrap()
            .is_empty());
        // An id from another file (past its end) reads the tail instead
        assert_eq!(
            read(Format::Claude, &path, Some("999999:0"), 50)
                .unwrap()
                .len(),
            3
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_tail_skips_its_cut_first_line() {
        let say = |text: &str| serde_json::json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
        let bytes = lines(&[say("one"), say("two")]);
        let cut = &bytes[5..];
        let messages = parse(Format::Claude, cut, 5, true);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "two");
        assert!(messages[0].id.starts_with(&format!(
            "{}:",
            bytes.iter().position(|b| *b == b'\n').unwrap() + 1
        )));
    }
}
