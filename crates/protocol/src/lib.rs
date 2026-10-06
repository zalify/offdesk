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
pub mod relay;
pub mod todos;
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
    /// The Claude/Codex agent detected in this terminal. Live only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<relay::TerminalAgent>,
    /// Set when this terminal was started to continue another agent's task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_source: Option<relay::RelaySource>,
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
    /// The user's to-dos; absent from older Hubs.
    #[serde(default)]
    pub todos: Vec<todos::TodoInfo>,
    /// Live agent browsers on the user's online machines.
    #[serde(default)]
    pub agent_browsers: Vec<AgentBrowserInfo>,
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
}

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

/// Commands an agent can run against an agent browser. Replies:
/// Open/Goto -> `AgentBrowserInfo`; List -> `Vec<AgentBrowserInfo>`;
/// Snapshot -> `{"snapshot": string}`; Screenshot -> `{"png_base64": string}`;
/// Wait -> `{"matched": bool, "message"?: string}` (a timeout is not an
/// error); the rest -> `{}`.
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
        /// Only sent to Nodes with `relay::CAPABILITY`; replaces
        /// `startup_command`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        startup_prompt: Option<relay::StartupPrompt>,
    },
    #[serde(rename = "relay_brief")]
    RelayBrief {
        request_id: String,
        terminal_id: String,
    },
    #[serde(rename = "destroy_terminal")]
    DestroyTerminal { terminal_id: String },
    #[serde(rename = "fs_list")]
    FsListDir { request_id: String, path: String },
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
    #[serde(rename = "terminal_agent")]
    TerminalAgent {
        terminal_id: String,
        agent: Option<relay::TerminalAgent>,
    },
    #[serde(rename = "relay_brief_result")]
    RelayBriefResult {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brief: Option<relay::RelayBrief>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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
    #[serde(rename = "agent_browser_created")]
    AgentBrowserCreated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_updated")]
    AgentBrowserUpdated { browser: AgentBrowserInfo },
    #[serde(rename = "agent_browser_destroyed")]
    AgentBrowserDestroyed {
        machine_id: String,
        browser_id: String,
    },
    #[serde(rename = "todo_upserted")]
    TodoUpserted { todo: todos::TodoInfo },
    #[serde(rename = "todo_deleted")]
    TodoDeleted { id: String },
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
        AgentBrowserInfo, AgentBrowserInputEvent, BrowserEventsClientMessage, BrowserEventsPong,
        HubToMachine, MachineToHub, MouseButton, TerminalInfo, TerminalTitleSource,
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
