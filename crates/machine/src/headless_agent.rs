//! Direct headless stream-JSON runner for Claude Code and Codex CLI.
//!
//! Unlike the npx-wrapped ACP adapters (which cold-start in ~57s), spawning
//! `claude -p --output-format stream-json --verbose --include-partial-messages`
//! and `codex exec --json` directly starts in <1s, uses the user's already-
//! authenticated local CLI, streams token-by-token deltas + tool calls, and
//! persists multi-turn context via `--resume <session_id>` / `exec resume`.
//!
//! Events are normalized into the exact same `AgentEvent` and `MachineToHub`
//! wire protocol used by `acp.rs`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use offdesk_protocol::{AgentEvent, AgentKind, AgentSessionStatus, MachineToHub};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use crate::acp::SessionCommand;

const TOOL_CONTENT_CAP: usize = 8 * 1024;

/// Locate a direct local CLI binary (`claude` or `codex`) if installed and
/// not explicitly overridden via `acp_agents` in `machine.json`.
pub fn resolve_direct_binary(
    overrides: &HashMap<String, Vec<String>>,
    kind: AgentKind,
) -> Option<String> {
    let key = match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Grok | AgentKind::Kimi => return None,
    };
    if overrides.contains_key(key) {
        return None;
    }
    find_binary(key)
}

