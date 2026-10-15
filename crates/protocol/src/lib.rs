pub mod composer;
use bytes::Bytes;
pub use composer::{ComposerAttachment, ComposerMessage, ComposerReceipt, ComposerStatus};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod compression;
pub mod domain;
pub mod keep_awake;
pub mod local_host;
pub mod preview;
pub mod service;

// ── Shared data types ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineInfo {
    pub id: String,
    pub name: String,
    pub os: String,
    pub home_dir: String,
    /// Production machines gate agent sessions: they default to auto_run=false
    /// so the agent asks before acting. Set via `PATCH /api/machines/:id`.
    #[serde(default)]
    pub production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalInfo {
    pub id: String,
    pub machine_id: String,
    pub title: String,
    pub cwd: String,
    #[serde(default)]
    pub title_source: TerminalTitleSource,
    #[serde(default)]
    pub workspace_group_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default = "default_reachable")]
    pub reachable: bool,
    /// Best-effort detection of an interactive confirmation on the live screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<TerminalAttention>,
    /// Set when the terminal was opened through the API with an API token
    /// (the `offdesk` CLI an agent drives) rather than by a person in an app.
    /// Hub-authoritative: machines never set it. Absent from older hubs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_by: Option<TerminalOpener>,
}

/// Who opened a terminal that a person didn't open from an app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalOpener {
    pub kind: TerminalOpenerKind,
    /// Human label: the `--label` the client passed, else the API token's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOpenerKind {
    /// An API-token client: the `offdesk` CLI, its MCP server, or a script.
    Cli,
    /// A kind added by a newer hub, so older clients still read the terminal.
    #[serde(other)]
    Other,
}

impl TerminalOpenerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalOpenerKind::Cli => "cli",
            TerminalOpenerKind::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "cli" => Some(TerminalOpenerKind::Cli),
            _ => None,
        }
    }
}

/// Longest opener label kept, in characters.
pub const TERMINAL_OPENER_LABEL_MAX: usize = 40;

/// Make a label safe to show: control characters dropped, whitespace trimmed,
/// at most `TERMINAL_OPENER_LABEL_MAX` characters. Empty labels become `None`.
pub fn clean_opener_label(label: &str) -> Option<String> {
    let without_controls: String = label.chars().filter(|c| !c.is_control()).collect();
    let cleaned: String = without_controls
        .trim()
        .chars()
        .take(TERMINAL_OPENER_LABEL_MAX)
        .collect();
    let cleaned = cleaned.trim_end();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAttention {
    Confirmation,
}

fn default_reachable() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTitleSource {
    Osc,
    Process,
    #[default]
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// File size in bytes; absent for directories and from older machines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Last modification time, ms since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

/// Capability a machine advertises when it can answer `HubToMachine::FsReadFile`.
pub const FS_READ_CAPABILITY: &str = "fs-read-v1";
/// Largest file a machine will return through `FsReadFile`. The base64 JSON
/// (~26.7 MiB) must stay under the 32 MiB hub WebSocket frame cap and the
/// paired-app transport's 32 MiB - 1 KiB response cap.
pub const FS_READ_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Why `FsReadFile` failed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FsReadErrorCode {
    NotFound,
    IsDirectory,
    TooLarge,
    PermissionDenied,
    Io,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResourceStats {
    /// CPU usage percentage (0.0 - 100.0), averaged across all cores
    pub cpu_percent: f32,
    /// Total physical memory in bytes
    pub memory_total: u64,
    /// Used physical memory in bytes
    pub memory_used: u64,
    /// Disk info
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiskInfo {
    pub mount_point: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineStatsSnapshot {
    pub machine_id: String,
    pub stats: ResourceStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlLeaseSnapshot {
    pub machine_id: String,
    pub controller_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceGroupInfo {
    pub id: String,
    pub machine_id: String,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkspaceLayoutNode {
    #[serde(rename_all = "camelCase")]
    Leaf { terminal_id: String },
    #[serde(rename_all = "camelCase")]
    Split {
        direction: WorkspaceSplitDirection,
        ratio: f64,
        first: Box<WorkspaceLayoutNode>,
        second: Box<WorkspaceLayoutNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceLayoutInfo {
    pub machine_id: String,
    pub group_key: String,
    pub root: Option<WorkspaceLayoutNode>,
    pub updated_at: i64,
}

// ── Agent sessions (ACP) ──

/// The coding agent driving a session. Each kind maps to a spawn command on
/// the machine (see `acp_agents` in machine.json for overrides).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Grok,
    Kimi,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    Starting,
    Working,
    /// The agent asked a question and is parked waiting for an answer.
    Asked,
    Idle,
    Error,
    Disconnected,
    // "done/unread" is deliberately NOT a status: the browser derives it from
    // last_seen_seq < last_event_seq while the session is Idle.
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSessionInfo {
    pub id: String,
    pub machine_id: String,
    pub agent_kind: AgentKind,
    pub cwd: String,
    /// Agent/user visible title; defaults to the last path segment of `cwd`.
    pub title: String,
    pub status: AgentSessionStatus,
    pub auto_run: bool,
    /// The ACP session id inside the agent process, set once session/new
    /// returns; needed to resume after a disconnect.
    #[serde(default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub workspace_group_id: Option<String>,
    /// Models this session can switch between; empty = the agent doesn't
    /// expose model selection (the UI renders nothing then).
    #[serde(default)]
    pub available_models: Vec<AgentModelInfo>,
    /// The model the session is currently running on, if the agent reported
    /// one. May name a model that is not in `available_models`.
    #[serde(default)]
    pub current_model_id: Option<String>,
    pub last_event_seq: u64,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentQuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
}

/// One model an agent session can run on. Normalized from the ACP shapes the
/// adapters actually expose: the standard `models.availableModels` of
/// session/new (claude/codex/grok) and kimi's `configOptions` select whose
/// category is "model".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentModelInfo {
    pub model_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// Normalized ACP session updates. The machine translates the agent-specific
/// wire format into these; the hub persists them verbatim as the session's
/// event log (the full transcript, including user prompts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Echo of user prompts, so the event log is the full transcript.
    UserMessage {
        text: String,
    },
    AgentMessageChunk {
        text: String,
    },
    ThoughtChunk {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        #[serde(default)]
        kind: Option<String>,
        status: String,
    },
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        content: Option<String>,
    },
    /// Raw JSON of ACP plan entries; the browser renders them later.
    Plan {
        entries_json: String,
    },
    Question {
        request_id: String,
        prompt: String,
        options: Vec<AgentQuestionOption>,
    },
    QuestionResolved {
        request_id: String,
    },
    TurnEnded {
        stop_reason: String,
    },
    Error {
        message: String,
    },
}

/// A node that types answers into agent runs' terminals (`HubToMachine::SendAgentKeys`).
pub const AGENT_KEYS_CAPABILITY: &str = "agent-keys-v1";

/// One key (or literal text) a node types into an agent's terminal to answer it.
/// Only these: an answer can pick an option, confirm, cancel or say something; it
/// can't send control sequences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "key", content = "value", rename_all = "snake_case")]
pub enum AgentKey {
    /// Literal text, typed as is (at most 2000 characters, no control characters).
    Text(String),
    /// A menu option's number, 1-9.
    Digit(u8),
    Enter,
    Escape,
}

impl AgentKey {
    /// Whether a node may type this key.
    pub fn is_allowed(&self) -> bool {
        match self {
            AgentKey::Text(text) => {
                !text.is_empty() && text.chars().count() <= 2000 && !text.chars().any(char::is_control)
            }
            AgentKey::Digit(digit) => (1..=9).contains(digit),
            AgentKey::Enter | AgentKey::Escape => true,
        }
    }
}

/// A person's answer to a run's open request (`POST /api/agent-runs/{id}/answer`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentAnswer {
    /// The request being answered; refused if it's no longer the open one.
    pub request_id: String,
    /// An approval: yes or no.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approve: Option<bool>,
    /// A question's option, by id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    /// Free text: a question in your own words, or the input it waits for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The answering device, which must hold the machine's control lease.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

/// A node that starts agents itself (`HubToMachine::CreateTerminal` with `agent_start`).
pub const AGENT_START_CAPABILITY: &str = "agent-start-v1";

/// Longest first message for a started agent.
pub const MAX_START_PROMPT_BYTES: usize = 32 * 1024;
/// Longest label or external reference of a started run.
pub const MAX_START_LABEL_CHARS: usize = 200;

/// The agent's own permission mode for a started run. Only modes in which it still
/// asks or stays sandboxed: nothing here skips its permission prompts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermissionMode {
    /// It asks before edits and commands (Claude `default`; Codex in a read-only
    /// sandbox, asking for anything more).
    Ask,
    /// Edits in its folder go ahead, commands still ask (Claude `acceptEdits`; Codex in
    /// a workspace-write sandbox, asking for anything more).
    AcceptEdits,
    /// It plans and changes nothing until you agree (Claude only).
    Plan,
}

impl AgentPermissionMode {
    /// The agent's own flags for this mode.
    pub fn args(self, agent: RunAgent) -> Result<&'static [&'static str], &'static str> {
        match (agent, self) {
            (RunAgent::Claude, AgentPermissionMode::Ask) => Ok(&["--permission-mode", "default"]),
            (RunAgent::Claude, AgentPermissionMode::AcceptEdits) => {
                Ok(&["--permission-mode", "acceptEdits"])
            }
            (RunAgent::Claude, AgentPermissionMode::Plan) => Ok(&["--permission-mode", "plan"]),
            (RunAgent::Codex, AgentPermissionMode::Ask) => {
                Ok(&["--sandbox", "read-only", "--ask-for-approval", "on-request"])
            }
            (RunAgent::Codex, AgentPermissionMode::AcceptEdits) => {
                Ok(&["--sandbox", "workspace-write", "--ask-for-approval", "on-request"])
            }
            (RunAgent::Codex, AgentPermissionMode::Plan) => Err("Codex has no plan mode"),
            (RunAgent::Other, _) => Err("Only claude and codex can be started"),
        }
    }
}

/// Start a coding agent in a new terminal (`POST /api/agent-runs`). The hub builds the
/// command from these fields: it never takes a command line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartAgentRun {
    pub machine_id: String,
    pub agent: RunAgent,
    pub cwd: String,
    /// Its first message, passed as one argument (never through the shell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// A name for the run, shown beside it ("fix tax rounding").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The caller's own reference (an issue, a task), given to the agent as
    /// `OFFDESK_EXTERNAL_REF`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<String>,
    /// None: the agent's own settings decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<AgentPermissionMode>,
    /// The calling device, which must hold the machine's control lease.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

/// A started run and the terminal it runs in (`POST /api/agent-runs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartedAgentRun {
    pub run: AgentRunInfo,
    pub terminal: TerminalInfo,
}

/// What a node needs to start an agent in the terminal it creates. The node builds the
/// command line itself; the prompt is passed as one argument, never parsed by a shell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentStart {
    /// Given to the agent as `OFFDESK_RUN_ID`.
    pub run_id: String,
    pub agent: RunAgent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<AgentPermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<String>,
    /// The folders a scoped token may start in: the node refuses a `cwd` whose real
    /// path (symlinks resolved) isn't inside one of them. None: anywhere. Needs
    /// `AGENT_START_DIRS_CAPABILITY`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_dirs: Option<Vec<String>>,
}

/// A node that checks `AgentStart::allowed_dirs` against real paths.
pub const AGENT_START_DIRS_CAPABILITY: &str = "agent-start-dirs-v1";

/// What an API token may do (docs/plans/2026-10-14-agent-runs-external-access.md, B1).
/// `Full` is everything a person can do: terminals, input, machines. The `runs:*`
/// scopes reach only agent runs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum TokenScope {
    /// Read runs, their requests and history, as far as the content level shows.
    #[serde(rename = "runs:read")]
    RunsRead,
    /// Answer questions and input requests.
    #[serde(rename = "runs:answer")]
    RunsAnswer,
    /// Answer approvals: say yes to a command or tool call.
    #[serde(rename = "runs:approve")]
    RunsApprove,
    /// Start agents in the allowed folders, with a prompt.
    #[serde(rename = "runs:start")]
    RunsStart,
    /// Send a running agent a message (no endpoint yet).
    #[serde(rename = "runs:message")]
    RunsMessage,
    #[serde(rename = "full")]
    Full,
}

impl TokenScope {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenScope::RunsRead => "runs:read",
            TokenScope::RunsAnswer => "runs:answer",
            TokenScope::RunsApprove => "runs:approve",
            TokenScope::RunsStart => "runs:start",
            TokenScope::RunsMessage => "runs:message",
            TokenScope::Full => "full",
        }
    }
}

