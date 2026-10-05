import { describe, expect, it } from "vitest";
import type { BrowserEvent, BrowserEventEnvelope } from "@offdesk/shared";
import {
  applyBootstrapSnapshot,
  applyBrowserEventEnvelope,
  EMPTY_BROWSER_SESSION_STATE,
  shouldResyncForEnvelope,
  type BrowserSessionState,
} from "./bootstrapState";

function stateWithControl(
  machineId: string,
  deviceId: string,
  seq = 10,
): BrowserSessionState {
  return {
    ...EMPTY_BROWSER_SESSION_STATE,
    lastSeq: seq,
    controlLeases: { [machineId]: deviceId },
  };
}

function envelope(seq: number, event: BrowserEvent): BrowserEventEnvelope {
  return { seq, event };
}

describe("applyBootstrapSnapshot", () => {
  it("maps the last focused terminal", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 5,
      machines: [],
      terminals: [],
      workspace_groups: [],
      machine_stats: [],
      control_leases: [],
      last_focused_terminal_id: "term-1",
    });

    expect(state.lastFocusedTerminalId).toBe("term-1");
  });

  it("maps control_leases from snapshot", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 5,
      machines: [],
      terminals: [],
      workspace_groups: [],
      machine_stats: [],
      control_leases: [
        { machine_id: "m1", controller_device_id: "d1" },
        { machine_id: "m2", controller_device_id: null },
      ],
    });
    expect(state.controlLeases).toEqual({ m1: "d1" });
    expect(state.lastSeq).toBe(5);
  });

  it("maps workspace groups from snapshot", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 5,
      machines: [],
      terminals: [],
      workspace_groups: [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
      ],
      machine_stats: [],
      control_leases: [],
    });

    expect(state.workspaceGroups).toEqual([
      { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
    ]);
  });

  it("maps workspace layouts from snapshot", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 5,
      machines: [],
      terminals: [],
      workspace_groups: [],
      workspace_layouts: [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          root: { type: "leaf", terminalId: "term-1" },
          updated_at: 10,
        },
      ],
      machine_stats: [],
      control_leases: [],
    });

    expect(state.workspaceLayouts).toEqual([
      {
        machine_id: "m1",
        group_key: "cwd:/repo",
        root: { type: "leaf", terminalId: "term-1" },
        updated_at: 10,
      },
    ]);
  });
});

