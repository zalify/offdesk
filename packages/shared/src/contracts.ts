// ── Shared data types (mirrors offdesk-protocol Rust types) ──

export interface MachineInfo {
  id: string
  name: string
  os: string
  home_dir: string
  /** Production machines default agent sessions to auto_run=false. */
  production?: boolean
}

export interface TerminalInfo {
  id: string
  machine_id: string
  title: string
  cwd: string
  workspace_group_id?: string | null
  cols: number
  rows: number
  reachable: boolean
  /** Best-effort live-screen detection; absent on older nodes. */
  attention?: "confirmation" | null
  /** Set when an API-token client (the CLI an agent drives) opened it;
   *  absent when a person did, and from older hubs. */
  opened_by?: TerminalOpener | null
}

export interface TerminalOpener {
  /** "other" is a kind a newer hub added. */
  kind: "cli" | "other"
  /** The CLI's --label, else the API token's name. */
  label?: string | null
}

export interface WorkspaceGroupInfo {
  id: string
  machine_id: string
  name: string
  sort_order: number
}

export type WorkspaceSplitDirection = "horizontal" | "vertical"

export type WorkspaceLayoutNode =
  | { type: "leaf"; terminalId: string }
  | {
      type: "split"
      direction: WorkspaceSplitDirection
      ratio: number
      first: WorkspaceLayoutNode
      second: WorkspaceLayoutNode
    }

export interface WorkspaceLayoutInfo {
  machine_id: string
  group_key: string
  root: WorkspaceLayoutNode | null
  updated_at: number
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
  /** Bytes; absent for directories and on older nodes. */
  size?: number
  /** Last modified, ms since epoch; absent on older nodes. */
  modified_ms?: number
}

export interface DiskInfo {
  mount_point: string
  total_bytes: number
  used_bytes: number
}

export interface MachineStatsSnapshot {
  machine_id: string
  stats: ResourceStats
}

export interface ControlLeaseSnapshot {
  machine_id: string
  controller_device_id: string | null
}

/** One agent browser = one tab of a node's headless Chromium (crates/protocol AgentBrowserInfo). */
export interface AgentBrowserInfo {
  id: string
  machine_id?: string
  url: string
  title: string
  /** Terminal the browser was opened from, when known. */
  opener_terminal_id?: string
  /** Who drives the page; owned by the hub. Absent from older Hubs (= agent). */
  controller?: AgentBrowserController
  /** While a person controls it: the viewer device that took control. */
  controller_device_id?: string
  /** While a person controls it: when they took control (ms since epoch). */
  controller_since?: number
  /** The agent is asking a person for help; cleared when a person hands control back. */
  handoff?: AgentBrowserHandoff
  /** The agent took control back; cleared when a person takes control. */
  reclaimed?: AgentBrowserReclaim
  /** The browser whose page opened this one (a popup or a `target=_blank` link). */
  opener_browser_id?: string
  /** Back / forward / loading state; absent from older nodes, which cannot navigate for a person. */
  nav?: AgentBrowserNav
  /** A JavaScript dialog the page is waiting on. */
  dialog?: AgentBrowserDialog
}

export type AgentBrowserController = 'agent' | 'human'

export interface AgentBrowserNav {
  can_go_back: boolean
  can_go_forward: boolean
  /** The main frame is loading. */
  loading: boolean
}

export interface AgentBrowserDialog {
  /** `beforeunload` is "Leave site?": accepting leaves, dismissing stays. */
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  /** What a prompt is prefilled with. */
  default_prompt?: string
}

export interface AgentBrowserHandoff {
  reason: string
  /** ms since epoch */
  requested_at: number
}

export interface AgentBrowserReclaim {
  reason: string
  /** ms since epoch */
  at: number
  /** The device that lost control, when a person had it. */
  device_id?: string
}

/** `POST /api/machines/{m}/agent-browser/{b}/control` body. */
export interface AgentBrowserControlRequest {
  action: 'take' | 'release'
  /** Required for `take`: the viewer's device id (same one as the viewer WebSocket's `device_id` query). */
  device_id?: string
}

/**
 * A person's input, sent over the viewer WebSocket as
 * `{"type":"input","event":AgentBrowserInputEvent}`. Dropped unless this
 * viewer's `device_id` is the browser's `controller_device_id`. Coordinates are
 * CSS px in the 1280x800 viewport; `modifiers` is the CDP bitmask
 * (Alt 1, Ctrl 2, Meta 4, Shift 8).
 */