/// How much of a run a scoped token sees. Terminal output is never shown at any level.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ContentLevel {
    /// Status, progress counts, machine, agent, folder, times, label and reference.
    #[default]
    Metadata,
    /// Also what a request asks: its text, options and command.
    Requests,
    /// Also the agent's own notes and handover, and the step it's on.
    Notes,
}

/// A scoped token's scopes and limits. A token without one (`None` in storage) is full.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenAccess {
    pub scopes: Vec<TokenScope>,
    /// The machines it may reach; None: every machine except production ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<String>>,
    /// Production machines too, when `machines` is None.
    #[serde(default)]
    pub include_production: bool,
    /// Where `runs:start` may start agents (and below); required with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirs: Option<Vec<String>>,
    /// The agents it may start; None: any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<RunAgent>>,
    #[serde(default)]
    pub content: ContentLevel,
    /// At most this many starts in any hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_starts_per_hour: Option<u32>,
    /// At most this many answers (and approvals) in any hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_answers_per_hour: Option<u32>,
}

impl TokenAccess {
    pub fn is_full(&self) -> bool {
        self.scopes.contains(&TokenScope::Full)
    }

    pub fn allows(&self, scope: TokenScope) -> bool {
        self.is_full() || self.scopes.contains(&scope)
    }

    pub fn allows_machine(&self, machine_id: &str, production: bool) -> bool {
        match &self.machines {
            Some(machines) => machines.iter().any(|m| m == machine_id),
            None => self.include_production || !production,
        }
    }

    pub fn allows_agent(&self, agent: RunAgent) -> bool {
        self.agents.as_ref().is_none_or(|agents| agents.contains(&agent))
    }

    /// Checks a token's access as given when it's created: known scopes, and folders
    /// for `runs:start` that are absolute (or `~/…`) without `..`.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.scopes.is_empty() {
            return Err("Choose what the token may do");
        }
        if self.allows(TokenScope::RunsStart) && !self.is_full() {
            let dirs = self.dirs.as_deref().unwrap_or_default();
            if dirs.is_empty() {
                return Err("A token that starts agents needs the folders it may start in");
            }
            if !dirs.iter().all(|dir| is_plain_dir(dir)) {
                return Err("Folders are absolute paths (or ~/…) without '..'");
            }
        }
        Ok(())
    }

    /// Whether `cwd` is inside one of the allowed folders, by its text: absolute (or
    /// `~/…`), no `..`. The node then checks real paths, which catches symlinks.
    pub fn allows_dir(&self, cwd: &str) -> bool {
        if !is_plain_dir(cwd) {
            return false;
        }
        let cwd = cwd.trim_end_matches('/');
        self.dirs.as_deref().unwrap_or_default().iter().any(|dir| {
            let dir = dir.trim_end_matches('/');
            dir.is_empty() || cwd == dir || cwd.starts_with(&format!("{dir}/"))
        })
    }
}

/// An absolute path (or `~`, `~/…`) with no `.` or `..` parts.
fn is_plain_dir(path: &str) -> bool {
    let rest = if path == "~" {
        ""
    } else if let Some(rest) = path.strip_prefix("~/") {
        rest
    } else if let Some(rest) = path.strip_prefix('/') {
        rest
    } else {
        return false;
    };
    !path.chars().any(char::is_control)
        && rest.split('/').all(|part| part != ".." && part != ".")
}

impl AgentStart {
    /// A prompt as it will be passed: line endings normalized to `\n`, trimmed; empty
    /// is none. Terminal controls (ESC, NUL, paste markers) are refused, and so is a
    /// leading `-`, which the agent's CLI would read as an option.
    pub fn normalize_prompt(text: &str) -> Result<Option<String>, &'static str> {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        if text.len() > MAX_START_PROMPT_BYTES {
            return Err("The prompt is too long (32 KB at most)");
        }
        if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
            return Err("The prompt contains control characters");
        }
        if text.starts_with('-') {
            return Err("The prompt can't start with '-'");
        }
        Ok(Some(text.to_string()))
    }

    /// A label or external reference: one line, trimmed, at most 200 characters.
    pub fn normalize_label(text: &str) -> Result<Option<String>, &'static str> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        if text.chars().count() > MAX_START_LABEL_CHARS || text.chars().any(char::is_control) {
            return Err("Labels and references are one line of at most 200 characters");
        }
        Ok(Some(text.to_string()))
    }

    /// Checks everything a node relies on: a known agent and mode, a run id that's a
    /// UUID, and a prompt and reference as `normalize_*` leaves them.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.agent, RunAgent::Claude | RunAgent::Codex) {
            return Err("Only claude and codex can be started");
        }
        if uuid::Uuid::parse_str(&self.run_id).is_err() {
            return Err("Invalid run id");
        }
        if let Some(mode) = self.permission_mode {
            mode.args(self.agent)?;
        }
        if let Some(prompt) = &self.prompt {
            if Self::normalize_prompt(prompt)?.as_deref() != Some(prompt.as_str()) {
                return Err("The prompt isn't normalized");
            }
        }
        if let Some(reference) = &self.external_ref {
            if Self::normalize_label(reference)?.as_deref() != Some(reference.as_str()) {
                return Err("The reference isn't normalized");
            }
        }
        Ok(())
    }
}

/// The Claude Code hook events Offdesk listens to (`offdesk agents hooks install`, and
/// the settings a node passes to a Claude it starts).
pub const CLAUDE_HOOK_EVENTS: [&str; 8] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
];

/// A path as one shell word: bare when it's only safe characters, else single-quoted.
pub fn shell_word(path: &str) -> String {
    if !path.is_empty() && path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

/// The hook command Claude Code runs for `event`; `cli` is the `offdesk` program.
pub fn claude_hook_command(cli: &str, event: &str) -> String {
    format!("{} hook claude {event}", shell_word(cli))
}

/// Whether a Claude Code hook handler is one of Offdesk's.
pub fn is_offdesk_claude_hook(handler: &serde_json::Value) -> bool {
    handler
        .get("command")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|command| command.contains(" hook claude ") && command.contains("offdesk"))
}

/// One hook group per event in `CLAUDE_HOOK_EVENTS`, running `offdesk hook claude <event>`.
pub fn claude_hook_groups(cli: &str) -> Vec<(&'static str, serde_json::Value)> {
    CLAUDE_HOOK_EVENTS
        .iter()
        .map(|event| {
            (
                *event,
                serde_json::json!({
                    "hooks": [{ "type": "command", "command": claude_hook_command(cli, event), "timeout": 5 }]
                }),
            )
        })
        .collect()
}

/// A coding agent CLI a node found, for choosing what to start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledAgent {
    pub agent: RunAgent,
    /// What `<agent> --version` printed (first line), when it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Where the node listens for agents' hooks and reports (`offdesk hook`, `offdesk run`):
/// a Unix socket in the config directory, readable only by its user.
pub fn agent_socket_path() -> std::path::PathBuf {
    agent_socket_path_in(&config_dir(), &std::env::temp_dir())
}

/// Unix socket paths are limited to about 104 bytes (macOS): a config directory too
/// deep for it gets a socket in `temp` named after it, the same for the node and CLI.
pub fn agent_socket_path_in(config: &std::path::Path, temp: &std::path::Path) -> std::path::PathBuf {
    const MAX_SOCKET_PATH: usize = 100;
    let path = config.join("agent.sock");
    if path.as_os_str().len() < MAX_SOCKET_PATH {
        return path;
    }
    // FNV-1a: stable across builds, unlike the std hasher
    let hash = config
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3));
    temp.join(format!("offdesk-agent-{hash:016x}.sock"))
}

/// One line a hook or report writes to the node's agent socket. The node finds the
/// terminal from the tmux pane the agent runs in, so agents need no token or id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalAgentReport {
    /// `$TMUX_PANE` of the agent's process, e.g. "%12".
    pub tmux_pane: String,
    /// The tmux socket from `$TMUX`, so a pane of another tmux server (with the same
    /// pane number) is never taken for one of the node's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_socket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<RunAgent>,
    pub source: String,
    pub signal: AgentSignal,
}

/// The coding agent of an agent run: a CLI in a terminal (docs/plans/2026-10-14-agent-runs.md).
/// Distinct from `AgentKind`, which names ACP adapters.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RunAgent {
    Claude,
    Codex,
    /// An agent added by a newer hub or node, so older peers still read the run.
    #[serde(other)]
    Other,
}

impl RunAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            RunAgent::Claude => "claude",
            RunAgent::Codex => "codex",
            RunAgent::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> RunAgent {
        match name {
            "claude" => RunAgent::Claude,
            "codex" => RunAgent::Codex,
            _ => RunAgent::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Starting,
    Working,
    /// A request (approval, question, input) waits on a person.
    Waiting,
    /// A turn ended; the agent waits for its next instruction. Not finished.
    Idle,
    /// The agent process exited (or reported it finished).
    Done,
    Error,
    /// Its terminal closed or its machine went away; state unknown.
    Gone,
    #[serde(other)]
    Other,
}

impl AgentRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRunStatus::Starting => "starting",
            AgentRunStatus::Working => "working",
            AgentRunStatus::Waiting => "waiting",
            AgentRunStatus::Idle => "idle",
            AgentRunStatus::Done => "done",
            AgentRunStatus::Error => "error",
            AgentRunStatus::Gone => "gone",
            AgentRunStatus::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> AgentRunStatus {
        match name {
            "starting" => AgentRunStatus::Starting,
            "working" => AgentRunStatus::Working,
            "waiting" => AgentRunStatus::Waiting,
            "idle" => AgentRunStatus::Idle,
            "done" => AgentRunStatus::Done,
            "error" => AgentRunStatus::Error,
            "gone" => AgentRunStatus::Gone,
            _ => AgentRunStatus::Other,
        }
    }

    /// Done, Error and Gone end a run.
    pub fn ends_run(self) -> bool {
        matches!(self, AgentRunStatus::Done | AgentRunStatus::Error | AgentRunStatus::Gone)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRequestKind {
    /// Whether to run a tool or command.
    Approval,
    /// A question the agent asked, usually with options.
    Question,
    /// The agent stopped for free-form input.
    Input,
    #[serde(other)]
    Other,
}

impl AgentRequestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRequestKind::Approval => "approval",
            AgentRequestKind::Question => "question",
            AgentRequestKind::Input => "input",
            AgentRequestKind::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> AgentRequestKind {
        match name {
            "approval" => AgentRequestKind::Approval,
            "question" => AgentRequestKind::Question,
            "input" => AgentRequestKind::Input,
            _ => AgentRequestKind::Other,
        }
    }
}

/// Something a run waits on a person for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRunRequest {
    pub id: String,
    pub kind: AgentRequestKind,
    /// The question or command, when its source gives one. Screen recognition never
    /// does (terminal text stays out of the status protocol).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AgentQuestionOption>,
    /// Where it was recognized: "screen"; later "hooks", "acp", "report".
    pub source: String,
    pub created_at_ms: i64,
    /// When a person's answer was typed into the terminal. The request stays open
    /// until the agent's own signals (hooks, the screen) show it moved on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_sent_at_ms: Option<i64>,
}

/// How far along a run is, from the agent's own task list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentRunProgress {
    pub done: u32,
    pub total: u32,
    /// The step in progress, when the agent names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentReportKind {
    /// Progress worth telling a person.
    Note,
    /// It stopped and needs help.
    Blocked,
    /// It says the work is finished.
    Finished,
    #[serde(other)]
    Other,
}

