import type {
  BrowserEvent,
  BrowserEventEnvelope,
  BrowserStateSnapshot,
  MachineInfo,
  ResourceStats,
  TerminalInfo,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
} from "@offdesk/shared";

export interface BrowserSessionState {
  lastSeq: number;
  lastFocusedTerminalId: string | null;
  machines: MachineInfo[];
  terminals: TerminalInfo[];
  workspaceGroups: WorkspaceGroupInfo[];
  workspaceLayouts: WorkspaceLayoutInfo[];
  machineStats: Record<string, ResourceStats>;
  controlLeases: Record<string, string>;
}

export const EMPTY_BROWSER_SESSION_STATE: BrowserSessionState = {
  lastSeq: 0,
  lastFocusedTerminalId: null,
  machines: [],
  terminals: [],
  workspaceGroups: [],
  workspaceLayouts: [],
  machineStats: {},
  controlLeases: {},
};

export function applyBootstrapSnapshot(
  snapshot: BrowserStateSnapshot,
): BrowserSessionState {
  return {
    lastSeq: snapshot.snapshot_seq,
    lastFocusedTerminalId: snapshot.last_focused_terminal_id ?? null,
    machines: snapshot.machines,
    terminals: snapshot.terminals,
    workspaceGroups: snapshot.workspace_groups ?? [],
    workspaceLayouts: snapshot.workspace_layouts ?? [],
    machineStats: Object.fromEntries(
      snapshot.machine_stats.map(({ machine_id, stats }) => [machine_id, stats]),
    ),
    controlLeases: Object.fromEntries(
      snapshot.control_leases.flatMap(({ machine_id, controller_device_id }) =>
        controller_device_id ? [[machine_id, controller_device_id]] : [],
      ),
    ),
  };
}

export function applyBrowserEventEnvelope(
  state: BrowserSessionState,
  envelope: BrowserEventEnvelope,
): BrowserSessionState {
  if (shouldResyncForEnvelope(state, envelope)) {
    return state;
  }

  if (envelope.seq <= state.lastSeq) {
    return state;
  }

  return {
    ...applyBrowserEvent(state, envelope.event),
    lastSeq: envelope.seq,
  };
}

export function shouldResyncForEnvelope(
  state: Pick<BrowserSessionState, "lastSeq">,
  envelope: BrowserEventEnvelope,
): boolean {
  return state.lastSeq > 0 && envelope.seq > state.lastSeq + 1;
}

