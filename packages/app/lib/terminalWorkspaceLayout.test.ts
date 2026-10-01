import { describe, expect, it } from "vitest";
import type { TerminalInfo, WorkspaceGroupInfo } from "@offdesk/shared";
import {
  labelFromCwd,
  MAX_PANES_PER_TAB,
  appendWorkspacePaneToGroup,
  buildReorderPersistentGroupIds,
  closeWorkspacePane,
  collectGroupPaneTerminalIds,
  collectPaneTerminalIds,
  createTerminalWorkspace,
  equalizeWorkspaceLayout,
  getActiveWorkspaceGroup,
  findAdjacentWorkspacePane,
  flattenWorkspacePanes,
  getMobileWorkspaceTabs,
  isWorkspaceGroupFull,
  mountedWorkspaceGroupIds,
  planNewTerminalPlacement,
  reconcileTerminalWorkspace,
  rotateWorkspaceLayout,
  selectWorkspaceGroup,
  splitWorkspacePane,
  swapWorkspacePanes,
  workspacePaneOrder,
} from "./terminalWorkspaceLayout";
import type {
  TerminalWorkspace,
  WorkspacePaneNode,
} from "./terminalWorkspaceLayout";

// Bare workspace shell for mountedWorkspaceGroupIds: group contents are
// irrelevant there, only which ids exist and which is active.
function workspaceWithGroups(
  groupIds: string[],
  activeGroupId: string,
): TerminalWorkspace {
  return {
    groups: groupIds.map((id) => ({
      id,
      label: id,
      cwd: "/",
      workspaceGroupId: null,
      persistent: false,
      root: null,
      paneCount: 0,
    })),
    activeGroupId,
    activeTerminalId: null,
  };
}

function terminal(id: string, cwd: string): TerminalInfo {
  return {
    id,
    machine_id: "m1",
    title: `Terminal ${id}`,
    cwd,
    cols: 120,
    rows: 40,
    reachable: true,
  };
}

function groupedTerminal(
  id: string,
  cwd: string,
  workspaceGroupId: string | null,
): TerminalInfo {
  return {
    ...terminal(id, cwd),
    workspace_group_id: workspaceGroupId,
  } as TerminalInfo;
}

// Horizontal width fraction of each leaf when the tree fills width 1.
function leafWidths(root: WorkspacePaneNode | null): Record<string, number> {
  const widths: Record<string, number> = {};
  const walk = (node: WorkspacePaneNode | null, width: number) => {
    if (!node) return;
    if (node.type === "leaf") {
      widths[node.terminalId] = width;
      return;
    }
    if (node.direction === "horizontal") {
      walk(node.first, width * node.ratio);
      walk(node.second, width * (1 - node.ratio));
      return;
    }
    walk(node.first, width);
    walk(node.second, width);
  };
  walk(root, 1);
  return widths;
}