export type AgentBrowserInputEvent =
  | {
      kind: 'mouse'
      action: 'move' | 'down' | 'up'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right' | 'none'
      /** Bitmask of buttons held (left 1, right 2, middle 4). */
      buttons?: number
      click_count?: number
      modifiers?: number
    }
  | { kind: 'wheel'; x: number; y: number; delta_x?: number; delta_y?: number; modifiers?: number }
  | {
      kind: 'key'
      action: 'down' | 'up'
      key: string
      code?: string
      text?: string
      modifiers?: number
      key_code?: number
    }
  | { kind: 'text'; text: string }
  /** The toolbar: `goto` loads `url`. */
  | { kind: 'navigate'; action: 'back' | 'forward' | 'reload' | 'stop' | 'goto'; url?: string }
  /** Answer the page's JavaScript dialog. */
  | { kind: 'dialog'; accept: boolean; prompt_text?: string }

export interface BrowserStateSnapshot {
  snapshot_seq: number
  last_focused_terminal_id?: string | null
  machines: MachineInfo[]
  terminals: TerminalInfo[]
  workspace_groups?: WorkspaceGroupInfo[]
  workspace_layouts?: WorkspaceLayoutInfo[]
  machine_stats: MachineStatsSnapshot[]
  control_leases: ControlLeaseSnapshot[]
  agent_sessions?: AgentSessionInfo[]
  /** session_id → last_seen_seq for the requesting user (cross-device read sync). */
  agent_session_seen?: Record<string, number>
  /** Live agent browsers on online machines; absent from older Hubs. */
  agent_browsers?: AgentBrowserInfo[]
  /** Agent runs: open ones and those ended in the last day; absent from older Hubs. */
  agent_runs?: AgentRunInfo[]
}

// ── Agent runs — mirrors crates/protocol/src/lib.rs (docs/plans/2026-10-14-agent-runs.md) ──

/** A coding agent CLI in a terminal; "other" is one a newer Hub knows. */
export type RunAgent = 'claude' | 'codex' | 'other'

export type AgentRunStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'gone' | 'other'

/** Something a run waits on a person for. */
export interface AgentRunRequest {
  id: string
  kind: 'approval' | 'question' | 'input' | 'other'
  /** The question or command, when its source gives one (screen recognition never does). */
  prompt?: string
  options?: AgentQuestionOption[]
  /** "screen"; later "hooks", "acp", "report". */
  source: string
  created_at_ms: number
  /** When a person's answer was typed in; the request stays open until the agent moves on. */
  answer_sent_at_ms?: number
}

/** One agent process's life in one terminal. */
export interface AgentRunInfo {
  id: string
  machine_id: string
  terminal_id?: string
  agent: RunAgent
  cwd: string
  status: AgentRunStatus
  /** The open request, while the run is waiting. */
  request?: AgentRunRequest
  /** From the agent's task list, when its hooks report it. */
  progress?: { done: number; total: number; current?: string }
  /** The latest note, blocked or finished report from the agent itself. */
  report?: { kind: 'note' | 'blocked' | 'finished' | 'other'; text: string; link?: string; at_ms: number }
  /** The name it was started with (`POST /api/agent-runs`). */
  label?: string
  /** The starter's own reference (an issue, a task). */
  external_ref?: string
  started_at_ms: number
  updated_at_ms: number
  ended_at_ms?: number
}

/** The agent's own permission mode for a started run; none of them skips its prompts. */
export type AgentPermissionMode = 'ask' | 'accept_edits' | 'plan'

/** `POST /api/agent-runs`: the Hub builds the command; it never takes a command line. */
export interface StartAgentRun {
  machine_id: string
  agent: 'claude' | 'codex'
  cwd: string
  /** Its first message, passed as one argument. */
  prompt?: string
  label?: string
  external_ref?: string
  /** Omitted: the agent's own settings decide. `plan` is Claude only. */
  permission_mode?: AgentPermissionMode
  /** Must hold the machine's control lease. */
  device_id?: string
}

export interface StartedAgentRun {
  run: AgentRunInfo
  terminal: TerminalInfo
}

/** `GET /api/machines/{id}/agents`: the coding agent CLIs a machine found. */
export interface InstalledAgent {
  agent: RunAgent
  version?: string
}

// ── Agent sessions (ACP) — mirrors crates/protocol/src/lib.rs ──

export type AgentKind = "claude" | "codex" | "grok" | "kimi"

export type AgentSessionStatus =
  | "starting"
  | "working"
  | "asked"
  | "idle"
  | "error"
  | "disconnected"

/** One model an agent session can run on (mirrors AgentModelInfo in Rust). */
export interface AgentModelInfo {
  model_id: string
  name: string
  description?: string | null
}