fn find_binary(name: &str) -> Option<String> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidates = [
        home.join(".local/bin").join(name),
        home.join(".npm-global/bin").join(name),
        home.join(".cargo/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

pub struct HeadlessSessionHandle {
    pub cmd_tx: mpsc::Sender<SessionCommand>,
    pub ended: Arc<AtomicBool>,
}

/// Spawn a headless stream-JSON actor for a Claude or Codex bot session.
#[allow(clippy::too_many_arguments)]
pub fn spawn_headless_session(
    session_id: String,
    agent_kind: AgentKind,
    binary: String,
    cwd: String,
    auto_run: bool,
    resume_session_id: Option<String>,
    requested_model_id: Option<String>,
    initial_seq: u64,
    env_vars: HashMap<String, String>,
    outbound: mpsc::Sender<MachineToHub>,
) -> HeadlessSessionHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
    let ended = Arc::new(AtomicBool::new(false));

    let actor = HeadlessActor {
        session_id,
        agent_kind,
        binary,
        cwd,
        auto_run,
        cli_session_id: resume_session_id,
        model_id: requested_model_id,
        seq: initial_seq,
        env_vars,
        outbound,
        ended: ended.clone(),
    };
    tokio::spawn(actor.run(cmd_rx));

    HeadlessSessionHandle { cmd_tx, ended }
}

struct HeadlessActor {
    session_id: String,
    agent_kind: AgentKind,
    binary: String,
    cwd: String,
    auto_run: bool,
    cli_session_id: Option<String>,
    model_id: Option<String>,
    seq: u64,
    env_vars: HashMap<String, String>,
    outbound: mpsc::Sender<MachineToHub>,
    ended: Arc<AtomicBool>,
}

impl HeadlessActor {
    async fn run(mut self, mut cmd_rx: mpsc::Receiver<SessionCommand>) {
        // Ready immediately — no 57s npx handshake!
        self.send_update(
            Some(AgentSessionStatus::Idle),
            self.cli_session_id.clone(),
            self.model_id.clone(),
        )
        .await;

        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                SessionCommand::Prompt { text } => {
                    let killed = self.run_turn(text, &mut cmd_rx).await;
                    if killed {
                        break;
                    }
                }
                SessionCommand::SetModel { model_id } => {
                    self.model_id = Some(model_id.clone());
                    self.send_update(None, None, Some(model_id)).await;
                }
                SessionCommand::Answer { .. } | SessionCommand::Cancel => {
                    // Nothing running right now.
                }
                SessionCommand::Kill => {
                    break;
                }
            }
        }

        self.ended.store(true, Ordering::Release);
        let _ = self
            .outbound
            .send(MachineToHub::AgentSessionExited {
                session_id: self.session_id.clone(),
                reason: "session closed".to_string(),
            })
            .await;
    }

    /// Execute one prompt turn. Returns `true` if the session was killed.
    async fn run_turn(
        &mut self,
        prompt: String,
        cmd_rx: &mut mpsc::Receiver<SessionCommand>,
    ) -> bool {
        self.emit(AgentEvent::UserMessage {
            text: prompt.clone(),
        })
        .await;
        self.send_update(Some(AgentSessionStatus::Working), None, None)
            .await;

        let mut cmd = self.build_command(&prompt);
        let mut child: Child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.emit(AgentEvent::Error {
                    message: format!("failed to spawn {}: {err}", self.binary),
                })
                .await;
                self.emit(AgentEvent::TurnEnded {
                    stop_reason: "error".to_string(),
                })
                .await;
                self.send_update(Some(AgentSessionStatus::Idle), None, None)
                    .await;
                return false;
            }
        };

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (line_tx, mut line_rx) = mpsc::channel::<Option<String>>(256);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line_tx.send(Some(line)).await.is_err() {
                    return;
                }
            }
            let _ = line_tx.send(None).await;
        });

        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if buf.len() < 4096 {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&line);
                }
            }
            buf
        });

        let mut state = TurnParseState::default();
        let mut cancelled = false;
        let mut killed = false;

        loop {
            tokio::select! {
                maybe_line = line_rx.recv() => {
                    match maybe_line {
                        Some(Some(line)) => {
                            self.handle_ndjson_line(&line, &mut state).await;
                        }
                        Some(None) | None => break,
                    }
                }
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(SessionCommand::Cancel) => {
                            cancelled = true;
                            let _ = child.kill().await;
                            break;
                        }
                        Some(SessionCommand::Kill) | None => {
                            killed = true;
                            let _ = child.kill().await;
                            break;
                        }
                        Some(SessionCommand::SetModel { model_id }) => {
                            self.model_id = Some(model_id.clone());
                            self.send_update(None, None, Some(model_id)).await;
                        }
                        Some(SessionCommand::Prompt { .. }) | Some(SessionCommand::Answer { .. }) => {
                            // Ignore overlapping prompts while a turn is active.
                        }
                    }
                }
            }
        }

        let exit_status = child.wait().await.ok();
        let stderr_text = stderr_task.await.unwrap_or_default();

        if killed {
            return true;
        }

        if cancelled {
            self.emit(AgentEvent::TurnEnded {
                stop_reason: "cancelled".to_string(),
            })
            .await;
            self.send_update(Some(AgentSessionStatus::Idle), None, None)
                .await;
            return false;
        }

        if !state.saw_turn_end {
            let failed = exit_status.map(|s| !s.success()).unwrap_or(false);
            if failed {
                let msg = if stderr_text.trim().is_empty() {
                    format!(
                        "{} exited with status {:?}",
                        self.binary,
                        exit_status.and_then(|s| s.code())
                    )
                } else {
                    stderr_text.trim().to_string()
                };
                self.emit(AgentEvent::Error { message: msg }).await;
            }
            self.emit(AgentEvent::TurnEnded {
                stop_reason: if failed { "error" } else { "end_turn" }.to_string(),
            })
            .await;
        }

        self.send_update(Some(AgentSessionStatus::Idle), None, None)
            .await;
        false
    }

    fn build_command(&self, prompt: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.binary);
        cmd.current_dir(&self.cwd)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env("OFFDESK_BOT_SESSION_ID", &self.session_id)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        for (k, v) in &self.env_vars {
            cmd.env(k, v);
        }

        match self.agent_kind {
            AgentKind::Claude => {
                cmd.args([
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                ]);
                if self.auto_run {
                    cmd.args(["--permission-mode", "bypassPermissions"]);
                }
                if let Some(ref sid) = self.cli_session_id {
                    cmd.args(["--resume", sid]);
                } else {
                    let mut sys = String::from(
                        "You are an Offdesk Bot (a headless orchestrator, not bound to a single terminal). \
                         You may dispatch sub-agents natively or spawn/coordinate worker terminals via `offdesk` CLI \
                         (`offdesk open`, `offdesk msg send/post`, `offdesk draft write`). \
                         For structured or tabular data (task boards, comparison tables, bug lists, test matrices — \
                         not logs) use `offdesk db`: `db create <name> --col Status:select=todo,done`, \
                         `db add <db> <title> --set Status=todo`, `db query <db> --where Status=todo`, \
                         `db update`, `db import`; run `offdesk db --help` for details. \
                         `offdesk draft share <draft>` / `offdesk db share <db>` return a public read-only URL \
                         for showing results to people outside Offdesk — only use it when the user asked for \
                         a shareable/public link.",
                    );
                    if !self.env_vars.is_empty() {
                        let mut keys: Vec<&str> =
                            self.env_vars.keys().map(String::as_str).collect();
                        keys.sort_unstable();
                        sys.push_str(&format!(
                            " Scoped Vault credentials are pre-injected in your environment as: {}. \
                             Use them via `$VAR` without printing raw secret values.",
                            keys.join(", ")
                        ));
                    }
                    cmd.args(["--append-system-prompt", &sys]);
                }
                if let Some(ref model) = self.model_id {
                    cmd.args(["--model", model]);
                }
                cmd.arg(prompt);
            }
            AgentKind::Codex => {
                cmd.arg("exec");
                if let Some(ref thread_id) = self.cli_session_id {
                    cmd.args(["resume", thread_id]);
                }
                cmd.args(["--json", "--skip-git-repo-check"]);
                if self.auto_run {
                    cmd.arg("--full-auto");
                }
                if let Some(ref model) = self.model_id {
                    cmd.args(["-m", model]);
                }
                cmd.arg(prompt);
            }
            _ => {
                cmd.arg(prompt);
            }
        }
        cmd
    }

    async fn handle_ndjson_line(&mut self, line: &str, state: &mut TurnParseState) {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            return;
        };

        let parsed = match self.agent_kind {
            AgentKind::Claude => parse_claude_event(&value, state),
            AgentKind::Codex => parse_codex_event(&value, state),
            _ => ParsedLine::default(),
        };

        if let Some(new_sid) = parsed.session_id {
            if self.cli_session_id.as_deref() != Some(new_sid.as_str()) {
                self.cli_session_id = Some(new_sid.clone());
                self.send_update(None, Some(new_sid), parsed.model_id.clone())
                    .await;
            } else if let Some(model) = parsed.model_id {
                if self.model_id.as_deref() != Some(model.as_str()) {
                    self.model_id = Some(model.clone());
                    self.send_update(None, None, Some(model)).await;
                }
            }
        } else if let Some(model) = parsed.model_id {
            if self.model_id.as_deref() != Some(model.as_str()) {
                self.model_id = Some(model.clone());
                self.send_update(None, None, Some(model)).await;
            }
        }

        for event in parsed.events {
            if matches!(event, AgentEvent::TurnEnded { .. }) {
                state.saw_turn_end = true;
            }
            self.emit(event).await;
        }
    }

    fn redact(&self, mut text: String) -> String {
        for (name, secret) in &self.env_vars {
            if secret.len() >= 8 && text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), &format!("[REDACTED:{name}]"));
            }
        }
        text
    }

    async fn emit(&mut self, event: AgentEvent) {
        let event = match event {
            AgentEvent::AgentMessageChunk { text } => AgentEvent::AgentMessageChunk {
                text: self.redact(text),
            },
            AgentEvent::ThoughtChunk { text } => AgentEvent::ThoughtChunk {
                text: self.redact(text),
            },
            AgentEvent::ToolCallUpdate {
                tool_call_id,
                status,
                content,
            } => AgentEvent::ToolCallUpdate {
                tool_call_id,
                status,
                content: content.map(|c| self.redact(c)),
            },
            AgentEvent::Error { message } => AgentEvent::Error {
                message: self.redact(message),
            },
            other => other,
        };
        self.seq += 1;
        let _ = self
            .outbound
            .send(MachineToHub::AgentSessionEvent {
                session_id: self.session_id.clone(),
                seq: self.seq,
                event,
            })
            .await;
    }

    async fn send_update(
        &self,
        status: Option<AgentSessionStatus>,
        acp_session_id: Option<String>,
        current_model_id: Option<String>,
    ) {
        let _ = self
            .outbound
            .send(MachineToHub::AgentSessionUpdate {
                session_id: self.session_id.clone(),
                status,
                title: None,
                acp_session_id,
                available_models: None,
                current_model_id,
            })
            .await;
    }
}