describe("terminalWorkspaceLayout", () => {
  const terminals = [
    terminal("web-1", "/home/chareice/projects/offdesk"),
    terminal("web-2", "/home/chareice/projects/offdesk"),
    terminal("api-1", "/home/chareice/projects/zhuyang"),
  ];

  it("groups terminals by working directory and activates the selected terminal's group", () => {
    const workspace = createTerminalWorkspace(terminals, "api-1");

    expect(workspace.activeGroupId).toBe(
      "cwd:/home/chareice/projects/zhuyang",
    );
    expect(workspace.groups.map((group) => group.label)).toEqual([
      "offdesk",
      "zhuyang",
    ]);
    expect(workspace.groups.map((group) => group.paneCount)).toEqual([2, 1]);
    expect(collectPaneTerminalIds(workspace.groups[0].root)).toEqual([
      "web-1",
      "web-2",
    ]);
  });

  it("keeps cwd fallback group order stable when terminal snapshots arrive in a different order", () => {
    const firstSnapshot = createTerminalWorkspace(
      [
        terminal("api-1", "/home/chareice/projects/zhuyang"),
        terminal("web-1", "/home/chareice/projects/offdesk"),
        terminal("ops-1", "/home/chareice/projects/ops"),
      ],
      "api-1",
    );
    const secondSnapshot = createTerminalWorkspace(
      [
        terminal("ops-1", "/home/chareice/projects/ops"),
        terminal("web-1", "/home/chareice/projects/offdesk"),
        terminal("api-1", "/home/chareice/projects/zhuyang"),
      ],
      "api-1",
    );

    expect(firstSnapshot.groups.map((group) => group.label)).toEqual([
      "offdesk",
      "ops",
      "zhuyang",
    ]);
    expect(secondSnapshot.groups.map((group) => group.label)).toEqual(
      firstSnapshot.groups.map((group) => group.label),
    );
  });

  it("restores a persisted pane layout when creating a fresh workspace", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "c",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              type: "split",
              direction: "vertical",
              ratio: 0.5,
              first: { type: "leaf", terminalId: "a" },
              second: { type: "leaf", terminalId: "c" },
            },
            second: { type: "leaf", terminalId: "b" },
          },
        },
      ],
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(collectPaneTerminalIds(root)).toEqual(["a", "c", "b"]);
    expect(root).toMatchObject({
      type: "split",
      direction: "horizontal",
      first: {
        type: "split",
        direction: "vertical",
        first: { type: "leaf", terminalId: "a" },
        second: { type: "leaf", terminalId: "c" },
      },
      second: { type: "leaf", terminalId: "b" },
    });
  });

  it("restores a persisted workspace tab pane layout", () => {
    const workspace = createTerminalWorkspace(
      [
        groupedTerminal("a", "/repo", "tab-main"),
        groupedTerminal("b", "/repo", "tab-main"),
        groupedTerminal("c", "/repo", "tab-main"),
      ],
      "a",
      [{ id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 }],
      [
        {
          machine_id: "m1",
          group_key: "tab-main",
          updated_at: 11,
          root: {
            type: "split",
            direction: "vertical",
            ratio: 0.55,
            first: { type: "leaf", terminalId: "b" },
            second: {
              type: "split",
              direction: "horizontal",
              ratio: 0.45,
              first: { type: "leaf", terminalId: "c" },
              second: { type: "leaf", terminalId: "a" },
            },
          },
        },
      ],
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(collectPaneTerminalIds(root)).toEqual(["b", "c", "a"]);
    expect(root).toMatchObject({
      type: "split",
      direction: "vertical",
      first: { type: "leaf", terminalId: "b" },
      second: {
        type: "split",
        direction: "horizontal",
        first: { type: "leaf", terminalId: "c" },
        second: { type: "leaf", terminalId: "a" },
      },
    });
  });

  it("tiles panes evenly when the saved layout only references destroyed terminals", () => {
    const workspace = createTerminalWorkspace(
      [
        terminal("t1", "/repo"),
        terminal("t2", "/repo"),
        terminal("t3", "/repo"),
        terminal("t4", "/repo"),
      ],
      "t1",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: { type: "leaf", terminalId: "dead-1" },
            second: {
              type: "split",
              direction: "horizontal",
              ratio: 0.5,
              first: { type: "leaf", terminalId: "dead-2" },
              second: { type: "leaf", terminalId: "dead-3" },
            },
          },
        },
      ],
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.25,
      first: { type: "leaf", terminalId: "t1" },
      second: {
        type: "split",
        direction: "horizontal",
        ratio: 1 / 3,
        first: { type: "leaf", terminalId: "t2" },
        second: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", terminalId: "t3" },
          second: { type: "leaf", terminalId: "t4" },
        },
      },
    });
    const widths = leafWidths(root);
    for (const id of ["t1", "t2", "t3", "t4"]) {
      expect(widths[id]).toBeCloseTo(0.25);
    }
  });

  it("keeps surviving saved geometry and appends leftovers with a proportional split", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "a",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "horizontal",
            ratio: 0.3,
            first: {
              type: "split",
              direction: "vertical",
              ratio: 0.7,
              first: { type: "leaf", terminalId: "a" },
              second: { type: "leaf", terminalId: "dead-1" },
            },
            second: { type: "leaf", terminalId: "b" },
          },
        },
      ],
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 2 / 3,
      first: {
        type: "split",
        direction: "horizontal",
        ratio: 0.3,
        first: { type: "leaf", terminalId: "a" },
        second: { type: "leaf", terminalId: "b" },
      },
      second: { type: "leaf", terminalId: "c" },
    });
  });

  it("tiles a cwd fallback group with no saved layout evenly", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "a",
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    const widths = leafWidths(root);
    for (const id of ["a", "b", "c"]) {
      expect(widths[id]).toBeCloseTo(1 / 3);
    }
  });

  it("appends panes as even columns instead of halving the whole row", () => {
    let workspace = createTerminalWorkspace([terminal("a", "/repo")], "a");
    for (const id of ["b", "c", "d"]) {
      workspace = appendWorkspacePaneToGroup(workspace, {
        groupId: workspace.groups[0].id,
        newTerminalId: id,
      });
    }

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(collectPaneTerminalIds(root)).toEqual(["a", "b", "c", "d"]);
    const widths = leafWidths(root);
    for (const id of ["a", "b", "c", "d"]) {
      expect(widths[id]).toBeCloseTo(0.25);
    }
  });

  it("reconcile appends newly arrived terminals as even columns", () => {
    const previous = createTerminalWorkspace([terminal("a", "/repo")], "a");
    const workspace = reconcileTerminalWorkspace(
      previous,
      [
        terminal("a", "/repo"),
        terminal("b", "/repo"),
        terminal("c", "/repo"),
        terminal("d", "/repo"),
      ],
      "a",
    );

    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
    expect(collectPaneTerminalIds(root)).toEqual(["a", "b", "c", "d"]);
    const widths = leafWidths(root);
    for (const id of ["a", "b", "c", "d"]) {
      expect(widths[id]).toBeCloseTo(0.25);
    }
  });

  it("equalizes a degenerate append chain back to even columns", () => {
    // The old appendNode shape: ((A|B)|C)|D, every split 0.5 → 1/8,1/8,1/4,1/2.
    const workspace = createTerminalWorkspace(
      [
        terminal("a", "/repo"),
        terminal("b", "/repo"),
        terminal("c", "/repo"),
        terminal("d", "/repo"),
      ],
      "a",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              type: "split",
              direction: "horizontal",
              ratio: 0.5,
              first: {
                type: "split",
                direction: "horizontal",
                ratio: 0.5,
                first: { type: "leaf", terminalId: "a" },
                second: { type: "leaf", terminalId: "b" },
              },
              second: { type: "leaf", terminalId: "c" },
            },
            second: { type: "leaf", terminalId: "d" },
          },
        },
      ],
    );

    const next = equalizeWorkspaceLayout(workspace);
    const root = getActiveWorkspaceGroup(next)?.root ?? null;
    expect(collectPaneTerminalIds(root)).toEqual(["a", "b", "c", "d"]);
    const widths = leafWidths(root);
    for (const id of ["a", "b", "c", "d"]) {
      expect(widths[id]).toBeCloseTo(0.25);
    }
    // Structure and direction are preserved: still a left-leaning
    // horizontal chain with ratios 1/2, 2/3, 3/4 inside-out.
    expect(root).toMatchObject({
      type: "split",
      direction: "horizontal",
      ratio: 0.75,
      first: {
        type: "split",
        direction: "horizontal",
        ratio: 2 / 3,
        first: { type: "split", direction: "horizontal", ratio: 0.5 },
        second: { type: "leaf", terminalId: "c" },
      },
      second: { type: "leaf", terminalId: "d" },
    });
  });

  it("equalizes a mixed horizontal/vertical tree without changing its structure", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "a",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "horizontal",
            ratio: 0.8,
            first: { type: "leaf", terminalId: "a" },
            second: {
              type: "split",
              direction: "vertical",
              ratio: 0.3,
              first: { type: "leaf", terminalId: "b" },
              second: { type: "leaf", terminalId: "c" },
            },
          },
        },
      ],
    );

    const next = equalizeWorkspaceLayout(workspace);
    expect(getActiveWorkspaceGroup(next)?.root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", terminalId: "a" },
      second: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", terminalId: "b" },
        second: { type: "leaf", terminalId: "c" },
      },
    });
  });

  it("equalizes rows when the outer split is vertical", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "a",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "vertical",
            ratio: 0.9,
            first: {
              type: "split",
              direction: "horizontal",
              ratio: 0.1,
              first: { type: "leaf", terminalId: "a" },
              second: { type: "leaf", terminalId: "b" },
            },
            second: { type: "leaf", terminalId: "c" },
          },
        },
      ],
    );

    const next = equalizeWorkspaceLayout(workspace);
    expect(getActiveWorkspaceGroup(next)?.root).toEqual({
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "leaf", terminalId: "a" },
        second: { type: "leaf", terminalId: "b" },
      },
      second: { type: "leaf", terminalId: "c" },
    });
  });

  it("leaves a single-pane group untouched when equalizing", () => {
    const workspace = createTerminalWorkspace([terminal("a", "/repo")], "a");
    expect(equalizeWorkspaceLayout(workspace)).toBe(workspace);
  });

  it("groups panes by persisted workspace tab before falling back to cwd", () => {
    const workspace = createTerminalWorkspace(
      [
        groupedTerminal("web-1", "/home/chareice/projects/offdesk", "tab-agents"),
        groupedTerminal("api-1", "/home/chareice/projects/zhuyang", "tab-agents"),
        terminal("ops-1", "/home/chareice/projects/ops"),
      ],
      "api-1",
      [
        {
          id: "tab-agents",
          machine_id: "m1",
          name: "Agents",
          sort_order: 0,
        },
      ],
    );

    expect(workspace.activeGroupId).toBe("tab-agents");
    expect(workspace.groups.map((group) => group.label)).toEqual([
      "Agents",
      "ops",
    ]);
    expect(collectPaneTerminalIds(workspace.groups[0].root)).toEqual([
      "web-1",
      "api-1",
    ]);
  });

  it("keeps empty persisted workspace tabs visible after reconcile", () => {
    const workspace = createTerminalWorkspace(
      [groupedTerminal("web-1", "/repo", "tab-main")],
      "web-1",
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );

    const next = reconcileTerminalWorkspace(
      workspace,
      [],
      null,
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );

    expect(next.groups.map((group) => [group.id, group.paneCount])).toEqual([
      ["tab-main", 0],
      ["tab-empty", 0],
    ]);
  });

  it("keeps a persisted workspace tab visible after closing its last pane", () => {
    const workspace = createTerminalWorkspace(
      [groupedTerminal("web-1", "/repo", "tab-main")],
      "web-1",
      [{ id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 }],
    );

    const next = closeWorkspacePane(workspace, "web-1");

    expect(next.groups.map((group) => [group.id, group.paneCount])).toEqual([
      ["tab-main", 0],
    ]);
  });

  it("keeps the active cwd group visible after closing its last pane", () => {
    const workspace = createTerminalWorkspace([terminal("web-1", "/repo")], "web-1");

    const closed = closeWorkspacePane(workspace, "web-1");
    const reconciled = reconcileTerminalWorkspace(closed, [], closed.activeTerminalId);

    expect(closed.groups.map((group) => [group.id, group.paneCount])).toEqual([
      ["cwd:/repo", 0],
    ]);
    expect(closed.activeGroupId).toBe("cwd:/repo");
    expect(closed.activeTerminalId).toBeNull();
    expect(reconciled.groups.map((group) => [group.id, group.paneCount]))
      .toEqual([["cwd:/repo", 0]]);
    expect(reconciled.activeGroupId).toBe("cwd:/repo");
    expect(reconciled.activeTerminalId).toBeNull();
  });

  it("keeps the active cwd group visible when the last terminal disappears before close applies", () => {
    const workspace = createTerminalWorkspace([terminal("web-1", "/root")], "web-1");

    const reconciled = reconcileTerminalWorkspace(workspace, [], "web-1");

    expect(reconciled.groups.map((group) => [group.id, group.paneCount]))
      .toEqual([["cwd:/root", 0]]);
    expect(reconciled.groups[0].root).toBeNull();
    expect(reconciled.activeGroupId).toBe("cwd:/root");
    expect(reconciled.activeTerminalId).toBeNull();
  });

  it("keeps an empty persisted workspace tab active without falling back to another terminal", () => {
    const workspace = createTerminalWorkspace(
      [groupedTerminal("web-1", "/repo", "tab-main")],
      "web-1",
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );

    const selected = selectWorkspaceGroup(workspace, "tab-empty");
    const reconciled = reconcileTerminalWorkspace(
      selected,
      [groupedTerminal("web-1", "/repo", "tab-main")],
      selected.activeTerminalId,
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );

    expect(reconciled.activeGroupId).toBe("tab-empty");
    expect(reconciled.activeTerminalId).toBeNull();
  });

  it("can add the first pane to an empty persisted workspace tab", () => {
    const workspace = createTerminalWorkspace(
      [groupedTerminal("web-1", "/repo", "tab-main")],
      "web-1",
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );
    const selected = selectWorkspaceGroup(workspace, "tab-empty");

    const next = appendWorkspacePaneToGroup(selected, {
      groupId: "tab-empty",
      newTerminalId: "web-2",
    });

    expect(next.activeGroupId).toBe("tab-empty");
    expect(next.activeTerminalId).toBe("web-2");
    expect(
      collectPaneTerminalIds(
        next.groups.find((group) => group.id === "tab-empty")?.root ?? null,
      ),
    ).toEqual(["web-2"]);
  });

  it("does not duplicate a pane that is already present in the group", () => {
    const workspace = createTerminalWorkspace(
      [groupedTerminal("web-1", "/repo", "tab-main")],
      "web-1",
      [
        { id: "tab-main", machine_id: "m1", name: "Main", sort_order: 0 },
        { id: "tab-empty", machine_id: "m1", name: "Scratch", sort_order: 1 },
      ],
    );
    const selected = selectWorkspaceGroup(workspace, "tab-empty");
    const appended = appendWorkspacePaneToGroup(selected, {
      groupId: "tab-empty",
      newTerminalId: "web-2",
    });

    const next = appendWorkspacePaneToGroup(appended, {
      groupId: "tab-empty",
      newTerminalId: "web-2",
    });

    expect(next).toBe(appended);
    expect(
      collectPaneTerminalIds(
        next.groups.find((group) => group.id === "tab-empty")?.root ?? null,
      ),
    ).toEqual(["web-2"]);
  });

  it("splits the active pane without moving terminals to another group", () => {
    const workspace = createTerminalWorkspace(terminals, "web-1");
    const next = splitWorkspacePane(workspace, {
      activeTerminalId: "web-1",
      newTerminalId: "web-3",
      direction: "right",
    });
    const activeGroup = getActiveWorkspaceGroup(next);

    expect(activeGroup?.label).toBe("offdesk");
    expect(activeGroup?.root).toMatchObject({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        first: { type: "leaf", terminalId: "web-1" },
        second: { type: "leaf", terminalId: "web-3" },
      },
      second: { type: "leaf", terminalId: "web-2" },
    });
    expect(collectPaneTerminalIds(activeGroup?.root ?? null)).toEqual([
      "web-1",
      "web-3",
      "web-2",
    ]);
    expect(next.activeTerminalId).toBe("web-3");
  });

  it("moves an already appended terminal into the requested split instead of duplicating it", () => {
    const workspace = createTerminalWorkspace(
      [
        terminal("web-1", "/repo"),
        terminal("web-2", "/repo"),
      ],
      "web-1",
    );

    const next = splitWorkspacePane(workspace, {
      activeTerminalId: "web-1",
      newTerminalId: "web-2",
      direction: "right",
    });

    expect(
      collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null),
    ).toEqual(["web-1", "web-2"]);
  });

  it("swaps two panes inside the active split tree", () => {
    const base = createTerminalWorkspace(
      [
        terminal("left", "/repo"),
        terminal("top", "/repo"),
        terminal("bottom", "/repo"),
      ],
      "bottom",
    );
    const nested = splitWorkspacePane(base, {
      activeTerminalId: "top",
      newTerminalId: "bottom",
      direction: "down",
    });

    const next = swapWorkspacePanes(nested, "left", "bottom");

    expect(next.activeTerminalId).toBe("left");
    expect(getActiveWorkspaceGroup(next)?.root).toMatchObject({
      type: "split",
      first: { type: "leaf", terminalId: "bottom" },
      second: {
        type: "split",
        direction: "vertical",
        first: { type: "leaf", terminalId: "top" },
        second: { type: "leaf", terminalId: "left" },
      },
    });
    expect(collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null))
      .toEqual(["bottom", "top", "left"]);
  });

  it("rotates a two-pane stacked layout to side-by-side", () => {
    const workspace = splitWorkspacePane(
      createTerminalWorkspace(
        [terminal("a", "/repo"), terminal("b", "/repo")],
        "a",
      ),
      {
        activeTerminalId: "a",
        newTerminalId: "b",
        direction: "down",
      },
    );

    const next = rotateWorkspaceLayout(workspace);

    expect(getActiveWorkspaceGroup(next)?.root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", terminalId: "a" },
      second: { type: "leaf", terminalId: "b" },
    });
    expect(next.activeTerminalId).toBe("b");
  });

  it("flips every split direction in a nested tree, preserving order and ratios", () => {
    const workspace = createTerminalWorkspace(
      [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/repo")],
      "c",
      [],
      [
        {
          machine_id: "m1",
          group_key: "cwd:/repo",
          updated_at: 10,
          root: {
            type: "split",
            direction: "vertical",
            ratio: 0.3,
            first: {
              type: "split",
              direction: "horizontal",
              ratio: 0.7,
              first: { type: "leaf", terminalId: "a" },
              second: { type: "leaf", terminalId: "c" },
            },
            second: { type: "leaf", terminalId: "b" },
          },
        },
      ],
    );

    const next = rotateWorkspaceLayout(workspace);

    expect(getActiveWorkspaceGroup(next)?.root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.3,
      first: {
        type: "split",
        direction: "vertical",
        ratio: 0.7,
        first: { type: "leaf", terminalId: "a" },
        second: { type: "leaf", terminalId: "c" },
      },
      second: { type: "leaf", terminalId: "b" },
    });
    expect(collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null))
      .toEqual(["a", "c", "b"]);
    expect(next.activeTerminalId).toBe("c");
  });

  it("is a no-op for a group with a single pane", () => {
    const workspace = createTerminalWorkspace([terminal("a", "/repo")], "a");

    expect(rotateWorkspaceLayout(workspace)).toBe(workspace);
  });

  it("leaves inactive groups untouched when rotating the active group", () => {
    const workspace = splitWorkspacePane(
      createTerminalWorkspace(
        [terminal("a", "/repo"), terminal("b", "/repo"), terminal("c", "/else")],
        "a",
      ),
      {
        activeTerminalId: "a",
        newTerminalId: "b",
        direction: "down",
      },
    );

    const next = rotateWorkspaceLayout(workspace);

    const inactiveBefore = workspace.groups.find(
      (group) => group.id !== workspace.activeGroupId,
    );
    const inactiveAfter = next.groups.find(
      (group) => group.id === inactiveBefore?.id,
    );
    expect(inactiveAfter).toBe(inactiveBefore);
    expect(next.activeGroupId).toBe(workspace.activeGroupId);
    expect(next.activeTerminalId).toBe(workspace.activeTerminalId);
  });

  it("collapses a split when a pane is closed", () => {
    const workspace = splitWorkspacePane(
      createTerminalWorkspace([terminal("a", "/repo")], "a"),
      {
        activeTerminalId: "a",
        newTerminalId: "b",
        direction: "down",
      },
    );

    const next = closeWorkspacePane(workspace, "b");

    expect(getActiveWorkspaceGroup(next)?.root).toEqual({
      type: "leaf",
      terminalId: "a",
    });
    expect(next.activeTerminalId).toBe("a");
  });

  it("activates the adjacent pane when closing an active pane in a nested split", () => {
    const base = createTerminalWorkspace(
      [
        terminal("a", "/repo"),
        terminal("b", "/repo"),
        terminal("c", "/repo"),
      ],
      "b",
    );
    const nested = splitWorkspacePane(base, {
      activeTerminalId: "b",
      newTerminalId: "c",
      direction: "down",
    });

    const next = closeWorkspacePane(nested, "c");

    expect(next.activeTerminalId).toBe("b");
    expect(collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null))
      .toEqual(["a", "b"]);
  });

  it("activates the adjacent pane when refresh removes the active pane", () => {
    const base = createTerminalWorkspace(
      [
        terminal("a", "/repo"),
        terminal("b", "/repo"),
        terminal("c", "/repo"),
      ],
      "b",
    );
    const nested = splitWorkspacePane(base, {
      activeTerminalId: "b",
      newTerminalId: "c",
      direction: "down",
    });

    const next = reconcileTerminalWorkspace(
      nested,
      [terminal("a", "/repo"), terminal("b", "/repo")],
      "c",
    );

    expect(next.activeTerminalId).toBe("b");
    expect(collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null))
      .toEqual(["a", "b"]);
  });

  it("uses group tabs on mobile instead of exposing the split tree", () => {
    const workspace = createTerminalWorkspace(terminals, "web-2");

    expect(getMobileWorkspaceTabs(workspace)).toEqual([
      {
        id: "web-1",
        label: "Terminal web-1",
        cwd: "/home/chareice/projects/offdesk",
        active: false,
      },
      {
        id: "web-2",
        label: "Terminal web-2",
        cwd: "/home/chareice/projects/offdesk",
        active: true,
      },
    ]);
  });

  it("keeps a user's split layout when terminal data refreshes", () => {
    const workspace = splitWorkspacePane(
      createTerminalWorkspace([terminal("web-1", "/repo")], "web-1"),
      {
        activeTerminalId: "web-1",
        newTerminalId: "web-2",
        direction: "right",
      },
    );

    const next = reconcileTerminalWorkspace(
      workspace,
      [
        terminal("web-1", "/repo"),
        terminal("web-2", "/repo"),
        terminal("web-3", "/repo"),
      ],
      "web-2",
    );

    expect(getActiveWorkspaceGroup(next)?.root).toMatchObject({
      type: "split",
      first: {
        type: "split",
        first: { type: "leaf", terminalId: "web-1" },
        second: { type: "leaf", terminalId: "web-2" },
      },
      second: { type: "leaf", terminalId: "web-3" },
    });
    expect(
      collectPaneTerminalIds(getActiveWorkspaceGroup(next)?.root ?? null),
    ).toEqual(["web-1", "web-2", "web-3"]);
  });

  it("selects a group by activating its first pane", () => {
    const workspace = createTerminalWorkspace(terminals, "web-1");
    const next = selectWorkspaceGroup(
      workspace,
      "cwd:/home/chareice/projects/zhuyang",
    );

    expect(next.activeGroupId).toBe("cwd:/home/chareice/projects/zhuyang");
    expect(next.activeTerminalId).toBe("api-1");
  });

  it("keeps the active and previously active groups mounted, active first", () => {
    const workspace = workspaceWithGroups(["a", "b", "c"], "b");

    expect(mountedWorkspaceGroupIds(workspace, "a", false)).toEqual(["b", "a"]);
  });

  it("dedupes when the previous active group is still active", () => {
    const workspace = workspaceWithGroups(["a", "b"], "a");

    expect(mountedWorkspaceGroupIds(workspace, "a", false)).toEqual(["a"]);
  });

  it("drops mounted groups that no longer exist (deleted group)", () => {
    const workspace = workspaceWithGroups(["b", "c"], "c");

    expect(mountedWorkspaceGroupIds(workspace, "a", false)).toEqual(["c"]);
  });

  it("mounts nothing when the active group id is not in the workspace", () => {
    const workspace: TerminalWorkspace = {
      groups: [],
      activeGroupId: "gone",
      activeTerminalId: null,
    };

    expect(mountedWorkspaceGroupIds(workspace, null, false)).toEqual([]);
  });

  it("keeps only the active group mounted on touch devices", () => {
    const workspace = workspaceWithGroups(["a", "b", "c"], "b");

    expect(mountedWorkspaceGroupIds(workspace, "a", true)).toEqual(["b"]);
  });

  it("finds adjacent panes by visual direction", () => {
    const workspace = splitWorkspacePane(
      createTerminalWorkspace([terminal("left", "/repo")], "left"),
      {
        activeTerminalId: "left",
        newTerminalId: "right",
        direction: "right",
      },
    );
    const root = getActiveWorkspaceGroup(workspace)?.root ?? null;

    expect(findAdjacentWorkspacePane(root, "right", "left")).toBe("right");
    expect(findAdjacentWorkspacePane(root, "left", "right")).toBe("left");
    expect(findAdjacentWorkspacePane(root, "up", "left")).toBeNull();
  });

  it("finds the closest pane in nested split layouts", () => {
    const base = createTerminalWorkspace(
      [terminal("left", "/repo"), terminal("top", "/repo")],
      "top",
    );
    const nested = splitWorkspacePane(base, {
      activeTerminalId: "top",
      newTerminalId: "bottom",
      direction: "down",
    });
    const root = getActiveWorkspaceGroup(nested)?.root ?? null;

    expect(findAdjacentWorkspacePane(root, "down", "top")).toBe("bottom");
    expect(findAdjacentWorkspacePane(root, "up", "bottom")).toBe("top");
    expect(findAdjacentWorkspacePane(root, "left", "bottom")).toBe("left");
  });
});

