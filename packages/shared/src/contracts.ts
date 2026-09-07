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