describe("workspace tab events", () => {
  it("adds newly created workspace groups", () => {
    const state = applyBrowserEventEnvelope(
      { ...EMPTY_BROWSER_SESSION_STATE, lastSeq: 1 },
      envelope(2, {
        type: "workspace_group_created",
        group: {
          id: "tab-main",
          machine_id: "m1",
          name: "Main",
          sort_order: 0,
        },
      } as BrowserEvent),
    );

    expect(state.workspaceGroups).toEqual([
      { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
    ]);
  });

  it("updates existing workspace groups", () => {
    const state = applyBrowserEventEnvelope(
      {
        ...EMPTY_BROWSER_SESSION_STATE,
        lastSeq: 1,
        workspaceGroups: [
          { id: "tab-a", machine_id: "m1", name: "A", sort_order: 0 },
          { id: "tab-b", machine_id: "m1", name: "B", sort_order: 1 },
        ],
      },
      envelope(2, {
        type: "workspace_group_updated",
        group: {
          id: "tab-b",
          machine_id: "m1",
          name: "B",
          sort_order: -1,
        },
      } as BrowserEvent),
    );

    expect(state.workspaceGroups.map((group) => group.id)).toEqual([
      "tab-b",
      "tab-a",
    ]);
  });

  it("renames a workspace group on workspace_group_updated", () => {
    const state = applyBrowserEventEnvelope(
      {
        ...EMPTY_BROWSER_SESSION_STATE,
        lastSeq: 1,
        workspaceGroups: [
          { id: "tab-a", machine_id: "m1", name: "A", sort_order: 0 },
          { id: "tab-b", machine_id: "m1", name: "B", sort_order: 1 },
        ],
      },
      envelope(2, {
        type: "workspace_group_updated",
        group: {
          id: "tab-b",
          machine_id: "m1",
          name: "Renamed",
          sort_order: 1,
        },
      } as BrowserEvent),
    );

    expect(state.workspaceGroups.map((group) => group.name)).toEqual([
      "A",
      "Renamed",
    ]);
  });

  it("removes deleted workspace groups and clears local terminal assignments", () => {
    const state = applyBrowserEventEnvelope(
      {
        ...EMPTY_BROWSER_SESSION_STATE,
        lastSeq: 1,
        workspaceGroups: [
          { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
          { id: "tab-other", machine_id: "m1", name: "Other", sort_order: 1 },
        ],
        terminals: [
          {
            id: "term-1",
            machine_id: "m1",
            title: "Terminal term-1",
            cwd: "/repo",
            workspace_group_id: "tab-main",
            cols: 80,
            rows: 24,
            reachable: true,
          },
          {
            id: "term-2",
            machine_id: "m1",
            title: "Terminal term-2",
            cwd: "/repo",
            workspace_group_id: "tab-other",
            cols: 80,
            rows: 24,
            reachable: true,
          },
        ],
      },
      envelope(2, {
        type: "workspace_group_deleted",
        machine_id: "m1",
        group_id: "tab-main",
      } as BrowserEvent),
    );

    expect(state.workspaceGroups.map((group) => group.id)).toEqual([
      "tab-other",
    ]);
    expect(state.terminals.find((terminal) => terminal.id === "term-1"))
      .toMatchObject({ workspace_group_id: null });
    expect(state.terminals.find((terminal) => terminal.id === "term-2"))
      .toMatchObject({ workspace_group_id: "tab-other" });
  });

  it("updates terminal workspace group assignment", () => {
    const state = applyBrowserEventEnvelope(
      {
        ...EMPTY_BROWSER_SESSION_STATE,
        lastSeq: 1,
        terminals: [
          {
            id: "term-1",
            machine_id: "m1",
            title: "Terminal term-1",
            cwd: "/repo",
            workspace_group_id: null,
            cols: 80,
            rows: 24,
            reachable: true,
          },
        ],
      },
      envelope(2, {
        type: "terminal_updated",
        terminal: {
          id: "term-1",
          machine_id: "m1",
          title: "Terminal term-1",
          cwd: "/repo",
          workspace_group_id: "tab-main",
          cols: 80,
          rows: 24,
          reachable: true,
        },
      } as BrowserEvent),
    );

    expect(state.terminals[0]?.workspace_group_id).toBe("tab-main");
  });

  it("updates saved workspace layouts", () => {
    const state = applyBrowserEventEnvelope(
      { ...EMPTY_BROWSER_SESSION_STATE, lastSeq: 1 },
      envelope(2, {
        type: "workspace_layout_updated",
        layout: {
          machine_id: "m1",
          group_key: "cwd:/repo",
          root: { type: "leaf", terminalId: "term-1" },
          updated_at: 20,
        },
      } as BrowserEvent),
    );

    expect(state.workspaceLayouts).toEqual([
      {
        machine_id: "m1",
        group_key: "cwd:/repo",
        root: { type: "leaf", terminalId: "term-1" },
        updated_at: 20,
      },
    ]);
  });
});

describe("mode_changed event", () => {
  it("sets control lease when controller_device_id is present", () => {
    const state = applyBrowserEventEnvelope(
      { ...EMPTY_BROWSER_SESSION_STATE, lastSeq: 1 },
      envelope(2, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: "d1",
      }),
    );
    expect(state.controlLeases).toEqual({ m1: "d1" });
  });

  it("removes control lease when controller_device_id is null", () => {
    const state = applyBrowserEventEnvelope(
      stateWithControl("m1", "d1", 1),
      envelope(2, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: null,
      }),
    );
    expect(state.controlLeases).toEqual({});
  });

  it("replaces existing controller with new device", () => {
    const state = applyBrowserEventEnvelope(
      stateWithControl("m1", "d1", 1),
      envelope(2, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: "d2",
      }),
    );
    expect(state.controlLeases).toEqual({ m1: "d2" });
  });

  it("does not affect other machines' leases", () => {
    const initial: BrowserSessionState = {
      ...EMPTY_BROWSER_SESSION_STATE,
      lastSeq: 1,
      controlLeases: { m1: "d1", m2: "d2" },
    };
    const state = applyBrowserEventEnvelope(
      initial,
      envelope(2, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: null,
      }),
    );
    expect(state.controlLeases).toEqual({ m2: "d2" });
  });
});

describe("machine_offline event", () => {
  it("removes control lease for the offline machine", () => {
    const state = applyBrowserEventEnvelope(
      stateWithControl("m1", "d1", 1),
      envelope(2, { type: "machine_offline", machine_id: "m1" }),
    );
    expect(state.controlLeases).toEqual({});
  });
});