describe("strip order helpers", () => {
  it("workspacePaneOrder returns the only leaf", () => {
    expect(
      workspacePaneOrder({ type: "leaf", terminalId: "only" }),
    ).toEqual(["only"]);
  });

  it("workspacePaneOrder follows first-then-second DFS through nested splits", () => {
    const root: WorkspacePaneNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.4,
      first: {
        type: "split",
        direction: "horizontal",
        ratio: 0.3,
        first: { type: "leaf", terminalId: "top-left" },
        second: { type: "leaf", terminalId: "top-right" },
      },
      second: { type: "leaf", terminalId: "bottom" },
    };

    expect(workspacePaneOrder(root)).toEqual([
      "top-left",
      "top-right",
      "bottom",
    ]);
  });

  it("collectGroupPaneTerminalIds flattens groups in strip order", () => {
    const ws = createTerminalWorkspace(
      [
        terminal("web-1", "/home/web"),
        terminal("web-2", "/home/web"),
        terminal("api-1", "/home/api"),
      ],
      "web-1",
    );
    // cwd fallback groups sort by label: api before web.
    expect(collectGroupPaneTerminalIds(ws.groups)).toEqual([
      "api-1",
      "web-1",
      "web-2",
    ]);
  });
});

describe("buildReorderPersistentGroupIds", () => {
  function workspaceGroupInfo(
    id: string,
    name: string,
    sortOrder: number,
  ): WorkspaceGroupInfo {
    return { id, machine_id: "m1", name, sort_order: sortOrder };
  }

  // Visible order: persistent groups (by sort_order), then cwd fallback
  // groups (by label) — g1, g2, cwd:/work/a, cwd:/work/b.
  function mixedWorkspace() {
    return createTerminalWorkspace(
      [
        groupedTerminal("t1", "/work/one", "g1"),
        groupedTerminal("t2", "/work/two", "g2"),
        terminal("t3", "/work/a"),
        terminal("t4", "/work/b"),
      ],
      "t1",
      [workspaceGroupInfo("g1", "one", 0), workspaceGroupInfo("g2", "two", 1)],
    );
  }

  it("keeps pure-persistent reorder behavior unchanged", () => {
    const ws = mixedWorkspace();

    expect(
      buildReorderPersistentGroupIds(ws.groups, "g1", "g2", "after"),
    ).toEqual(["g2", "g1"]);
    expect(
      buildReorderPersistentGroupIds(ws.groups, "g2", "g1", "before"),
    ).toEqual(["g2", "g1"]);
  });

  it("substitutes the promoted id for a fallback drag source", () => {
    const ws = mixedWorkspace();

    expect(
      buildReorderPersistentGroupIds(
        ws.groups,
        "cwd:/work/a",
        "g1",
        "before",
        { "cwd:/work/a": "ga" },
      ),
    ).toEqual(["ga", "g1", "g2"]);
  });

  it("substitutes the promoted id for a fallback drop target", () => {
    const ws = mixedWorkspace();

    expect(
      buildReorderPersistentGroupIds(
        ws.groups,
        "g1",
        "cwd:/work/b",
        "after",
        { "cwd:/work/b": "gb" },
      ),
    ).toEqual(["g2", "gb", "g1"]);
  });

  it("reorders two promoted fallback tabs in dragged order", () => {
    const ws = createTerminalWorkspace(
      [terminal("t3", "/work/a"), terminal("t4", "/work/b")],
      "t3",
    );
    const promoted = { "cwd:/work/a": "ga", "cwd:/work/b": "gb" };

    expect(
      buildReorderPersistentGroupIds(
        ws.groups,
        "cwd:/work/a",
        "cwd:/work/b",
        "before",
        promoted,
      ),
    ).toEqual(["ga", "gb"]);
    expect(
      buildReorderPersistentGroupIds(
        ws.groups,
        "cwd:/work/b",
        "cwd:/work/a",
        "before",
        promoted,
      ),
    ).toEqual(["gb", "ga"]);
  });

  it("returns null when a fallback drag end was not promoted", () => {
    const ws = mixedWorkspace();

    expect(
      buildReorderPersistentGroupIds(ws.groups, "g1", "cwd:/work/a", "after"),
    ).toBeNull();
  });
});

