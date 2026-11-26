import { describe, expect, it } from "vitest";
import type {
  BrowserEventEnvelope,
  SpaceInfo,
  TerminalInfo,
  WorkspaceGroupInfo,
} from "@offdesk/shared";

import {
  applyBootstrapSnapshot,
  applyBrowserEventEnvelope,
} from "./bootstrapState";
import { countWaitingBySpace, filterGroupsBySpace } from "./spaces";
import { createTerminalWorkspace } from "./terminalWorkspaceLayout";

function makeSpace(overrides: Partial<SpaceInfo> & { id: string; name: string }): SpaceInfo {
  return {
    icon: null,
    color: "#22d3ee",
    default_cwd: null,
    sort_order: 0,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeTerminal(
  overrides: Partial<TerminalInfo> & { id: string; workspace_group_id?: string | null },
): TerminalInfo {
  return {
    machine_id: "m1",
    cwd: "/home/user/proj",
    title: "bash",
    cols: 80,
    rows: 24,
    reachable: true,
    ...overrides,
  };
}

function makeGroupInfo(
  overrides: Partial<WorkspaceGroupInfo> & { id: string; name: string },
): WorkspaceGroupInfo {
  return {
    machine_id: "m1",
    sort_order: 0,
    space_id: null,
    ...overrides,
  };
}

describe("spaces bootstrap & WS state", () => {
  it("loads spaces from bootstrap snapshot and handles space_created/updated/deleted", () => {
    const s1 = makeSpace({ id: "s1", name: "Work", sort_order: 1 });
    const s2 = makeSpace({ id: "s2", name: "Alpha", sort_order: 0 });
    const g1 = makeGroupInfo({ id: "g1", name: "tab 1", space_id: "s1" });

    let state = applyBootstrapSnapshot({
      snapshot_seq: 10,
      machines: [],
      terminals: [],
      spaces: [s1, s2],
      workspace_groups: [g1],
      machine_stats: [],
      control_leases: [],
    });

    expect(state.spaces.map((s) => s.id)).toEqual(["s2", "s1"]);

    const s3 = makeSpace({ id: "s3", name: "Personal", sort_order: 2 });
    const createEnv: BrowserEventEnvelope = {
      seq: 11,
      event: { type: "space_created", space: s3 },
    };
    state = applyBrowserEventEnvelope(state, createEnv);
    expect(state.spaces.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);

    const updateEnv: BrowserEventEnvelope = {
      seq: 12,
      event: { type: "space_updated", space: { ...s1, name: "Work HQ" } },
    };
    state = applyBrowserEventEnvelope(state, updateEnv);
    expect(state.spaces.find((s) => s.id === "s1")?.name).toBe("Work HQ");

    const deleteEnv: BrowserEventEnvelope = {
      seq: 13,
      event: { type: "space_deleted", space_id: "s1" },
    };
    state = applyBrowserEventEnvelope(state, deleteEnv);
    expect(state.spaces.map((s) => s.id)).toEqual(["s2", "s3"]);
    // Deleting a space unassigns its groups without deleting them.
    expect(state.workspaceGroups.find((g) => g.id === "g1")?.space_id).toBeNull();
  });
});

describe("filterGroupsBySpace & countWaitingBySpace", () => {
  it("propagates spaceId, filters groups by activeSpaceId, and counts cross-space waiting terminals", () => {
    const g1 = makeGroupInfo({ id: "g1", name: "api", space_id: "s1", sort_order: 0 });
    const g2 = makeGroupInfo({ id: "g2", name: "web", space_id: "s2", sort_order: 1 });
    const g3 = makeGroupInfo({ id: "g3", name: "misc", space_id: null, sort_order: 2 });

    const t1 = makeTerminal({
      id: "t1",
      workspace_group_id: "g1",
      attention: "confirmation",
    });
    const t2 = makeTerminal({
      id: "t2",
      workspace_group_id: "g2",
      attention: "confirmation",
    });
    const t3 = makeTerminal({
      id: "t3",
      workspace_group_id: "g2",
      attention: null,
    });
    const t4 = makeTerminal({
      id: "t4",
      workspace_group_id: "g3",
      attention: "confirmation",
    });

    const terminals = [t1, t2, t3, t4];
    const ws = createTerminalWorkspace(terminals, "t1", [g1, g2, g3], []);
    const byId = new Map(terminals.map((t) => [t.id, t]));

    expect(ws.groups.map((g) => [g.id, g.spaceId])).toEqual([
      ["g1", "s1"],
      ["g2", "s2"],
      ["g3", null],
    ]);

    expect(filterGroupsBySpace(ws.groups, null).map((g) => g.id)).toEqual(["g3"]);
    expect(filterGroupsBySpace(ws.groups, "s1").map((g) => g.id)).toEqual(["g1"]);
    expect(filterGroupsBySpace(ws.groups, "s2").map((g) => g.id)).toEqual(["g2"]);

    const waiting = countWaitingBySpace(ws.groups, byId);
    expect(waiting.total).toBe(3);
    expect(waiting.bySpace.get("s1")).toBe(1);
    expect(waiting.bySpace.get("s2")).toBe(1);
    expect(waiting.bySpace.get(null)).toBe(1);
  });
});