#[derive(Default)]
struct TurnParseState {
    saw_stream_text: bool,
    saw_turn_end: bool,
}

#[derive(Default)]
struct ParsedLine {
    session_id: Option<String>,
    model_id: Option<String>,
    events: Vec<AgentEvent>,
}

fn truncate_cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Parse one NDJSON line from `claude -p --output-format stream-json --verbose --include-partial-messages`.
fn parse_claude_event(value: &Value, state: &mut TurnParseState) -> ParsedLine {
    let mut out = ParsedLine::default();
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");

    if let Some(sid) = value.get("session_id").and_then(Value::as_str) {
        if !sid.is_empty() {
            out.session_id = Some(sid.to_string());
        }
    }

    match kind {
        "system" => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(model) = value.get("model").and_then(Value::as_str) {
                    if !model.is_empty() {
                        out.model_id = Some(model.to_string());
                    }
                }
            }
        }
        "stream_event" => {
            let Some(ev) = value.get("event") else {
                return out;
            };
            let ev_type = ev.get("type").and_then(Value::as_str).unwrap_or("");
            match ev_type {
                "content_block_start" => {
                    if let Some(block) = ev.get("content_block") {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("Tool")
                                .to_string();
                            out.events.push(AgentEvent::ToolCall {
                                tool_call_id: id,
                                title: name,
                                kind: Some("tool".to_string()),
                                status: "running".to_string(),
                            });
                        }
                    }
                }
                "content_block_delta" => {
                    if let Some(delta) = ev.get("delta") {
                        match delta.get("type").and_then(Value::as_str) {
                            Some("text_delta") => {
                                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        state.saw_stream_text = true;
                                        out.events.push(AgentEvent::AgentMessageChunk {
                                            text: text.to_string(),
                                        });
                                    }
                                }
                            }
                            Some("thinking_delta") => {
                                if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        out.events.push(AgentEvent::ThoughtChunk {
                                            text: text.to_string(),
                                        });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            // If partial streaming wasn't emitted for this turn, fall back to the
            // complete assistant message content blocks.
            if !state.saw_stream_text {
                if let Some(blocks) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        out.events.push(AgentEvent::AgentMessageChunk {
                                            text: text.to_string(),
                                        });
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let id = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string();
                                let name = block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Tool")
                                    .to_string();
                                out.events.push(AgentEvent::ToolCall {
                                    tool_call_id: id,
                                    title: name,
                                    kind: Some("tool".to_string()),
                                    status: "running".to_string(),
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
            // Reset per-message flag so a second assistant turn after tool_use
            // still falls back cleanly if needed.
            state.saw_stream_text = false;
        }
        "user" => {
            // Claude emits tool_result blocks inside `type: "user"` messages.
            if let Some(blocks) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        let tool_call_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let is_error = block
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let content = extract_tool_result_text(block.get("content"))
                            .map(|s| truncate_cap(&s, TOOL_CONTENT_CAP));
                        out.events.push(AgentEvent::ToolCallUpdate {
                            tool_call_id,
                            status: Some(if is_error { "error" } else { "completed" }.to_string()),
                            content,
                        });
                    }
                }
            }
        }
        "result" => {
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_error {
                let message = value
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude returned an error")
                    .to_string();
                out.events.push(AgentEvent::Error { message });
            }
            let stop_reason = value
                .get("stop_reason")
                .and_then(Value::as_str)
                .unwrap_or(if is_error { "error" } else { "end_turn" })
                .to_string();
            out.events.push(AgentEvent::TurnEnded { stop_reason });
        }
        _ => {}
    }

    out
}