impl AgentReportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentReportKind::Note => "note",
            AgentReportKind::Blocked => "blocked",
            AgentReportKind::Finished => "finished",
            AgentReportKind::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> AgentReportKind {
        match name {
            "note" => AgentReportKind::Note,
            "blocked" => AgentReportKind::Blocked,
            "finished" => AgentReportKind::Finished,
            _ => AgentReportKind::Other,
        }
    }
}

/// The latest thing a run's agent reported about itself (`offdesk run note|blocked|done`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRunReport {
    pub kind: AgentReportKind,
    pub text: String,
    /// A link it handed over, e.g. a pull request. Stored as given; never fetched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    pub at_ms: i64,
}

/// What a running agent says about itself, through its hooks or its own report
/// (`offdesk hook …`, `offdesk run …`), via the node's local socket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "signal", rename_all = "snake_case")]
pub enum AgentSignal {
    /// It's working (a prompt arrived, a tool runs, a request was answered).
    Working,
    /// A turn ended; it waits for its next instruction.
    Idle,
    /// It waits on a person: an approval, a question (often with options), or input.
    Waiting {
        request: AgentRequestKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<AgentQuestionOption>,
    },
    /// Its task list changed.
    Progress(AgentRunProgress),
    /// A note, that it's blocked, or that it finished.
    Report {
        kind: AgentReportKind,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        link: Option<String>,
    },
    /// A signal a newer node knows.
    #[serde(other)]
    Other,
}

/// One agent process's life in one terminal: a run (docs/plans/2026-10-14-agent-runs.md).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRunInfo {
    pub id: String,
    pub machine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub agent: RunAgent,
    pub cwd: String,
    pub status: AgentRunStatus,
    /// The open request, while the run is Waiting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<AgentRunRequest>,
    /// From the agent's task list, when its hooks report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<AgentRunProgress>,
    /// The latest note, blocked or finished report from the agent itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<AgentRunReport>,
    /// The name it was started with (`POST /api/agent-runs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The starter's own reference (an issue, a task).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrowserStateSnapshot {
    pub snapshot_seq: u64,
    pub last_focused_terminal_id: Option<String>,
    pub machines: Vec<MachineInfo>,
    pub terminals: Vec<TerminalInfo>,
    pub workspace_groups: Vec<WorkspaceGroupInfo>,
    pub workspace_layouts: Vec<WorkspaceLayoutInfo>,
    pub machine_stats: Vec<MachineStatsSnapshot>,
    pub control_leases: Vec<ControlLeaseSnapshot>,
    #[serde(default)]
    pub agent_sessions: Vec<AgentSessionInfo>,
    /// session_id → last_seen_seq for the requesting user (cross-device read sync).
    #[serde(default)]
    pub agent_session_seen: HashMap<String, u64>,
    /// Live agent browsers on the user's online machines.
    #[serde(default)]
    pub agent_browsers: Vec<AgentBrowserInfo>,
    /// Agent runs on the user's machines: open ones and those ended in the last day.
    #[serde(default)]
    pub agent_runs: Vec<AgentRunInfo>,
}

// ── Hub → Machine messages ──