describe("pane cap", () => {
  function groupInfo(id: string, name: string): WorkspaceGroupInfo {
    return { id, machine_id: "m1", name, sort_order: 0 };
  }

  function tabWith(paneCount: number, workspaceGroupId: string | null) {
    const terminals = Array.from({ length: paneCount }, (_, i) =>
      workspaceGroupId
        ? groupedTerminal(`t${i}`, "/work/a", workspaceGroupId)
        : terminal(`t${i}`, "/work/a"),
    );
    return createTerminalWorkspace(
      terminals,
      "t0",
      workspaceGroupId ? [groupInfo(workspaceGroupId, "tab 1")] : [],
    ).groups;
  }

  it("counts a tab as full only at the cap", () => {
    expect(isWorkspaceGroupFull(tabWith(MAX_PANES_PER_TAB - 1, "g1")[0])).toBe(
      false,
    );
    expect(isWorkspaceGroupFull(tabWith(MAX_PANES_PER_TAB, "g1")[0])).toBe(true);
    expect(isWorkspaceGroupFull(null)).toBe(false);
  });

  it("creates into the target tab while it has room", () => {
    const groups = tabWith(MAX_PANES_PER_TAB - 1, "g1");

    expect(
      planNewTerminalPlacement(groups, { tabId: "g1", cwd: "/work/a" }),
    ).toEqual({ needsNewTab: false, workspaceGroupId: "g1" });
  });

  it("overflows a full tab into a new tab", () => {
    const groups = tabWith(MAX_PANES_PER_TAB, "g1");

    expect(
      planNewTerminalPlacement(groups, { tabId: "g1", cwd: "/work/a" }),
    ).toEqual({ needsNewTab: true, workspaceGroupId: null });
  });

  it("leaves an aimless creation to the hub, which opens a tab for it", () => {
    expect(
      planNewTerminalPlacement(tabWith(MAX_PANES_PER_TAB - 1, "g1"), {
        tabId: null,
        cwd: "/work/a",
      }),
    ).toEqual({ needsNewTab: false, workspaceGroupId: null });

    // Never joins an existing tab by cwd, so a full one cannot overflow it.
    expect(
      planNewTerminalPlacement(tabWith(MAX_PANES_PER_TAB, "g1"), {
        tabId: null,
        cwd: "/work/a",
      }),
    ).toEqual({ needsNewTab: false, workspaceGroupId: null });
  });
});