describe("machine_removed event", () => {
  it("drops the machine and everything that belonged to it", () => {
    const initial: BrowserSessionState = {
      ...EMPTY_BROWSER_SESSION_STATE,
      lastSeq: 1,
      lastFocusedTerminalId: "t1",
      machines: [
        { id: "m1", name: "nas", os: "linux", home_dir: "/" },
        { id: "m2", name: "mbp", os: "darwin", home_dir: "/" },
      ],
      terminals: [
        {
          id: "t1",
          machine_id: "m1",
          title: "bash",
          cwd: "/",
          cols: 80,
          rows: 24,
          reachable: false,
        },
        {
          id: "t2",
          machine_id: "m2",
          title: "zsh",
          cwd: "/",
          cols: 80,
          rows: 24,
          reachable: true,
        },
      ],
      workspaceGroups: [
        { id: "g1", machine_id: "m1", name: "tab 1", sort_order: 0 },
        { id: "g2", machine_id: "m2", name: "tab 1", sort_order: 0 },
      ],
      workspaceLayouts: [
        { machine_id: "m1", group_key: "g1", root: null, updated_at: 1 },
      ],
      machineStats: {
        m1: {
          cpu_percent: 1,
          memory_total: 1,
          memory_used: 1,
          disks: [],
        },
      },
      controlLeases: { m1: "d1", m2: "d2" },
    };

    const state = applyBrowserEventEnvelope(
      initial,
      envelope(2, { type: "machine_removed", machine_id: "m1" }),
    );

    expect(state.machines.map((machine) => machine.id)).toEqual(["m2"]);
    expect(state.terminals.map((terminal) => terminal.id)).toEqual(["t2"]);
    expect(state.workspaceGroups.map((group) => group.id)).toEqual(["g2"]);
    expect(state.workspaceLayouts).toEqual([]);
    expect(state.machineStats).toEqual({});
    expect(state.controlLeases).toEqual({ m2: "d2" });
    expect(state.lastFocusedTerminalId).toBeNull();
  });
});

describe("shouldResyncForEnvelope", () => {
  it("returns false for first event after bootstrap", () => {
    const state = { ...EMPTY_BROWSER_SESSION_STATE, lastSeq: 5 };
    expect(shouldResyncForEnvelope(state, { seq: 6, event: {} as BrowserEvent })).toBe(false);
  });

  it("returns true when sequence gap detected", () => {
    const state = { ...EMPTY_BROWSER_SESSION_STATE, lastSeq: 5 };
    expect(shouldResyncForEnvelope(state, { seq: 8, event: {} as BrowserEvent })).toBe(true);
  });

  it("returns false when lastSeq is 0 (initial state)", () => {
    expect(
      shouldResyncForEnvelope(EMPTY_BROWSER_SESSION_STATE, {
        seq: 100,
        event: {} as BrowserEvent,
      }),
    ).toBe(false);
  });
});

describe("applyBrowserEventEnvelope", () => {
  it("ignores events with seq <= lastSeq", () => {
    const initial = stateWithControl("m1", "d1", 5);
    const result = applyBrowserEventEnvelope(
      initial,
      envelope(5, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: null,
      }),
    );
    expect(result).toBe(initial);
  });

  it("returns original state when resync needed", () => {
    const initial = stateWithControl("m1", "d1", 5);
    const result = applyBrowserEventEnvelope(
      initial,
      envelope(10, {
        type: "mode_changed",
        machine_id: "m1",
        controller_device_id: null,
      }),
    );
    expect(result).toBe(initial);
  });
});

describe("to-dos", () => {
  const todo = (id: string, updated_at: number, title = id) => ({
    id,
    title,
    notes: "",
    status: "open" as const,
    position: 0,
    created_at: 1,
    updated_at,
  });

  it("come from the snapshot and follow live upserts and deletes", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 5,
      machines: [],
      terminals: [],
      machine_stats: [],
      control_leases: [],
      todos: [todo("a", 1)],
    });
    expect(state.todos.map((t) => t.id)).toEqual(["a"]);

    const added = applyBrowserEventEnvelope(state, envelope(6, { type: "todo_upserted", todo: todo("b", 2) }));
    expect(added.todos.map((t) => t.id)).toEqual(["a", "b"]);

    const edited = applyBrowserEventEnvelope(added, envelope(7, { type: "todo_upserted", todo: todo("a", 3, "edited") }));
    expect(edited.todos.find((t) => t.id === "a")?.title).toBe("edited");

    // A stale copy (an older write echoed late) never replaces a newer one.
    const stale = applyBrowserEventEnvelope(edited, envelope(8, { type: "todo_upserted", todo: todo("a", 2, "stale") }));
    expect(stale.todos.find((t) => t.id === "a")?.title).toBe("edited");

    const removed = applyBrowserEventEnvelope(stale, envelope(9, { type: "todo_deleted", id: "b" }));
    expect(removed.todos.map((t) => t.id)).toEqual(["a"]);
  });

  it("default to an empty list from older Hubs", () => {
    const state = applyBootstrapSnapshot({
      snapshot_seq: 1,
      machines: [],
      terminals: [],
      machine_stats: [],
      control_leases: [],
    });
    expect(state.todos).toEqual([]);
  });
});