function applyBrowserEvent(
  state: BrowserSessionState,
  event: BrowserEvent,
): Omit<BrowserSessionState, "lastSeq"> & { lastSeq?: number } {
  switch (event.type) {
    case "machine_online":
      return {
        ...state,
        machines: upsertMachine(state.machines, event.machine),
      };
    case "machine_offline": {
      const nextStats = omitKey(state.machineStats, event.machine_id);
      const nextLeases = omitKey(state.controlLeases, event.machine_id);
      return {
        ...state,
        // Keep machines list unchanged — machine info needed for unreachable terminals
        machineStats: nextStats,
        controlLeases: nextLeases,
      };
    }
    case "machine_removed": {
      const machineId = event.machine_id;
      const remainingTerminals = state.terminals.filter(
        (terminal) => terminal.machine_id !== machineId,
      );
      const lastFocusedStillPresent = remainingTerminals.some(
        (terminal) => terminal.id === state.lastFocusedTerminalId,
      );
      return {
        ...state,
        machines: state.machines.filter((machine) => machine.id !== machineId),
        terminals: remainingTerminals,
        workspaceGroups: state.workspaceGroups.filter(
          (group) => group.machine_id !== machineId,
        ),
        workspaceLayouts: state.workspaceLayouts.filter(
          (layout) => layout.machine_id !== machineId,
        ),
        machineStats: omitKey(state.machineStats, machineId),
        controlLeases: omitKey(state.controlLeases, machineId),
        lastFocusedTerminalId: lastFocusedStillPresent
          ? state.lastFocusedTerminalId
          : null,
      };
    }
    case "terminal_created":
    case "terminal_updated":
    case "terminal_resized":
      return {
        ...state,
        terminals: upsertTerminal(state.terminals, event.terminal),
      };
    case "workspace_group_created":
    case "workspace_group_updated":
      return {
        ...state,
        workspaceGroups: upsertWorkspaceGroup(
          state.workspaceGroups,
          event.group,
        ),
      };
    case "workspace_group_deleted":
      return {
        ...state,
        workspaceGroups: state.workspaceGroups.filter(
          (group) =>
            !(
              group.machine_id === event.machine_id &&
              group.id === event.group_id
            ),
        ),
        terminals: state.terminals.map((terminal) =>
          terminal.machine_id === event.machine_id &&
          terminal.workspace_group_id === event.group_id
            ? { ...terminal, workspace_group_id: null }
            : terminal,
        ),
        workspaceLayouts: state.workspaceLayouts.filter(
          (layout) =>
            !(
              layout.machine_id === event.machine_id &&
              layout.group_key === event.group_id
            ),
        ),
      };
    case "workspace_layout_updated":
      return {
        ...state,
        workspaceLayouts: upsertWorkspaceLayout(
          state.workspaceLayouts,
          event.layout,
        ),
      };
    case "terminal_destroyed":
      return {
        ...state,
        terminals: state.terminals.filter(
          (terminal) => terminal.id !== event.terminal_id,
        ),
      };
    case "terminal_reachable_changed":
      return {
        ...state,
        terminals: state.terminals.map((terminal) =>
          terminal.id === event.terminal_id && terminal.machine_id === event.machine_id
            ? { ...terminal, reachable: event.reachable }
            : terminal,
        ),
      };
    case "machine_stats":
      return {
        ...state,
        machineStats: {
          ...state.machineStats,
          [event.machine_id]: event.stats,
        },
      };
    case "mode_changed":
      if (!event.controller_device_id) {
        return {
          ...state,
          controlLeases: omitKey(state.controlLeases, event.machine_id),
        };
      }
      return {
        ...state,
        controlLeases: {
          ...state.controlLeases,
          [event.machine_id]: event.controller_device_id,
        },
      };
    default:
      return state;
  }
}

// Return a copy of `record` with `key` removed. Replaces the
// `const { [key]: _, ...rest } = record` pattern, which the current Metro /
// Babel toolchain mistranspiles for computed-key rest-spread in release
// bundles (the key was retained in `rest`, leaving stale control leases
// after a release). See design-refresh PR #141.
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next: Record<string, T> = {};
  for (const k of Object.keys(record)) {
    if (k !== key) next[k] = record[k];
  }
  return next;
}

function upsertMachine(
  machines: MachineInfo[],
  machine: MachineInfo,
): MachineInfo[] {
  const existingIndex = machines.findIndex((item) => item.id === machine.id);
  if (existingIndex === -1) {
    return [...machines, machine];
  }
  const next = machines.slice();
  next[existingIndex] = machine;
  return next;
}

function upsertTerminal(
  terminals: TerminalInfo[],
  terminal: TerminalInfo,
): TerminalInfo[] {
  const existingIndex = terminals.findIndex((item) => item.id === terminal.id);
  if (existingIndex === -1) {
    return [...terminals, terminal];
  }
  const next = terminals.slice();
  next[existingIndex] = terminal;
  return next;
}

function upsertWorkspaceGroup(
  groups: WorkspaceGroupInfo[],
  group: WorkspaceGroupInfo,
): WorkspaceGroupInfo[] {
  const existingIndex = groups.findIndex((item) => item.id === group.id);
  const next =
    existingIndex === -1
      ? [...groups, group]
      : groups.map((item) => (item.id === group.id ? group : item));
  return next.sort(
    (a, b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      a.sort_order - b.sort_order ||
      a.name.localeCompare(b.name),
  );
}

function upsertWorkspaceLayout(
  layouts: WorkspaceLayoutInfo[],
  layout: WorkspaceLayoutInfo,
): WorkspaceLayoutInfo[] {
  const existingIndex = layouts.findIndex(
    (item) =>
      item.machine_id === layout.machine_id && item.group_key === layout.group_key,
  );
  const next =
    existingIndex === -1
      ? [...layouts, layout]
      : layouts.map((item) =>
          item.machine_id === layout.machine_id &&
          item.group_key === layout.group_key
            ? layout
            : item,
        );
  return next.sort(
    (a, b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      a.group_key.localeCompare(b.group_key),
  );
}