export interface AgentSessionInfo {
  id: string
  machine_id: string
  agent_kind: AgentKind
  cwd: string
  /** Agent/user visible title; defaults to the last path segment of `cwd`. */
  title: string
  status: AgentSessionStatus
  auto_run: boolean
  /** Set once session/new returns; needed for resume. */
  acp_session_id?: string | null
  workspace_group_id?: string | null
  /** Models this session can switch between; empty/missing = unsupported. */
  available_models?: AgentModelInfo[]
  /** The model currently in use, if the agent reported one. */
  current_model_id?: string | null
  last_event_seq: number
  created_at_ms: number
}

export interface AgentQuestionOption {
  id: string
  label: string
  detail?: string | null
}

/** Normalized ACP session updates; the hub persists them as the event log. */
export type AgentEvent =
  | { type: "user_message"; text: string }
  | { type: "agent_message_chunk"; text: string }
  | { type: "thought_chunk"; text: string }
  | {
      type: "tool_call"
      tool_call_id: string
      title: string
      kind?: string | null
      status: string
    }
  | {
      type: "tool_call_update"
      tool_call_id: string
      status?: string | null
      content?: string | null
    }
  | { type: "plan"; entries_json: string }
  | {
      type: "question"
      request_id: string
      prompt: string
      options: AgentQuestionOption[]
    }
  | { type: "question_resolved"; request_id: string }
  | { type: "turn_ended"; stop_reason: string }
  | { type: "error"; message: string }

export interface ResourceStats {
  cpu_percent: number
  memory_total: number
  memory_used: number
  disks: DiskInfo[]
}

// ── Hub → Machine messages (discriminated union on "type") ──

export type HubToMachine =
  | HubToMachine.CreateTerminal
  | HubToMachine.DestroyTerminal
  | HubToMachine.TerminalInput
  | HubToMachine.TerminalResize
  | HubToMachine.FsListDir
  | HubToMachine.ImagePaste
  | HubToMachine.Ping

export namespace HubToMachine {
  export interface CreateTerminal {
    type: 'create_terminal'
    request_id: string
    cwd: string
    cols: number
    rows: number
  }

  export interface DestroyTerminal {
    type: 'destroy_terminal'
    terminal_id: string
  }

  export interface TerminalInput {
    type: 'terminal_input'
    terminal_id: string
    data: string
  }

  export interface TerminalResize {
    type: 'terminal_resize'
    terminal_id: string
    cols: number
    rows: number
  }

  export interface FsListDir {
    type: 'fs_list'
    request_id: string
    path: string
  }

  export interface ImagePaste {
    type: 'image_paste'
    terminal_id: string
    /** Base64-encoded image data */
    data: string
    /** MIME type (e.g. "image/png") */
    mime: string
    /** Suggested filename */
    filename: string
  }

  export interface Ping {
    type: 'ping'
  }
}

// ── Machine → Hub messages (discriminated union on "type") ──

export type MachineToHub =
  | MachineToHub.Register
  | MachineToHub.TerminalCreated
  | MachineToHub.TerminalCreateError
  | MachineToHub.TerminalDestroyed
  | MachineToHub.TerminalOutput
  | MachineToHub.FsListResult
  | MachineToHub.FsListError
  | MachineToHub.ResourceStatsMessage
  | MachineToHub.Pong

export namespace MachineToHub {
  export interface Register {
    type: 'register'
    machine_id: string
    name: string
    os: string
    home_dir: string
  }

  export interface TerminalCreated {
    type: 'terminal_created'
    request_id: string
    terminal_id: string
    title: string
    cwd: string
    cols: number
    rows: number
  }

  export interface TerminalCreateError {
    type: 'terminal_create_error'
    request_id: string
    error: string
  }

  export interface TerminalDestroyed {
    type: 'terminal_destroyed'
    terminal_id: string
  }

  export interface TerminalOutput {
    type: 'terminal_output'
    terminal_id: string
    data: string
  }

  export interface FsListResult {
    type: 'fs_list_result'
    request_id: string
    entries: DirEntry[]
  }

  export interface FsListError {
    type: 'fs_list_error'
    request_id: string
    error: string
  }

  export interface ResourceStatsMessage {
    type: 'resource_stats'
    stats: ResourceStats
  }

  export interface Pong {
    type: 'pong'
  }
}

// ── Browser-facing events (Hub → Browser via events WebSocket) ──