fn extract_tool_result_text(content: Option<&Value>) -> Option<String> {
    let val = content?;
    if let Some(s) = val.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = val.as_array() {
        let joined: Vec<&str> = arr
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect();
        if !joined.is_empty() {
            return Some(joined.join("\n"));
        }
    }
    None
}

/// Parse one NDJSON line from `codex exec --json`.
fn parse_codex_event(value: &Value, _state: &mut TurnParseState) -> ParsedLine {
    let mut out = ParsedLine::default();
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");

    match kind {
        "thread.started" => {
            if let Some(tid) = value.get("thread_id").and_then(Value::as_str) {
                if !tid.is_empty() {
                    out.session_id = Some(tid.to_string());
                }
            }
        }
        "item.started" => {
            if let Some(item) = value.get("item") {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("item")
                    .to_string();
                match item_type {
                    "command_execution" => {
                        let cmd = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("shell");
                        out.events.push(AgentEvent::ToolCall {
                            tool_call_id: id,
                            title: format!("Bash: {}", truncate_cap(cmd, 80)),
                            kind: Some("command".to_string()),
                            status: "running".to_string(),
                        });
                    }
                    "mcp_tool_call" => {
                        let tool = item
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("mcp");
                        out.events.push(AgentEvent::ToolCall {
                            tool_call_id: id,
                            title: tool.to_string(),
                            kind: Some("mcp".to_string()),
                            status: "running".to_string(),
                        });
                    }
                    _ => {}
                }
            }
        }
        "item.completed" => {
            if let Some(item) = value.get("item") {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("item")
                    .to_string();
                match item_type {
                    "agent_message" => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.events.push(AgentEvent::AgentMessageChunk {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.events.push(AgentEvent::ThoughtChunk {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "command_execution" => {
                        let output = item
                            .get("aggregated_output")
                            .and_then(Value::as_str)
                            .map(|s| truncate_cap(s, TOOL_CONTENT_CAP));
                        let exit_code = item.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
                        out.events.push(AgentEvent::ToolCallUpdate {
                            tool_call_id: id,
                            status: Some(
                                if exit_code == 0 { "completed" } else { "error" }.to_string(),
                            ),
                            content: output,
                        });
                    }
                    "file_change" => {
                        out.events.push(AgentEvent::ToolCall {
                            tool_call_id: id,
                            title: "File change".to_string(),
                            kind: Some("edit".to_string()),
                            status: "completed".to_string(),
                        });
                    }
                    _ => {}
                }
            }
        }
        "turn.completed" => {
            out.events.push(AgentEvent::TurnEnded {
                stop_reason: "end_turn".to_string(),
            });
        }
        "turn.failed" => {
            let msg = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex turn failed")
                .to_string();
            out.events.push(AgentEvent::Error { message: msg });
            out.events.push(AgentEvent::TurnEnded {
                stop_reason: "error".to_string(),
            });
        }
        _ => {}
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_real_claude_stream_json_sequence() {
        let mut state = TurnParseState::default();

        let init = parse_claude_event(
            &json!({
                "type": "system",
                "subtype": "init",
                "session_id": "ff17eed8-ab8d-4bc5-849a-29145fef5694",
                "model": "claude-sonnet-4-6"
            }),
            &mut state,
        );
        assert_eq!(
            init.session_id.as_deref(),
            Some("ff17eed8-ab8d-4bc5-849a-29145fef5694")
        );
        assert_eq!(init.model_id.as_deref(), Some("claude-sonnet-4-6"));

        let delta = parse_claude_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "PONG" }
                }
            }),
            &mut state,
        );
        assert_eq!(
            delta.events,
            vec![AgentEvent::AgentMessageChunk {
                text: "PONG".to_string()
            }]
        );

        // Complete assistant message should NOT duplicate already-streamed text
        let assistant = parse_claude_event(
            &json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "PONG" }] }
            }),
            &mut state,
        );
        assert!(assistant.events.is_empty());

        let result = parse_claude_event(
            &json!({
                "type": "result",
                "is_error": false,
                "stop_reason": "end_turn",
                "result": "PONG"
            }),
            &mut state,
        );
        assert_eq!(
            result.events,
            vec![AgentEvent::TurnEnded {
                stop_reason: "end_turn".to_string()
            }]
        );
    }

    #[test]
    fn parses_real_codex_json_sequence() {
        let mut state = TurnParseState::default();

        let started = parse_codex_event(
            &json!({
                "type": "thread.started",
                "thread_id": "01a21147-0141-7800-af50-fcc0b526549a"
            }),
            &mut state,
        );
        assert_eq!(
            started.session_id.as_deref(),
            Some("01a21147-0141-7800-af50-fcc0b526549a")
        );

        let msg = parse_codex_event(
            &json!({
                "type": "item.completed",
                "item": { "id": "item_4", "type": "agent_message", "text": "PONG" }
            }),
            &mut state,
        );
        assert_eq!(
            msg.events,
            vec![AgentEvent::AgentMessageChunk {
                text: "PONG".to_string()
            }]
        );

        let done = parse_codex_event(&json!({ "type": "turn.completed" }), &mut state);
        assert_eq!(
            done.events,
            vec![AgentEvent::TurnEnded {
                stop_reason: "end_turn".to_string()
            }]
        );
    }
}