/// One agent browser = one tab of the node's headless Chromium.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentBrowserInfo {
    pub id: String,
    /// Filled in by the hub; the node leaves it unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    pub url: String,
    pub title: String,
    /// Terminal the browser was opened from (set by `offdesk browser open`
    /// when it runs inside an offdesk terminal on the same machine).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener_terminal_id: Option<String>,
    /// Who drives the page. Owned by the hub (the node never sets it).
    #[serde(default)]
    pub controller: AgentBrowserController,
    /// While `controller` is `Human`: the viewer device that took control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_device_id: Option<String>,
    /// While `controller` is `Human`: when it took control (ms since epoch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_since: Option<i64>,
    /// The agent is asking a person for help; cleared when a person hands
    /// control back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<AgentBrowserHandoff>,
    /// The agent took control back from a person (or from a pending
    /// handoff). Owned by the hub; cleared when a person takes control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reclaimed: Option<AgentBrowserReclaim>,
    /// The browser whose page opened this one (a popup or a `target=_blank`
    /// link). Set by the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener_browser_id: Option<String>,
    /// Back / forward / loading state for the toolbar. Set by the node;
    /// absent from older nodes, which cannot navigate for a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav: Option<AgentBrowserNav>,
    /// A JavaScript dialog the page is waiting on. Set by the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog: Option<AgentBrowserDialog>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentBrowserNav {
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// The main frame is loading.
    pub loading: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentBrowserDialogKind {
    Alert,
    Confirm,
    Prompt,
    /// "Leave site?": accepting leaves, dismissing stays.
    Beforeunload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBrowserDialog {
    pub kind: AgentBrowserDialogKind,
    pub message: String,
    /// What a `prompt` is prefilled with.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub default_prompt: String,
}

/// Longest dialog message the node reports.
pub const AGENT_BROWSER_MAX_DIALOG_MESSAGE: usize = 2_000;
/// Longest URL a person can navigate to.
pub const AGENT_BROWSER_MAX_URL: usize = 8_192;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentBrowserController {
    #[default]
    Agent,
    Human,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBrowserHandoff {
    pub reason: String,
    /// ms since epoch
    pub requested_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBrowserReclaim {
    pub reason: String,
    /// ms since epoch
    pub at: i64,
    /// The device that lost control, when a person had it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

/// CSS viewport of every agent browser; input coordinates live in it.
pub const AGENT_BROWSER_VIEWPORT_WIDTH: u32 = 1280;
pub const AGENT_BROWSER_VIEWPORT_HEIGHT: u32 = 800;
/// Longest `text` input event accepted.
pub const AGENT_BROWSER_MAX_INPUT_TEXT: usize = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MouseAction {
    Move,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyAction {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NavAction {
    Back,
    Forward,
    Reload,
    Stop,
    /// Load `url`.
    Goto,
}

fn one() -> u32 {
    1
}

/// A human's input to an agent browser (from a viewer). Coordinates are CSS
/// px in the 1280x800 viewport; `modifiers` is the CDP bitmask
/// (Alt 1, Ctrl 2, Meta 4, Shift 8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentBrowserInputEvent {
    Mouse {
        action: MouseAction,
        x: f64,
        y: f64,
        #[serde(default)]
        button: MouseButton,
        #[serde(default)]
        buttons: u32,
        #[serde(default = "one")]
        click_count: u32,
        #[serde(default)]
        modifiers: u32,
    },
    Wheel {
        x: f64,
        y: f64,
        #[serde(default)]
        delta_x: f64,
        #[serde(default)]
        delta_y: f64,
        #[serde(default)]
        modifiers: u32,
    },
    /// A browser `KeyboardEvent`.
    Key {
        action: KeyAction,
        key: String,
        #[serde(default)]
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default)]
        modifiers: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_code: Option<u32>,
    },
    /// Insert text as is (IME commit, paste).
    Text { text: String },
    /// The toolbar: back, forward, reload, stop, or load `url` (`goto`).
    Navigate {
        action: NavAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// Answer the JavaScript dialog the page is showing.
    Dialog {
        accept: bool,
        /// The answer to a `prompt`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_text: Option<String>,
    },
}

impl AgentBrowserInputEvent {
    /// Clamp coordinates into the viewport and bound field sizes; `None`
    /// when the event is not acceptable (non-finite numbers, oversized text).
    pub fn sanitized(self) -> Option<Self> {
        let max_x = (AGENT_BROWSER_VIEWPORT_WIDTH - 1) as f64;
        let max_y = (AGENT_BROWSER_VIEWPORT_HEIGHT - 1) as f64;
        let coord = |v: f64, max: f64| v.is_finite().then(|| v.clamp(0.0, max));
        let delta = |v: f64| v.is_finite().then(|| v.clamp(-10_000.0, 10_000.0));
        let modifiers = |m: u32| m & 0xf;
        match self {
            Self::Mouse {
                action,
                x,
                y,
                button,
                buttons,
                click_count,
                modifiers: m,
            } => Some(Self::Mouse {
                action,
                x: coord(x, max_x)?,
                y: coord(y, max_y)?,
                button,
                buttons: buttons & 0x1f,
                click_count: click_count.clamp(1, 3),
                modifiers: modifiers(m),
            }),
            Self::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                modifiers: m,
            } => Some(Self::Wheel {
                x: coord(x, max_x)?,
                y: coord(y, max_y)?,
                delta_x: delta(delta_x)?,
                delta_y: delta(delta_y)?,
                modifiers: modifiers(m),
            }),
            Self::Key {
                action,
                key,
                code,
                text,
                modifiers: m,
                key_code,
            } => {
                if key.is_empty()
                    || key.chars().count() > 32
                    || code.chars().count() > 32
                    || text.as_ref().is_some_and(|t| t.chars().count() > 8)
                    || key_code.is_some_and(|k| k > 255)
                {
                    return None;
                }
                Some(Self::Key {
                    action,
                    key,
                    code,
                    text,
                    modifiers: modifiers(m),
                    key_code,
                })
            }
            Self::Text { text } => (!text.is_empty()
                && text.chars().count() <= AGENT_BROWSER_MAX_INPUT_TEXT)
                .then_some(Self::Text { text }),
            Self::Navigate {
                action: NavAction::Goto,
                url,
            } => {
                let url = url?.trim().to_string();
                (!url.is_empty() && url.len() <= AGENT_BROWSER_MAX_URL).then_some(Self::Navigate {
                    action: NavAction::Goto,
                    url: Some(url),
                })
            }
            Self::Navigate { action, .. } => Some(Self::Navigate { action, url: None }),
            Self::Dialog {
                accept,
                prompt_text,
            } => (prompt_text
                .as_ref()
                .is_none_or(|t| t.chars().count() <= AGENT_BROWSER_MAX_INPUT_TEXT))
            .then_some(Self::Dialog {
                accept,
                prompt_text,
            }),
        }
    }
}

/// A string that never shows up in `Debug` output (logs, panics, test
/// failures). Serializes as the plain string.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Drop for Secret {
    /// Best effort: overwrite the bytes before the memory is freed.
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        for byte in bytes.iter_mut() {
            // SAFETY: `byte` is a valid, aligned, exclusive reference.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

/// Base64 text too big to print: its `Debug` shows only the length, so a
/// 20 MB upload never lands in a log.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Base64Data(String);

impl Base64Data {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Base64Data {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{} bytes base64>", self.0.len())
    }
}

/// One local file sent with `AgentBrowserCommand::Upload`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UploadFile {
    /// The file's base name; the node sanitizes it again.
    pub name: String,
    pub data: Base64Data,
}

/// Commands an agent can run against an agent browser. Replies:
/// Open/Goto -> `AgentBrowserInfo`; List -> `Vec<AgentBrowserInfo>`;
/// Snapshot -> `{"snapshot": string}`; Screenshot -> `{"png_base64": string}`;
/// Wait -> `{"matched": bool, "message"?: string}` (a timeout is not an
/// error); Upload -> `{"files": ["name", ...], "input": "<the input used>"}`;
/// Dialog -> `{"dialog": AgentBrowserDialog}` (the one answered); the rest ->
/// `{}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentBrowserCommand {
    Open {
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        opener_terminal_id: Option<String>,
    },
    List,
    Close {
        browser_id: String,
    },
    Goto {
        browser_id: String,
        url: String,
    },
    Snapshot {
        browser_id: String,
    },
    /// Click by `ref` (from a snapshot) or by visible `text`; exactly one of
    /// the two. Replies `{}` for a ref, `{"clicked": "<tag> \"<text>\""}` for
    /// text.
    Click {
        browser_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// Fill a saved login into the page's username / password fields, in any
    /// frame whose registrable domain is in `allowed_domains`. Replies
    /// `{"filled": ["username","password"], "frames": ["host", ...],
    /// "submitted": bool}`; never the values.
    Login {
        browser_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<Secret>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password: Option<Secret>,
        allowed_domains: Vec<String>,
        #[serde(default)]
        submit: bool,
    },
    Fill {
        browser_id: String,
        r#ref: String,
        text: String,
    },
    /// Put local files into a page's `<input type=file>`. With a `ref` that
    /// is the input, it is used; with any other `ref` (an upload button) the
    /// ref is clicked and the file chooser it opens is answered; without a
    /// `ref` the page must have exactly one file input.
    Upload {
        browser_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        files: Vec<UploadFile>,
    },
    Press {
        browser_id: String,
        key: String,
    },
    Wait {
        browser_id: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        url_regex: Option<String>,
        #[serde(default)]
        idle_ms: Option<u64>,
        timeout_ms: u64,
    },
    Screenshot {
        browser_id: String,
        #[serde(default)]
        full_page: bool,
    },
    /// Answer the JavaScript dialog (alert, confirm, prompt, leave page) the
    /// page is showing. While one is open, commands that read or act on the
    /// page fail and say so.
    Dialog {
        browser_id: String,
        accept: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_text: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HubToMachine {
    #[serde(rename = "open_preview_stream")]
    OpenPreviewStream {
        stream_id: String,
        ticket: String,
        port: u16,
        address_family: preview::AddressFamily,
        expires_at: i64,
    },
    #[serde(rename = "attach_composer")]
    AttachComposer {
        request_id: String,
        attach_id: String,
        message: ComposerMessage,
    },
    #[serde(rename = "create_terminal")]
    CreateTerminal {
        request_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        startup_command: Option<String>,
        /// Start this agent in the new terminal (nodes with `AGENT_START_CAPABILITY`;
        /// the hub never sends it with `startup_command`).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        agent_start: Option<AgentStart>,
    },
    #[serde(rename = "destroy_terminal")]
    DestroyTerminal { terminal_id: String },
    #[serde(rename = "fs_list")]
    FsListDir {
        request_id: String,
        path: String,
        #[serde(default)]
        show_hidden: bool,
    },
    /// Read one file (<= `FS_READ_MAX_BYTES`). Needs `FS_READ_CAPABILITY`.
    #[serde(rename = "fs_read_file")]
    FsReadFile {
        request_id: String,
        path: String,
        /// Base for relative paths.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    #[serde(rename = "auth_result")]
    AuthResult { ok: bool, message: Option<String> },
    #[serde(rename = "check_foreground_process")]
    CheckForegroundProcess {
        request_id: String,
        terminal_id: String,
    },
    /// Drive an agent browser (headless Chromium owned by the node).
    #[serde(rename = "agent_browser")]
    AgentBrowser {
        request_id: String,
        command: AgentBrowserCommand,
    },
    /// Start (or restart with new parameters) the live JPEG screencast of an
    /// agent browser. The node sends one frame, then waits for
    /// `AgentBrowserFrameAck` before the next.
    #[serde(rename = "agent_browser_screencast_start")]
    AgentBrowserScreencastStart {
        browser_id: String,
        max_width: u32,
        max_height: u32,
        quality: u32,
        /// Orders start/stop pairs that may arrive out of order: the node
        /// ignores one older than the newest it has seen. 0 (an old hub)
        /// means "apply in arrival order".
        #[serde(default)]
        epoch: u64,
    },
    #[serde(rename = "agent_browser_screencast_stop")]
    AgentBrowserScreencastStop {
        browser_id: String,
        #[serde(default)]
        epoch: u64,
    },
    /// The hub (a viewer) has taken the last screencast frame.
    #[serde(rename = "agent_browser_frame_ack")]
    AgentBrowserFrameAck { browser_id: String },
    /// A person's mouse / keyboard / text input for an agent browser. Sent
    /// only while a person controls it; the node applies them in order.
    #[serde(rename = "agent_browser_input")]
    AgentBrowserInput {
        browser_id: String,
        event: AgentBrowserInputEvent,
    },
    #[serde(rename = "open_attach")]
    OpenAttach {
        attach_id: String,
        terminal_id: String,
        cols: u16,
        rows: u16,
        /// deflate-raw-v1: compress this attach's output stream. Set by the
        /// hub only when the browser requested compression AND the machine
        /// declared the capability; old machines deserialize fine (serde
        /// default) and old hubs never set it.
        #[serde(default)]
        compress: bool,
    },
    #[serde(rename = "close_attach")]
    CloseAttach { attach_id: String },
    /// Ask tmux to fully redraw the client behind this attach. Sent by the
    /// hub after it had to drop output frames for a slow browser: the hub is
    /// byte-stateless, so a full redraw is the only way to repair the
    /// client's screen. Older machines fail to parse the unknown variant and
    /// simply skip it.
    #[serde(rename = "refresh_attach")]
    RefreshAttach { attach_id: String },
    #[serde(rename = "attach_input")]
    AttachInput { attach_id: String, data: String },
    /// Type an answer into an agent run's terminal (nodes with AGENT_KEYS_CAPABILITY).
    #[serde(rename = "send_agent_keys")]
    SendAgentKeys {
        terminal_id: String,
        keys: Vec<AgentKey>,
    },
    #[serde(rename = "attach_resize")]
    AttachResize {
        attach_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "attach_image_paste")]
    AttachImagePaste {
        attach_id: String,
        data: String,
        mime: String,
        filename: String,
    },
    #[serde(rename = "ping")]
    Ping,
    /// Start an agent session on the machine. With `resume_acp_session_id`
    /// set, the machine tries ACP session/load first and falls back to a
    /// fresh session when the agent no longer has that history.
    #[serde(rename = "agent_session_start")]
    AgentSessionStart {
        session_id: String,
        agent_kind: AgentKind,
        cwd: String,
        auto_run: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resume_acp_session_id: Option<String>,
        /// Model requested at create time. ACP session/new has no model
        /// param, so the machine applies this via session/set_model right
        /// after the session is ready, before flushing queued prompts.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        model_id: Option<String>,
    },
    #[serde(rename = "agent_session_prompt")]
    AgentSessionPrompt { session_id: String, text: String },
    #[serde(rename = "agent_session_answer")]
    AgentSessionAnswer {
        session_id: String,
        request_id: String,
        #[serde(default)]
        option_id: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    /// Cancel the current turn (ACP session/cancel).
    #[serde(rename = "agent_session_cancel")]
    AgentSessionCancel { session_id: String },
    /// Switch the session's model (ACP session/set_model). Agents that never
    /// reported models reject this locally with an Error event.
    #[serde(rename = "agent_session_set_model")]
    AgentSessionSetModel {
        session_id: String,
        model_id: String,
    },
    /// Terminate the agent process.
    #[serde(rename = "agent_session_kill")]
    AgentSessionKill { session_id: String },
}

// ── Machine → Hub messages ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MachineToHub {
    #[serde(rename = "composer_result")]
    ComposerResult {
        request_id: String,
        receipt: ComposerReceipt,
    },
    #[serde(rename = "register")]
    Register {
        machine_id: String,
        machine_secret: String,
        name: String,
        os: String,
        home_dir: String,
        /// Optional capability list (e.g. `DEFLATE_RAW_V1`). Old hubs ignore
        /// it; old machines omit it and deserialize fine on new hubs.
        #[serde(default)]
        capabilities: Vec<String>,
        /// The node's own version (`offdesk-node --version`), so the hub can
        /// show which machines are behind. Absent from nodes before 0.23.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    #[serde(rename = "terminal_created")]
    TerminalCreated {
        request_id: String,
        terminal_id: String,
        title: String,
        cwd: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal_create_error")]
    TerminalCreateError { request_id: String, error: String },
    #[serde(rename = "terminal_destroyed")]
    TerminalDestroyed { terminal_id: String },
    #[serde(rename = "fs_list_result")]
    FsListResult {
        request_id: String,
        entries: Vec<DirEntry>,
    },
    #[serde(rename = "fs_list_error")]
    FsListError { request_id: String, error: String },
    #[serde(rename = "fs_read_result")]
    FsReadResult {
        request_id: String,
        name: String,
        /// Resolved absolute path.
        path: String,
        mime: String,
        size: u64,
        data_base64: String,
    },
    #[serde(rename = "fs_read_error")]
    FsReadError {
        request_id: String,
        code: FsReadErrorCode,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        /// Resolved absolute path, when resolution got that far.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    #[serde(rename = "existing_terminals")]
    ExistingTerminals { terminals: Vec<TerminalInfo> },
    #[serde(rename = "resource_stats")]
    ResourceStats { stats: ResourceStats },
    #[serde(rename = "foreground_process_result")]
    ForegroundProcessResult {
        request_id: String,
        has_foreground_process: bool,
        process_name: Option<String>,
    },
    /// Reply to `HubToMachine::AgentBrowser`. Exactly one of `data` / `error`
    /// is set; `data` shape depends on the command (see `AgentBrowserCommand`).
    #[serde(rename = "agent_browser_result")]
    AgentBrowserResult {
        request_id: String,
        #[serde(default)]
        data: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "agent_browser_created")]
    AgentBrowserCreated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_updated")]
    AgentBrowserUpdated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_destroyed")]
    AgentBrowserDestroyed { browser_id: String },
    /// Sent on every (re)connect, like `ExistingTerminals`.
    #[serde(rename = "existing_agent_browsers")]
    ExistingAgentBrowsers { browsers: Vec<AgentBrowserInfo> },
    #[serde(rename = "attach_died")]
    AttachDied { attach_id: String, reason: String },
    #[serde(rename = "terminal_died")]
    TerminalDied { terminal_id: String, reason: String },
    #[serde(rename = "terminal_resized")]
    TerminalResized {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal_title")]
    TerminalTitle {
        terminal_id: String,
        title: String,
        source: TerminalTitleSource,
    },
    #[serde(rename = "terminal_cwd")]
    TerminalCwd { terminal_id: String, cwd: String },
    #[serde(rename = "terminal_attention")]
    TerminalAttention {
        terminal_id: String,
        attention: Option<TerminalAttention>,
    },
    /// The coding agent in a terminal's foreground, sent on change (and for every
    /// terminal after a reconnect); `None` when there's none. The hub makes runs of it.
    #[serde(rename = "terminal_agent")]
    TerminalAgent {
        terminal_id: String,
        agent: Option<RunAgent>,
    },
    /// What the agent in a terminal says about its run, through its hooks ("hooks") or
    /// its own report ("report"). The hub opens a run for it if none is open.
    /// The coding agent CLIs this node found, sent after it registers.
    #[serde(rename = "installed_agents")]
    InstalledAgents { agents: Vec<InstalledAgent> },
    #[serde(rename = "agent_signal")]
    AgentSignal {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<RunAgent>,
        source: String,
        signal: AgentSignal,
    },
    #[serde(rename = "pong")]
    Pong,
    /// Agent session state changes. Fields left `None` are unchanged.
    #[serde(rename = "agent_session_update")]
    AgentSessionUpdate {
        session_id: String,
        #[serde(default)]
        status: Option<AgentSessionStatus>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        acp_session_id: Option<String>,
        /// Some = the agent's model list (empty means the agent explicitly
        /// reported no model support); None = unchanged.
        #[serde(default)]
        available_models: Option<Vec<AgentModelInfo>>,
        #[serde(default)]
        current_model_id: Option<String>,
    },
    /// One normalized agent event. `seq` is per-session monotonic and
    /// machine-assigned, starting at 1 (restarted on resume; the hub ignores
    /// seq ≤ its stored last_event_seq).
    #[serde(rename = "agent_session_event")]
    AgentSessionEvent {
        session_id: String,
        seq: u64,
        event: AgentEvent,
    },
    /// The agent process exited or its stdio closed.
    #[serde(rename = "agent_session_exited")]
    AgentSessionExited { session_id: String, reason: String },
}

// ── Browser-facing events (Hub → Browser via events WebSocket) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum BrowserEvent {
    #[serde(rename = "machine_online")]
    MachineOnline { machine: MachineInfo },
    #[serde(rename = "machine_offline")]
    MachineOffline { machine_id: String },
    /// The user forgot this machine. Clients must drop it and every
    /// terminal / tab / agent session that belonged to it.
    #[serde(rename = "machine_removed")]
    MachineRemoved { machine_id: String },
    #[serde(rename = "terminal_created")]
    TerminalCreated { terminal: TerminalInfo },
    #[serde(rename = "terminal_updated")]
    TerminalUpdated { terminal: TerminalInfo },
    #[serde(rename = "terminal_resized")]
    TerminalResized { terminal: TerminalInfo },
    #[serde(rename = "terminal_destroyed")]
    TerminalDestroyed {
        machine_id: String,
        terminal_id: String,
    },
    #[serde(rename = "terminal_reachable_changed")]
    TerminalReachableChanged {
        machine_id: String,
        terminal_id: String,
        reachable: bool,
    },
    #[serde(rename = "workspace_group_created")]
    WorkspaceGroupCreated { group: WorkspaceGroupInfo },
    #[serde(rename = "workspace_group_updated")]
    WorkspaceGroupUpdated { group: WorkspaceGroupInfo },
    #[serde(rename = "workspace_group_deleted")]
    WorkspaceGroupDeleted {
        machine_id: String,
        group_id: String,
    },
    #[serde(rename = "workspace_layout_updated")]
    WorkspaceLayoutUpdated { layout: WorkspaceLayoutInfo },
    #[serde(rename = "machine_stats")]
    MachineStats {
        machine_id: String,
        stats: ResourceStats,
    },
    #[serde(rename = "mode_changed")]
    ModeChanged {
        machine_id: String,
        controller_device_id: Option<String>,
    },
    #[serde(rename = "agent_session_created")]
    AgentSessionCreated { session: AgentSessionInfo },
    #[serde(rename = "agent_session_updated")]
    AgentSessionUpdated { session: AgentSessionInfo },
    #[serde(rename = "agent_session_destroyed")]
    AgentSessionDestroyed { session_id: String },
    #[serde(rename = "agent_session_event")]
    AgentSessionEvent {
        session_id: String,
        seq: u64,
        event: AgentEvent,
    },
    /// Cross-device read sync: another device of the same user advanced its
    /// read cursor for this session.
    #[serde(rename = "agent_session_seen")]
    AgentSessionSeen {
        session_id: String,
        last_seen_seq: u64,
    },
    /// An agent run started, changed status, or ended.
    #[serde(rename = "agent_run_updated")]
    AgentRunUpdated { run: AgentRunInfo },
    #[serde(rename = "agent_browser_created")]
    AgentBrowserCreated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_updated")]
    AgentBrowserUpdated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_destroyed")]
    AgentBrowserDestroyed {
        machine_id: String,
        browser_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserEventEnvelope {
    pub seq: u64,
    pub event: BrowserEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum BrowserEventsClientMessage {
    #[serde(rename = "ping")]
    Ping { t: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename = "pong")]
pub struct BrowserEventsPong {
    pub t: u64,
}

/// Magic byte at the head of every per-attach binary frame. Originally
/// added to disambiguate from the legacy `encode_terminal_output_frame`
/// during the migration window; that codec is gone now, but the magic
/// byte stays as a forward-compatible discriminator (any future binary
/// frame variants get a different magic and dispatch trivially).
const ATTACH_FRAME_MAGIC: u8 = 0x01;
const TERMINAL_PREVIEW_FRAME_MAGIC: u8 = 0x02;
/// Node → hub agent browser screencast frame.
pub const AGENT_BROWSER_FRAME_MAGIC: u8 = 0x03;

/// `[0x03][u16 id_len][browser_id][u16 meta_len][meta JSON][jpeg]`. `meta` is
/// the CDP `Page.screencastFrame` metadata (offsetTop, pageScaleFactor,
/// deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, timestamp).
pub fn encode_agent_browser_frame(browser_id: &str, meta: &[u8], jpeg: &[u8]) -> Vec<u8> {
    let id = browser_id.as_bytes();
    let id_len: u16 = id
        .len()
        .try_into()
        .expect("browser_id is too long to encode");
    let meta_len: u16 = meta
        .len()
        .try_into()
        .expect("frame meta is too long to encode");
    let mut frame = Vec::with_capacity(1 + 2 + id.len() + 2 + meta.len() + jpeg.len());
    frame.push(AGENT_BROWSER_FRAME_MAGIC);
    frame.extend_from_slice(&id_len.to_be_bytes());
    frame.extend_from_slice(id);
    frame.extend_from_slice(&meta_len.to_be_bytes());
    frame.extend_from_slice(meta);
    frame.extend_from_slice(jpeg);
    frame
}

/// Decode to `(browser_id, meta JSON, jpeg)`; the last two are zero-copy
/// slices of the incoming message.
pub fn decode_agent_browser_frame(frame: &Bytes) -> Result<(String, Bytes, Bytes), String> {
    if frame.first() != Some(&AGENT_BROWSER_FRAME_MAGIC) {
        return Err("not an agent browser frame".to_string());
    }
    let body = &frame[1..];
    if body.len() < 2 {
        return Err("frame is missing browser id length".to_string());
    }
    let id_len = u16::from_be_bytes([body[0], body[1]]) as usize;
    let meta_at = 2 + id_len;
    if body.len() < meta_at + 2 {
        return Err("frame is truncated".to_string());
    }
    let id = std::str::from_utf8(&body[2..meta_at])
        .map_err(|error| format!("browser id is not valid utf-8: {error}"))?
        .to_string();
    let meta_len = u16::from_be_bytes([body[meta_at], body[meta_at + 1]]) as usize;
    let meta_start = meta_at + 2;
    if body.len() < meta_start + meta_len {
        return Err("frame meta is truncated".to_string());
    }
    // `body` starts one byte into `frame`.
    Ok((
        id,
        frame.slice(1 + meta_start..1 + meta_start + meta_len),
        frame.slice(1 + meta_start + meta_len..),
    ))
}

pub fn encode_attach_output_frame(attach_id: &str, data: &[u8]) -> Vec<u8> {
    let attach_id_bytes = attach_id.as_bytes();
    let attach_id_len: u16 = attach_id_bytes
        .len()
        .try_into()
        .expect("attach_id is too long to encode");

    let mut frame = Vec::with_capacity(1 + 2 + attach_id_bytes.len() + data.len());
    frame.push(ATTACH_FRAME_MAGIC);
    frame.extend_from_slice(&attach_id_len.to_be_bytes());
    frame.extend_from_slice(attach_id_bytes);
    frame.extend_from_slice(data);
    frame
}

/// Decode an attach output frame. Takes `Bytes` so the payload comes back
/// as a zero-copy slice of the incoming WebSocket message — the hub calls
/// this once per output frame on its hottest path.
pub fn decode_attach_output_frame(frame: &Bytes) -> Result<(String, Bytes), String> {
    if frame.is_empty() {
        return Err("frame is empty".to_string());
    }
    if frame[0] != ATTACH_FRAME_MAGIC {
        return Err(format!(
            "frame magic is 0x{:02x}, expected attach",
            frame[0]
        ));
    }
    let body = &frame[1..];
    if body.len() < 2 {
        return Err("frame is missing attach id length".to_string());
    }
    let attach_id_len = u16::from_be_bytes([body[0], body[1]]) as usize;
    if body.len() < 2 + attach_id_len {
        return Err("frame is truncated".to_string());
    }
    let attach_id = std::str::from_utf8(&body[2..2 + attach_id_len])
        .map_err(|error| format!("attach id is not valid utf-8: {error}"))?
        .to_string();
    Ok((attach_id, frame.slice(1 + 2 + attach_id_len..)))
}

pub fn encode_terminal_preview_output_frame(terminal_id: &str, data: &[u8]) -> Vec<u8> {
    let terminal_id_bytes = terminal_id.as_bytes();
    let terminal_id_len: u16 = terminal_id_bytes
        .len()
        .try_into()
        .expect("terminal_id is too long to encode");

    let mut frame = Vec::with_capacity(1 + 2 + terminal_id_bytes.len() + data.len());
    frame.push(TERMINAL_PREVIEW_FRAME_MAGIC);
    frame.extend_from_slice(&terminal_id_len.to_be_bytes());
    frame.extend_from_slice(terminal_id_bytes);
    frame.extend_from_slice(data);
    frame
}

pub fn decode_terminal_preview_output_frame(frame: &[u8]) -> Result<(String, Bytes), String> {
    if frame.is_empty() {
        return Err("frame is empty".to_string());
    }
    if frame[0] != TERMINAL_PREVIEW_FRAME_MAGIC {
        return Err(format!(
            "frame magic is 0x{:02x}, expected terminal preview",
            frame[0]
        ));
    }
    let body = &frame[1..];
    if body.len() < 2 {
        return Err("frame is missing terminal id length".to_string());
    }
    let terminal_id_len = u16::from_be_bytes([body[0], body[1]]) as usize;
    if body.len() < 2 + terminal_id_len {
        return Err("frame is truncated".to_string());
    }
    let terminal_id = std::str::from_utf8(&body[2..2 + terminal_id_len])
        .map_err(|error| format!("terminal id is not valid utf-8: {error}"))?
        .to_string();
    Ok((
        terminal_id,
        Bytes::copy_from_slice(&body[2 + terminal_id_len..]),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_agent_browser_frame, decode_attach_output_frame,
        decode_terminal_preview_output_frame, encode_agent_browser_frame,
        encode_attach_output_frame, encode_terminal_preview_output_frame, AgentBrowserController,
        AgentBrowserDialogKind, AgentBrowserInfo, AgentBrowserInputEvent, AgentBrowserNav,
        BrowserEventsClientMessage, BrowserEventsPong, HubToMachine, MachineToHub, MouseButton,
        clean_opener_label, NavAction, TerminalInfo, TerminalOpener, TerminalOpenerKind,
        TerminalTitleSource, AGENT_BROWSER_MAX_INPUT_TEXT, AGENT_BROWSER_MAX_URL,
        TERMINAL_OPENER_LABEL_MAX,
    };
    use bytes::Bytes;

    #[test]
    fn agent_browser_info_control_fields_default_and_round_trip() {
        let old: AgentBrowserInfo =
            serde_json::from_str(r#"{"id":"b","url":"u","title":"t"}"#).unwrap();
        assert_eq!(old.controller, AgentBrowserController::Agent);
        assert!(old.handoff.is_none() && old.controller_device_id.is_none());
        let json = serde_json::to_value(&old).unwrap();
        assert_eq!(json["controller"], "agent");
        assert!(json.get("handoff").is_none());
        assert!(old.reclaimed.is_none() && json.get("reclaimed").is_none());
        let human: AgentBrowserInfo = serde_json::from_str(
            r#"{"id":"b","url":"u","title":"t","controller":"human","controller_device_id":"d1",
                "controller_since":5,"handoff":{"reason":"log in","requested_at":3}}"#,
        )
        .unwrap();
        assert_eq!(human.controller, AgentBrowserController::Human);
        assert_eq!(human.handoff.unwrap().reason, "log in");
    }

    #[test]
    fn agent_browser_input_events_serde_and_sanitize() {
        let mouse: AgentBrowserInputEvent = serde_json::from_str(
            r#"{"kind":"mouse","action":"down","x":10.5,"y":9999,"button":"left","buttons":1,"click_count":2,"modifiers":8}"#,
        )
        .unwrap();
        match mouse.clone().sanitized().unwrap() {
            AgentBrowserInputEvent::Mouse { y, click_count, .. } => {
                assert_eq!(y, 799.0);
                assert_eq!(click_count, 2);
            }
            other => panic!("{other:?}"),
        }
        let defaults: AgentBrowserInputEvent =
            serde_json::from_str(r#"{"kind":"mouse","action":"move","x":1,"y":2}"#).unwrap();
        assert!(matches!(
            defaults,
            AgentBrowserInputEvent::Mouse {
                button: MouseButton::None,
                click_count: 1,
                ..
            }
        ));
        let wheel: AgentBrowserInputEvent =
            serde_json::from_str(r#"{"kind":"wheel","x":-5,"y":3,"delta_x":0,"delta_y":1e9}"#)
                .unwrap();
        assert!(matches!(
            wheel.sanitized().unwrap(),
            AgentBrowserInputEvent::Wheel { x, delta_y, .. } if x == 0.0 && delta_y == 10_000.0
        ));
        let key: AgentBrowserInputEvent = serde_json::from_str(
            r#"{"kind":"key","action":"down","key":"a","code":"KeyA","text":"a","modifiers":0,"key_code":65}"#,
        )
        .unwrap();
        assert!(key.sanitized().is_some());
        let long = AgentBrowserInputEvent::Text {
            text: "x".repeat(10_001),
        };
        assert!(long.sanitized().is_none());
        assert!(AgentBrowserInputEvent::Text {
            text: "x".repeat(10_000)
        }
        .sanitized()
        .is_some());
        assert!(AgentBrowserInputEvent::Text {
            text: String::new()
        }
        .sanitized()
        .is_none());
        let msg = HubToMachine::AgentBrowserInput {
            browser_id: "b".into(),
            event: AgentBrowserInputEvent::Text { text: "hi".into() },
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["type"], "agent_browser_input");
        assert_eq!(json["event"]["kind"], "text");
        assert!(serde_json::from_value::<HubToMachine>(json).is_ok());
    }

    #[test]
    fn agent_browser_navigate_and_dialog_events() {
        let parse = |json: &str| serde_json::from_str::<AgentBrowserInputEvent>(json).unwrap();
        // Only goto carries a url, trimmed; the others drop one.
        assert_eq!(
            parse(r#"{"kind":"navigate","action":"goto","url":"  https://x.test/a  "}"#)
                .sanitized(),
            Some(AgentBrowserInputEvent::Navigate {
                action: NavAction::Goto,
                url: Some("https://x.test/a".into()),
            })
        );
        assert_eq!(
            parse(r#"{"kind":"navigate","action":"back","url":"ignored"}"#).sanitized(),
            Some(AgentBrowserInputEvent::Navigate {
                action: NavAction::Back,
                url: None,
            })
        );
        for bad in [
            r#"{"kind":"navigate","action":"goto"}"#,
            r#"{"kind":"navigate","action":"goto","url":"   "}"#,
        ] {
            assert_eq!(parse(bad).sanitized(), None, "{bad}");
        }
        let long = format!("https://x.test/{}", "a".repeat(AGENT_BROWSER_MAX_URL));
        assert_eq!(
            AgentBrowserInputEvent::Navigate {
                action: NavAction::Goto,
                url: Some(long),
            }
            .sanitized(),
            None
        );
        assert!(serde_json::from_str::<AgentBrowserInputEvent>(
            r#"{"kind":"navigate","action":"sideways"}"#
        )
        .is_err());

        let answer = parse(r#"{"kind":"dialog","accept":true,"prompt_text":"42"}"#);
        assert_eq!(answer.clone().sanitized(), Some(answer));
        assert!(parse(r#"{"kind":"dialog","accept":false}"#)
            .sanitized()
            .is_some());
        assert_eq!(
            AgentBrowserInputEvent::Dialog {
                accept: true,
                prompt_text: Some("x".repeat(AGENT_BROWSER_MAX_INPUT_TEXT + 1)),
            }
            .sanitized(),
            None
        );
    }

    #[test]
    fn agent_browser_info_nav_dialog_and_opener() {
        let old: AgentBrowserInfo =
            serde_json::from_str(r#"{"id":"b","url":"u","title":"t"}"#).unwrap();
        assert!(old.nav.is_none() && old.dialog.is_none() && old.opener_browser_id.is_none());
        let json = serde_json::to_value(&old).unwrap();
        for absent in ["nav", "dialog", "opener_browser_id"] {
            assert!(json.get(absent).is_none(), "{absent}");
        }
        let new: AgentBrowserInfo = serde_json::from_str(
            r#"{"id":"b","url":"u","title":"t","opener_browser_id":"a",
                "nav":{"can_go_back":true,"can_go_forward":false,"loading":true},
                "dialog":{"kind":"beforeunload","message":""}}"#,
        )
        .unwrap();
        assert_eq!(new.opener_browser_id.as_deref(), Some("a"));
        assert_eq!(
            new.nav,
            Some(AgentBrowserNav {
                can_go_back: true,
                can_go_forward: false,
                loading: true,
            })
        );
        let dialog = new.dialog.clone().unwrap();
        assert_eq!(dialog.kind, AgentBrowserDialogKind::Beforeunload);
        assert!(dialog.default_prompt.is_empty());
        let json = serde_json::to_value(&new).unwrap();
        assert!(json["dialog"].get("default_prompt").is_none());
        assert_eq!(
            serde_json::from_value::<AgentBrowserInfo>(json).unwrap(),
            new
        );
    }

    #[test]
    fn agent_browser_frame_round_trips_and_is_distinct_from_attach_frames() {
        let frame = Bytes::from(encode_agent_browser_frame(
            "b-1",
            br#"{"offsetTop":0}"#,
            &[0xFF, 0xD8, 1, 2, 3],
        ));
        assert_eq!(frame[0], 0x03);
        let (id, meta, jpeg) = decode_agent_browser_frame(&frame).unwrap();
        assert_eq!(id, "b-1");
        assert_eq!(&meta[..], br#"{"offsetTop":0}"#);
        assert_eq!(&jpeg[..], &[0xFF, 0xD8, 1, 2, 3]);
        assert!(decode_attach_output_frame(&frame).is_err());
        let attach = Bytes::from(encode_attach_output_frame("a", b"x"));
        assert!(decode_agent_browser_frame(&attach).is_err());
        assert!(decode_agent_browser_frame(&frame.slice(..4)).is_err());
        assert!(decode_agent_browser_frame(&frame.slice(..8)).is_err());
    }

    #[test]
    fn terminal_info_title_source_defaults_to_none_when_missing() {
        let json = r#"{
            "id": "term-a",
            "machine_id": "machine-a",
            "title": "bash",
            "cwd": "/tmp",
            "cols": 80,
            "rows": 24
        }"#;
        let info = serde_json::from_str::<TerminalInfo>(json).unwrap();
        assert_eq!(info.title_source, TerminalTitleSource::None);

        let serialized = serde_json::to_value(&info).unwrap();
        assert_eq!(serialized["title_source"], serde_json::json!("none"));

        let round_tripped =
            serde_json::from_str::<TerminalInfo>(&serde_json::to_string(&info).unwrap()).unwrap();
        assert_eq!(round_tripped, info);
    }

    #[test]
    fn terminal_opener_is_optional_and_additive() {
        let json = r#"{
            "id": "term-a",
            "machine_id": "machine-a",
            "title": "bash",
            "cwd": "/tmp",
            "cols": 80,
            "rows": 24
        }"#;
        let mut info = serde_json::from_str::<TerminalInfo>(json).unwrap();
        assert_eq!(info.opened_by, None);
        // Absent rather than null, so older clients see the same shape.
        assert!(serde_json::to_value(&info).unwrap().get("opened_by").is_none());

        info.opened_by = Some(TerminalOpener {
            kind: TerminalOpenerKind::Cli,
            label: Some("ci-bot".to_string()),
        });
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(
            value["opened_by"],
            serde_json::json!({ "kind": "cli", "label": "ci-bot" })
        );
        assert_eq!(serde_json::from_value::<TerminalInfo>(value).unwrap(), info);

        // A kind from a newer hub still reads.
        let opener: TerminalOpener =
            serde_json::from_value(serde_json::json!({ "kind": "something_new" })).unwrap();
        assert_eq!(opener.kind, TerminalOpenerKind::Other);
    }

    #[test]
    fn opener_labels_are_trimmed_and_bounded() {
        assert_eq!(clean_opener_label("  claude \n"), Some("claude".to_string()));
        assert_eq!(clean_opener_label("ci\u{1b}[31m-bot"), Some("ci[31m-bot".to_string()));
        assert_eq!(clean_opener_label("   "), None);
        let long = "x".repeat(100);
        assert_eq!(
            clean_opener_label(&long).unwrap().chars().count(),
            TERMINAL_OPENER_LABEL_MAX
        );
    }

    #[test]
    fn terminal_title_source_none_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(TerminalTitleSource::None).unwrap(),
            serde_json::json!("none")
        );
        assert_eq!(
            serde_json::from_str::<TerminalTitleSource>(r#""none""#).unwrap(),
            TerminalTitleSource::None
        );
    }

    #[test]
    fn terminal_cwd_message_round_trips() {
        let msg = MachineToHub::TerminalCwd {
            terminal_id: "term-a".to_string(),
            cwd: "/home/user/project".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(
            json,
            r#"{"type":"terminal_cwd","terminal_id":"term-a","cwd":"/home/user/project"}"#
        );
        let parsed = serde_json::from_str::<MachineToHub>(&json).unwrap();
        assert!(matches!(
            parsed,
            MachineToHub::TerminalCwd { terminal_id, cwd }
                if terminal_id == "term-a" && cwd == "/home/user/project"
        ));
    }

    #[test]
    fn attach_output_frame_round_trips_without_loss() {
        let frame = Bytes::from(encode_attach_output_frame(
            "attach-x",
            b"\x1b[38;5;246mhello\x00\xff",
        ));
        let (attach_id, payload) = decode_attach_output_frame(&frame).unwrap();
        assert_eq!(attach_id, "attach-x");
        assert_eq!(payload.as_ref(), b"\x1b[38;5;246mhello\x00\xff");
    }

    #[test]
    fn attach_output_frame_rejects_truncated_payloads() {
        // 0x01 magic + truncated body
        let error =
            decode_attach_output_frame(&Bytes::from_static(&[0x01, 0, 10, b't'])).unwrap_err();
        assert!(error.contains("truncated"));
    }

    #[test]
    fn attach_output_frame_rejects_wrong_magic() {
        // A frame starting with anything other than 0x01 isn't ours.
        let bad = Bytes::from_static(&[0xff_u8, 0, 4, b't', b'e', b's', b't']);
        assert!(decode_attach_output_frame(&bad).is_err());
    }

    #[test]
    fn terminal_preview_output_frame_round_trips_without_loss() {
        let frame = encode_terminal_preview_output_frame("terminal-x", b"\x1b[32mpreview\x00\xff");
        let (terminal_id, payload) = decode_terminal_preview_output_frame(&frame).unwrap();
        assert_eq!(terminal_id, "terminal-x");
        assert_eq!(payload.as_ref(), b"\x1b[32mpreview\x00\xff");
    }

    #[test]
    fn terminal_preview_output_frame_rejects_wrong_magic() {
        let frame = encode_attach_output_frame("attach-x", b"not a preview");
        let error = decode_terminal_preview_output_frame(&frame).unwrap_err();
        assert!(error.contains("expected terminal preview"));
    }

    #[test]
    fn browser_events_ping_and_pong_preserve_the_timestamp() {
        let ping =
            serde_json::from_str::<BrowserEventsClientMessage>(r#"{"type":"ping","t":123456}"#)
                .unwrap();
        assert!(matches!(
            ping,
            BrowserEventsClientMessage::Ping { t: 123456 }
        ));

        let pong = serde_json::to_string(&BrowserEventsPong { t: 123456 }).unwrap();
        assert_eq!(pong, r#"{"type":"pong","t":123456}"#);
    }

    #[test]
    fn agent_kind_and_status_serialize_as_snake_case() {
        use super::{AgentKind, AgentSessionStatus};
        assert_eq!(
            serde_json::to_value(AgentKind::Claude).unwrap(),
            serde_json::json!("claude")
        );
        assert_eq!(
            serde_json::from_str::<AgentKind>(r#""kimi""#).unwrap(),
            AgentKind::Kimi
        );
        assert_eq!(
            serde_json::to_value(AgentSessionStatus::Disconnected).unwrap(),
            serde_json::json!("disconnected")
        );
        assert_eq!(
            serde_json::from_str::<AgentSessionStatus>(r#""asked""#).unwrap(),
            AgentSessionStatus::Asked
        );
    }

    #[test]
    fn agent_event_uses_snake_case_type_tags() {
        use super::{AgentEvent, AgentQuestionOption};
        let event = AgentEvent::Question {
            request_id: "7".to_string(),
            prompt: "Allow?".to_string(),
            options: vec![AgentQuestionOption {
                id: "allow-once".to_string(),
                label: "Allow once".to_string(),
                detail: None,
            }],
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"type":"question","request_id":"7","prompt":"Allow?","options":[{"id":"allow-once","label":"Allow once","detail":null}]}"#
        );
        let parsed = serde_json::from_str::<AgentEvent>(&json).unwrap();
        assert_eq!(parsed, event);

        let tool_call = AgentEvent::ToolCall {
            tool_call_id: "call-1".to_string(),
            title: "Edit file".to_string(),
            kind: Some("edit".to_string()),
            status: "in_progress".to_string(),
        };
        let parsed =
            serde_json::from_str::<AgentEvent>(&serde_json::to_string(&tool_call).unwrap())
                .unwrap();
        assert_eq!(parsed, tool_call);
    }

    #[test]
    fn agent_session_messages_round_trip() {
        use super::{AgentEvent, AgentKind, HubToMachine, MachineToHub};
        let start = HubToMachine::AgentSessionStart {
            session_id: "s-1".to_string(),
            agent_kind: AgentKind::Kimi,
            cwd: "/work/repo".to_string(),
            auto_run: true,
            resume_acp_session_id: Some("acp-9".to_string()),
            model_id: Some("kimi-code/k3".to_string()),
        };
        let json = serde_json::to_string(&start).unwrap();
        assert!(json.contains(r#""type":"agent_session_start""#));
        let parsed = serde_json::from_str::<HubToMachine>(&json).unwrap();
        assert!(matches!(
            parsed,
            HubToMachine::AgentSessionStart {
                resume_acp_session_id: Some(id),
                ..
            } if id == "acp-9"
        ));

        let event = MachineToHub::AgentSessionEvent {
            session_id: "s-1".to_string(),
            seq: 3,
            event: AgentEvent::TurnEnded {
                stop_reason: "end_turn".to_string(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"agent_session_event""#));
        assert!(json.contains(r#""type":"turn_ended""#));
    }

    #[test]
    fn agent_session_model_messages_round_trip() {
        use super::{AgentKind, AgentModelInfo, AgentSessionInfo, HubToMachine, MachineToHub};

        let set_model = HubToMachine::AgentSessionSetModel {
            session_id: "s-1".to_string(),
            model_id: "grok-4.5".to_string(),
        };
        let json = serde_json::to_string(&set_model).unwrap();
        assert_eq!(
            json,
            r#"{"type":"agent_session_set_model","session_id":"s-1","model_id":"grok-4.5"}"#
        );
        let parsed = serde_json::from_str::<HubToMachine>(&json).unwrap();
        assert!(matches!(
            parsed,
            HubToMachine::AgentSessionSetModel { model_id, .. } if model_id == "grok-4.5"
        ));

        // A create without a model omits the field entirely (old machines
        // ignore unknown fields; new machines default to None).
        let start = HubToMachine::AgentSessionStart {
            session_id: "s-1".to_string(),
            agent_kind: AgentKind::Grok,
            cwd: "/work".to_string(),
            auto_run: false,
            resume_acp_session_id: None,
            model_id: None,
        };
        assert!(!serde_json::to_string(&start).unwrap().contains("model_id"));

        // An update with only a model change leaves the other fields out;
        // the browser-facing info tolerates missing model fields.
        let update = serde_json::from_str::<MachineToHub>(
            r#"{"type":"agent_session_update","session_id":"s-1","current_model_id":"grok-4.5"}"#,
        )
        .unwrap();
        assert!(matches!(
            update,
            MachineToHub::AgentSessionUpdate {
                status: None,
                available_models: None,
                current_model_id: Some(id),
                ..
            } if id == "grok-4.5"
        ));

        let info = serde_json::from_str::<AgentSessionInfo>(
            r#"{"id":"s-1","machine_id":"m","agent_kind":"grok","cwd":"/work","title":"work",
               "status":"idle","auto_run":true,"last_event_seq":0,"created_at_ms":1}"#,
        )
        .unwrap();
        assert!(info.available_models.is_empty());
        assert_eq!(info.current_model_id, None);

        let model = AgentModelInfo {
            model_id: "grok-4.6".to_string(),
            name: "Grok 4.6".to_string(),
            description: None,
        };
        assert_eq!(
            serde_json::from_str::<AgentModelInfo>(&serde_json::to_string(&model).unwrap())
                .unwrap(),
            model
        );
    }

    #[test]
    fn machine_info_production_defaults_to_false() {
        use super::MachineInfo;
        let info = serde_json::from_str::<MachineInfo>(
            r#"{"id":"m","name":"m","os":"linux","home_dir":"/tmp"}"#,
        )
        .unwrap();
        assert!(!info.production);
    }

    #[test]
    fn browser_snapshot_agent_fields_default_to_empty() {
        use super::BrowserStateSnapshot;
        let snapshot = serde_json::from_str::<BrowserStateSnapshot>(
            r#"{"snapshot_seq":1,"last_focused_terminal_id":null,"machines":[],"terminals":[],
               "workspace_groups":[],"workspace_layouts":[],"machine_stats":[],"control_leases":[]}"#,
        )
        .unwrap();
        assert!(snapshot.agent_sessions.is_empty());
        assert!(snapshot.agent_session_seen.is_empty());
    }

    #[test]
    fn answer_keys_are_limited_to_options_confirm_cancel_and_one_line() {
        use super::{AgentKey, HubToMachine};
        assert!(AgentKey::Digit(1).is_allowed() && AgentKey::Digit(9).is_allowed());
        assert!(!AgentKey::Digit(0).is_allowed() && !AgentKey::Digit(10).is_allowed());
        assert!(AgentKey::Text("Team, and keep the old prices".into()).is_allowed());
        assert!(!AgentKey::Text("".into()).is_allowed());
        assert!(!AgentKey::Text("rm -rf ~\n".into()).is_allowed());
        assert!(!AgentKey::Text("\u{1b}[A".into()).is_allowed());
        assert!(!AgentKey::Text("x".repeat(2001)).is_allowed());
        let message = HubToMachine::SendAgentKeys { terminal_id: "t".into(), keys: vec![AgentKey::Text("hi".into()), AgentKey::Enter] };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            serde_json::json!({"type": "send_agent_keys", "terminal_id": "t", "keys": [{"key": "text", "value": "hi"}, {"key": "enter"}]})
        );
    }

    #[test]
    fn agent_socket_paths_fit_unix_limits() {
        use std::path::Path;
        let short = super::agent_socket_path_in(Path::new("/Users/a/Library/Application Support/offdesk"), Path::new("/tmp"));
        assert_eq!(short, Path::new("/Users/a/Library/Application Support/offdesk/agent.sock"));
        let deep = Path::new("/private/tmp/very/deep/directory/that/goes/on/and/on/for/a/long/while/until/it/is/too/long/offdesk");
        let fallback = super::agent_socket_path_in(deep, Path::new("/tmp"));
        assert!(fallback.starts_with("/tmp") && fallback.as_os_str().len() < 100);
        assert_eq!(fallback, super::agent_socket_path_in(deep, Path::new("/tmp")), "the same for every caller");
        assert_ne!(fallback, super::agent_socket_path_in(&deep.join("other"), Path::new("/tmp")));
    }

    #[test]
    fn agent_signals_have_a_stable_shape_and_tolerate_newer_signals() {
        use super::{AgentReportKind, AgentRequestKind, AgentRunProgress, AgentSignal, LocalAgentReport, MachineToHub};
        assert_eq!(serde_json::to_value(AgentSignal::Idle).unwrap(), serde_json::json!({"signal": "idle"}));
        assert_eq!(
            serde_json::to_value(AgentSignal::Waiting { request: AgentRequestKind::Approval, prompt: Some("Bash: npm test".into()), options: vec![] }).unwrap(),
            serde_json::json!({"signal": "waiting", "request": "approval", "prompt": "Bash: npm test"})
        );
        assert_eq!(
            serde_json::to_value(AgentSignal::Progress(AgentRunProgress { done: 1, total: 3, current: None })).unwrap(),
            serde_json::json!({"signal": "progress", "done": 1, "total": 3})
        );
        assert_eq!(
            serde_json::from_value::<AgentSignal>(serde_json::json!({"signal": "report", "kind": "blocked", "text": "stuck"})).unwrap(),
            AgentSignal::Report { kind: AgentReportKind::Blocked, text: "stuck".into(), link: None }
        );
        // A newer node's signal reads as Other rather than failing the message
        assert_eq!(serde_json::from_value::<AgentSignal>(serde_json::json!({"signal": "paused"})).unwrap(), AgentSignal::Other);
        let message: MachineToHub = serde_json::from_value(serde_json::json!({
            "type": "agent_signal", "terminal_id": "t1", "source": "hooks", "signal": {"signal": "working"}
        }))
        .unwrap();
        assert!(matches!(message, MachineToHub::AgentSignal { agent: None, signal: AgentSignal::Working, .. }));
        let local: LocalAgentReport = serde_json::from_str(r#"{"tmux_pane":"%3","source":"report","signal":{"signal":"idle"}}"#).unwrap();
        assert_eq!((local.tmux_socket, local.agent), (None, None));
    }

    #[test]
    fn agent_runs_are_additive_and_tolerate_newer_peers() {
        use super::{AgentRunInfo, AgentRunStatus, BrowserEvent, BrowserStateSnapshot, MachineToHub, RunAgent};
        // An older hub's snapshot has no runs
        let snapshot = serde_json::from_str::<BrowserStateSnapshot>(
            r#"{"snapshot_seq":1,"last_focused_terminal_id":null,"machines":[],"terminals":[],
               "workspace_groups":[],"workspace_layouts":[],"machine_stats":[],"control_leases":[]}"#,
        )
        .unwrap();
        assert!(snapshot.agent_runs.is_empty());

        // The node's report, with no agent and with one; a newer node's agent reads as Other
        let message = MachineToHub::TerminalAgent { terminal_id: "t1".into(), agent: Some(RunAgent::Codex) };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            serde_json::json!({"type": "terminal_agent", "terminal_id": "t1", "agent": "codex"})
        );
        let none = serde_json::from_str::<MachineToHub>(r#"{"type":"terminal_agent","terminal_id":"t1","agent":null}"#).unwrap();
        assert!(matches!(none, MachineToHub::TerminalAgent { agent: None, .. }));
        let newer = serde_json::from_str::<MachineToHub>(r#"{"type":"terminal_agent","terminal_id":"t1","agent":"gemini"}"#).unwrap();
        assert!(matches!(newer, MachineToHub::TerminalAgent { agent: Some(RunAgent::Other), .. }));

        // A run: optional parts are left out, and a newer status reads as Other
        let run: AgentRunInfo = serde_json::from_str(
            r#"{"id":"r1","machine_id":"m1","agent":"claude","cwd":"/w","status":"paused","started_at_ms":1,"updated_at_ms":2}"#,
        )
        .unwrap();
        assert_eq!((run.status, run.terminal_id.clone(), run.request.clone(), run.ended_at_ms), (AgentRunStatus::Other, None, None, None));
        let event = serde_json::to_value(BrowserEvent::AgentRunUpdated { run }).unwrap();
        assert_eq!(event["type"], "agent_run_updated");
        assert!(event["run"].get("request").is_none());
        assert!(event["run"].get("ended_at_ms").is_none());
    }

    // ── deflate-raw-v1 negotiation: old-peer compatibility ──

    #[test]
    fn open_attach_without_compress_deserializes_uncompressed() {
        // Old hubs never send `compress`; new machines must default to false.
        use super::HubToMachine;
        let parsed = serde_json::from_str::<HubToMachine>(
            r#"{"type":"open_attach","attach_id":"a-1","terminal_id":"t-1","cols":80,"rows":24}"#,
        )
        .unwrap();
        assert!(matches!(
            parsed,
            HubToMachine::OpenAttach {
                compress: false,
                ..
            }
        ));

        let with_compress = serde_json::from_str::<HubToMachine>(
            r#"{"type":"open_attach","attach_id":"a-1","terminal_id":"t-1","cols":80,"rows":24,"compress":true}"#,
        )
        .unwrap();
        assert!(matches!(
            with_compress,
            HubToMachine::OpenAttach { compress: true, .. }
        ));
    }

    #[test]
    fn fs_read_messages_round_trip() {
        use super::{FsReadErrorCode, MachineToHub};
        let request = HubToMachine::FsReadFile {
            request_id: "r".into(),
            path: "a.txt".into(),
            cwd: Some("/tmp".into()),
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains(r#""type":"fs_read_file""#));
        assert!(matches!(
            serde_json::from_str::<HubToMachine>(&json).unwrap(),
            HubToMachine::FsReadFile { cwd: Some(c), .. } if c == "/tmp"
        ));
        let no_cwd: HubToMachine =
            serde_json::from_str(r#"{"type":"fs_read_file","request_id":"r","path":"/x"}"#)
                .unwrap();
        assert!(matches!(no_cwd, HubToMachine::FsReadFile { cwd: None, .. }));

        let ok = MachineToHub::FsReadResult {
            request_id: "r".into(),
            name: "a.txt".into(),
            path: "/tmp/a.txt".into(),
            mime: "text/plain".into(),
            size: 2,
            data_base64: "aGk=".into(),
        };
        let json = serde_json::to_string(&ok).unwrap();
        assert!(matches!(
            serde_json::from_str::<MachineToHub>(&json).unwrap(),
            MachineToHub::FsReadResult { size: 2, .. }
        ));

        let err = MachineToHub::FsReadError {
            request_id: "r".into(),
            code: FsReadErrorCode::TooLarge,
            message: "big".into(),
            size: Some(99),
            path: None,
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""code":"too_large""#));
        assert!(!json.contains("\"path\""));
        assert!(matches!(
            serde_json::from_str::<MachineToHub>(&json).unwrap(),
            MachineToHub::FsReadError {
                code: FsReadErrorCode::TooLarge,
                size: Some(99),
                ..
            }
        ));
    }

    #[test]
    fn fs_list_is_compatible_with_old_peers() {
        use super::DirEntry;
        let old: HubToMachine =
            serde_json::from_str(r#"{"type":"fs_list","request_id":"r","path":"~"}"#).unwrap();
        assert!(matches!(
            old,
            HubToMachine::FsListDir {
                show_hidden: false,
                ..
            }
        ));
        let entry: DirEntry =
            serde_json::from_str(r#"{"name":"a","path":"/a","is_dir":false}"#).unwrap();
        assert_eq!(entry.size, None);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("size") && !json.contains("modified_ms"));
    }

    #[test]
    fn register_without_capabilities_deserializes_with_none() {
        // Old machines omit the capability list; new hubs must see it as
        // "no capabilities" so compression stays off.
        use super::MachineToHub;
        let parsed = serde_json::from_str::<MachineToHub>(
            r#"{"type":"register","machine_id":"m","machine_secret":"s","name":"n","os":"linux","home_dir":"/tmp"}"#,
        )
        .unwrap();
        assert!(matches!(
            parsed,
            MachineToHub::Register { capabilities, .. } if capabilities.is_empty()
        ));

        let with_caps = serde_json::from_str::<MachineToHub>(
            r#"{"type":"register","machine_id":"m","machine_secret":"s","name":"n","os":"linux","home_dir":"/tmp","capabilities":["deflate-raw-v1"]}"#,
        )
        .unwrap();
        assert!(matches!(
            with_caps,
            MachineToHub::Register { capabilities, .. }
                if capabilities == ["deflate-raw-v1"]
        ));
    }
    #[test]
    fn token_access_keeps_to_its_machines_and_folders() {
        use super::{ContentLevel, RunAgent, TokenAccess, TokenScope};
        let access = TokenAccess {
            scopes: vec![TokenScope::RunsStart],
            dirs: Some(vec!["/w/shop/".into(), "~/notes".into()]),
            agents: Some(vec![RunAgent::Claude]),
            ..Default::default()
        };
        assert_eq!(access.validate(), Ok(()));
        assert!(access.allows_dir("/w/shop") && access.allows_dir("/w/shop/api") && access.allows_dir("~/notes/x"));
        for outside in ["/w/shop/../etc", "/w/shopping", "/w", "w/shop", "~/notes/./x", "/w/shop/\u{1b}x"] {
            assert!(!access.allows_dir(outside), "{outside}");
        }
        assert!(access.allows_agent(RunAgent::Claude) && !access.allows_agent(RunAgent::Codex));
        assert!(access.allows(TokenScope::RunsStart) && !access.allows(TokenScope::RunsApprove));
        // Production machines only when named or let in
        assert!(access.allows_machine("m", false) && !access.allows_machine("m", true));
        let named = TokenAccess { machines: Some(vec!["p".into()]), ..access.clone() };
        assert!(named.allows_machine("p", true) && !named.allows_machine("m", false));
        // Starting needs plain folders; content defaults to metadata
        assert!(TokenAccess { dirs: None, ..access.clone() }.validate().is_err());
        assert!(TokenAccess { dirs: Some(vec!["/w/../etc".into()]), ..access.clone() }.validate().is_err());
        assert!(TokenAccess::default().validate().is_err());
        let parsed: TokenAccess = serde_json::from_str(r#"{"scopes":["runs:read"]}"#).unwrap();
        assert_eq!(parsed.content, ContentLevel::Metadata);
        assert!(serde_json::from_str::<TokenAccess>(r#"{"scopes":["runs:all"]}"#).is_err());
    }

    #[test]
    fn agent_starts_take_a_prompt_never_a_command() {
        use super::{AgentPermissionMode, AgentStart, HubToMachine, InstalledAgent, MachineToHub, RunAgent};
        // Line endings and space are tidied; controls and a leading dash are refused
        assert_eq!(AgentStart::normalize_prompt("  Fix it\r\nthen test \t ").unwrap().as_deref(), Some("Fix it\nthen test"));
        assert_eq!(AgentStart::normalize_prompt(" \n ").unwrap(), None);
        assert!(AgentStart::normalize_prompt("a\u{1b}[201~b").is_err());
        assert!(AgentStart::normalize_prompt("--dangerously-skip-permissions").is_err());
        assert!(AgentStart::normalize_prompt(&"x".repeat(super::MAX_START_PROMPT_BYTES + 1)).is_err());
        assert!(AgentStart::normalize_label("two\nlines").is_err());

        // Modes map to the agent's own safe flags; there's no mode that skips prompts
        assert_eq!(AgentPermissionMode::AcceptEdits.args(RunAgent::Claude).unwrap(), ["--permission-mode", "acceptEdits"]);
        assert!(AgentPermissionMode::Plan.args(RunAgent::Codex).is_err());
        assert!(serde_json::from_str::<AgentPermissionMode>(r#""bypass_permissions""#).is_err());

        let mut start = AgentStart {
            run_id: "44444444-4444-4444-8444-444444444444".into(),
            agent: RunAgent::Codex,
            prompt: Some("Fix it".into()),
            permission_mode: Some(AgentPermissionMode::Ask),
            external_ref: None,
            allowed_dirs: None,
        };
        assert_eq!(start.validate(), Ok(()));
        start.prompt = Some(" Fix it".into());
        assert!(start.validate().is_err(), "a node only takes what the hub normalized");
        start.prompt = None;
        start.run_id = "../x".into();
        assert!(start.validate().is_err());

        // A plain terminal's message is as before; old nodes ignore the new field
        let plain = HubToMachine::CreateTerminal { request_id: "r".into(), cwd: "/w".into(), cols: 80, rows: 24, startup_command: None, agent_start: None };
        assert_eq!(serde_json::to_value(&plain).unwrap(), serde_json::json!({"type": "create_terminal", "request_id": "r", "cwd": "/w", "cols": 80, "rows": 24}));
        let installed = MachineToHub::InstalledAgents { agents: vec![InstalledAgent { agent: RunAgent::Claude, version: None }] };
        assert_eq!(serde_json::to_value(&installed).unwrap(), serde_json::json!({"type": "installed_agents", "agents": [{"agent": "claude"}]}));
    }
}

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

/// Directory holding every on-disk file offdesk owns: the CLI's
/// `config.toml`, the node's `machine.json` and `sessions.json`, and the
/// generated tmux config. On Linux this is `~/.config/offdesk`; on macOS
/// `dirs::config_dir()` resolves to `~/Library/Application Support`.
///
/// The first call after an upgrade from webmux moves the old `webmux`
/// directory into place, so a rename does not orphan a registered machine.
/// The move only happens when the new directory does not exist yet, so it
/// can never clobber a fresh config.
pub fn config_dir() -> std::path::PathBuf {
    // Allows isolated development/test daemons without touching user services,
    // credentials or tmux session metadata. No legacy migration in this mode.
    if let Some(path) = std::env::var_os("OFFDESK_CONFIG_DIR").filter(|p| !p.is_empty()) {
        return std::path::PathBuf::from(path);
    }
    let base = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = base.join("offdesk");
    static MIGRATED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    MIGRATED.get_or_init(|| {
        let legacy = base.join("webmux");
        if !dir.exists() && legacy.is_dir() {
            match std::fs::rename(&legacy, &dir) {
                Ok(()) => eprintln!(
                    "offdesk: moved {} to {} (webmux -> offdesk rename)",
                    legacy.display(),
                    dir.display()
                ),
                Err(error) => eprintln!(
                    "offdesk: could not move {} to {}: {error}",
                    legacy.display(),
                    dir.display()
                ),
            }
        }
    });
    dir
}

#[cfg(test)]
mod login_command_tests {
    use super::*;

    fn login() -> AgentBrowserCommand {
        AgentBrowserCommand::Login {
            browser_id: "b1".into(),
            username: Some(Secret::new("alice@example.com")),
            password: Some(Secret::new("hunter2-very-secret")),
            allowed_domains: vec!["aliyun.com".into()],
            submit: true,
        }
    }

    #[test]
    fn debug_output_never_contains_the_secrets() {
        let command = login();
        for rendered in [
            format!("{command:?}"),
            format!("{command:#?}"),
            format!(
                "{:?}",
                HubToMachine::AgentBrowser {
                    request_id: "r".into(),
                    command: command.clone()
                }
            ),
        ] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
            assert!(!rendered.contains("alice@"), "{rendered}");
            assert!(rendered.contains("aliyun.com"), "{rendered}");
            assert!(rendered.contains("redacted"), "{rendered}");
        }
    }

    #[test]
    fn upload_wire_format_and_terse_debug() {
        let command = AgentBrowserCommand::Upload {
            browser_id: "b1".into(),
            r#ref: None,
            files: vec![UploadFile {
                name: "id.png".into(),
                data: Base64Data::new("aGVsbG8gd29ybGQ="),
            }],
        };
        let wire = serde_json::to_value(&command).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "upload",
                "browser_id": "b1",
                "files": [{"name": "id.png", "data": "aGVsbG8gd29ybGQ="}],
            })
        );
        assert_eq!(serde_json::from_value::<AgentBrowserCommand>(wire).unwrap(), command);
        let rendered = format!("{command:?}");
        assert!(rendered.contains("id.png"), "{rendered}");
        assert!(rendered.contains("<16 bytes base64>"), "{rendered}");
        assert!(!rendered.contains("aGVsbG8"), "{rendered}");
    }

    #[test]
    fn login_and_click_wire_format() {
        let wire = serde_json::to_value(login()).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "login",
                "browser_id": "b1",
                "username": "alice@example.com",
                "password": "hunter2-very-secret",
                "allowed_domains": ["aliyun.com"],
                "submit": true,
            })
        );
        assert_eq!(serde_json::from_value::<AgentBrowserCommand>(wire).unwrap(), login());
        // Optional fields may be left out; an old-style click still parses.
        let minimal: AgentBrowserCommand = serde_json::from_value(serde_json::json!({
            "type": "login", "browser_id": "b", "allowed_domains": []
        }))
        .unwrap();
        assert!(matches!(minimal, AgentBrowserCommand::Login { submit: false, username: None, password: None, .. }));
        let click: AgentBrowserCommand =
            serde_json::from_value(serde_json::json!({"type": "click", "browser_id": "b", "ref": "e3"}))
                .unwrap();
        assert_eq!(
            click,
            AgentBrowserCommand::Click { browser_id: "b".into(), r#ref: Some("e3".into()), text: None }
        );
        let by_text = serde_json::to_value(AgentBrowserCommand::Click {
            browser_id: "b".into(),
            r#ref: None,
            text: Some("账密登录".into()),
        })
        .unwrap();
        assert_eq!(by_text, serde_json::json!({"type": "click", "browser_id": "b", "text": "账密登录"}));
    }
}