export type BrowserEvent =
  | BrowserEvent.MachineOnline
  | BrowserEvent.MachineOffline
  | BrowserEvent.MachineRemoved
  | BrowserEvent.TerminalCreated
  | BrowserEvent.TerminalUpdated
  | BrowserEvent.TerminalResized
  | BrowserEvent.TerminalDestroyed
  | BrowserEvent.TerminalReachableChanged
  | BrowserEvent.WorkspaceGroupCreated
  | BrowserEvent.WorkspaceGroupUpdated
  | BrowserEvent.WorkspaceGroupDeleted
  | BrowserEvent.WorkspaceLayoutUpdated
  | BrowserEvent.MachineStats
  | BrowserEvent.ModeChanged
  | BrowserEvent.AgentSessionCreated
  | BrowserEvent.AgentSessionUpdated
  | BrowserEvent.AgentSessionDestroyed
  | BrowserEvent.AgentSessionEvent
  | BrowserEvent.AgentSessionSeen
  | BrowserEvent.AgentBrowserCreated
  | BrowserEvent.AgentBrowserUpdated
  | BrowserEvent.AgentBrowserDestroyed
  | BrowserEvent.AgentRunUpdated

export namespace BrowserEvent {
  export interface MachineOnline {
    type: 'machine_online'
    machine: MachineInfo
  }

  export interface MachineOffline {
    type: 'machine_offline'
    machine_id: string
  }

  export interface MachineRemoved {
    type: 'machine_removed'
    machine_id: string
  }

  export interface TerminalCreated {
    type: 'terminal_created'
    terminal: TerminalInfo
  }

  export interface TerminalUpdated {
    type: 'terminal_updated'
    terminal: TerminalInfo
  }

  export interface TerminalResized {
    type: 'terminal_resized'
    terminal: TerminalInfo
  }

  export interface TerminalDestroyed {
    type: 'terminal_destroyed'
    machine_id: string
    terminal_id: string
  }

  export interface TerminalReachableChanged {
    type: 'terminal_reachable_changed'
    machine_id: string
    terminal_id: string
    reachable: boolean
  }

  export interface WorkspaceGroupCreated {
    type: 'workspace_group_created'
    group: WorkspaceGroupInfo
  }

  export interface WorkspaceGroupUpdated {
    type: 'workspace_group_updated'
    group: WorkspaceGroupInfo
  }

  export interface WorkspaceGroupDeleted {
    type: 'workspace_group_deleted'
    machine_id: string
    group_id: string
  }

  export interface WorkspaceLayoutUpdated {
    type: 'workspace_layout_updated'
    layout: WorkspaceLayoutInfo
  }

  export interface MachineStats {
    type: 'machine_stats'
    machine_id: string
    stats: ResourceStats
  }

  export interface ModeChanged {
    type: 'mode_changed'
    machine_id: string
    controller_device_id: string | null
  }

  export interface AgentSessionCreated {
    type: 'agent_session_created'
    session: AgentSessionInfo
  }

  export interface AgentSessionUpdated {
    type: 'agent_session_updated'
    session: AgentSessionInfo
  }

  export interface AgentSessionDestroyed {
    type: 'agent_session_destroyed'
    session_id: string
  }

  export interface AgentSessionEvent {
    type: 'agent_session_event'
    session_id: string
    seq: number
    event: AgentEvent
  }

  export interface AgentSessionSeen {
    type: 'agent_session_seen'
    session_id: string
    last_seen_seq: number
  }

  export interface AgentBrowserCreated {
    type: 'agent_browser_created'
    browser: AgentBrowserInfo
  }

  export interface AgentBrowserUpdated {
    type: 'agent_browser_updated'
    browser: AgentBrowserInfo
  }

  export interface AgentBrowserDestroyed {
    type: 'agent_browser_destroyed'
    machine_id: string
    browser_id: string
  }

  /** An agent run started, changed status, or ended. */
  export interface AgentRunUpdated {
    type: 'agent_run_updated'
    run: AgentRunInfo
  }
}

export interface BrowserEventEnvelope {
  seq: number
  event: BrowserEvent
}

export interface EventsPing {
  type: "ping"
  t: number
}

export interface EventsPong {
  type: "pong"
  t: number
}

// ── Auth / persistence types (not in Rust yet) ──

export interface User {
  id: string
  displayName: string
  avatarUrl: string | null
  role: string
}

export interface Bookmark {
  id: string
  machine_id: string
  path: string
  label: string
  sort_order: number
}

export interface LoginResponse {
  token: string
}

export interface CreateRegistrationTokenResponse {
  token: string
  expires_at: number
}

export interface RegisterMachineResponse {
  machineId: string
  machineSecret: string
}

// ── Workspace limits ──

// A tab (a persistent workspace group, or the cwd fallback tab) renders every
// one of its terminals as a split pane on desktop. Past this many the grid is
// squeezed into unusable slivers, so tabs are capped: splits refuse to go over
// it, and terminal creation overflows into a fresh tab instead. Mirrored by
// MAX_PANES_PER_TAB in crates/hub/src/routes/terminals.rs.
export const MAX_PANES_PER_TAB = 4