describe("flattenWorkspacePanes", () => {
  const tree: WorkspacePaneNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", terminalId: "a" },
    second: {
      type: "split",
      direction: "vertical",
      ratio: 0.25,
      first: { type: "leaf", terminalId: "b" },
      second: { type: "leaf", terminalId: "c" },
    },
  };

  it("returns fractional rects matching the split structure", () => {
    expect(flattenWorkspacePanes(tree)).toEqual([
      { terminalId: "a", left: 0, top: 0, width: 0.5, height: 1 },
      { terminalId: "b", left: 0.5, top: 0, width: 0.5, height: 0.25 },
      { terminalId: "c", left: 0.5, top: 0.25, width: 0.5, height: 0.75 },
    ]);
  });

  it("stacks every split vertically for touch rendering", () => {
    expect(flattenWorkspacePanes(tree, { stackVertically: true })).toEqual([
      { terminalId: "a", left: 0, top: 0, width: 1, height: 0.5 },
      { terminalId: "b", left: 0, top: 0.5, width: 1, height: 0.125 },
      { terminalId: "c", left: 0, top: 0.625, width: 1, height: 0.375 },
    ]);
  });

  it("handles a lone leaf and a null root", () => {
    expect(flattenWorkspacePanes({ type: "leaf", terminalId: "x" })).toEqual([
      { terminalId: "x", left: 0, top: 0, width: 1, height: 1 },
    ]);
    expect(flattenWorkspacePanes(null)).toEqual([]);
  });
});

describe("labelFromCwd", () => {
  it("names a tab after the last path segment", () => {
    expect(labelFromCwd("/Users/ryan/workspaces/offdesk")).toBe("offdesk");
    expect(labelFromCwd("/srv/app/")).toBe("app");
  });

  it("calls a home directory ~, on macOS, Linux and for root", () => {
    expect(labelFromCwd("/Users/zourenyuan")).toBe("~");
    expect(labelFromCwd("/home/ryan/")).toBe("~");
    expect(labelFromCwd("/root")).toBe("~");
  });

  it("does not mistake a directory under home for home", () => {
    expect(labelFromCwd("/Users/zourenyuan/eng")).toBe("eng");
    expect(labelFromCwd("/home")).toBe("home");
  });
});
