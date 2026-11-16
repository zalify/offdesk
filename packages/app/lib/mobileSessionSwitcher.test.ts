import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";

import {
  buildMobileSessionGroups,
  recentMobileSessionPanes,
} from "./mobileSessionSwitcher";
import type { WorkspaceGroup } from "./terminalWorkspaceLayout";

function terminal(id: string, title: string, cwd: string): TerminalInfo {
  return {
    id,
    machine_id: "machine-1",
    title,
    cwd,
    cols: 80,
    rows: 24,
    reachable: true,
  };
}

function group(
  id: string,
  label: string,
  terminalIds: string[],
): WorkspaceGroup {
  const [first, ...rest] = terminalIds;
  let root: WorkspaceGroup["root"] = first
    ? { type: "leaf", terminalId: first }
    : null;
  for (const terminalId of rest) {
    root = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: root!,
      second: { type: "leaf", terminalId },
    };
  }
  return {
    id,
    label,
    cwd: `/groups/${id}`,
    workspaceGroupId: id,
    persistent: true,
    root,
    paneCount: terminalIds.length,
    layoutUpdatedAt: null,
  };
}

describe("buildMobileSessionGroups", () => {
  it("groups panes in workspace order", () => {
    const result = buildMobileSessionGroups(
      [group("alpha", "Alpha", ["one", "two"]), group("beta", "Beta", ["three"])],
      [
        terminal("two", "Terminal Two", "/repo/two"),
        terminal("three", "Terminal Three", "/repo/three"),
        terminal("one", "Terminal One", "/repo/one"),
      ],
    );

    expect(result.map((entry) => entry.panes.length)).toEqual([2, 1]);
    expect(
      result.flatMap((entry) => entry.panes.map((pane) => pane.terminal.id)),
    ).toEqual(["one", "two", "three"]);
  });

  it("skips stale layout leaves", () => {
    const result = buildMobileSessionGroups(
      [group("alpha", "Alpha", ["missing", "one", "two"])],
      [
        terminal("one", "Terminal One", "/repo/one"),
        terminal("two", "Terminal Two", "/repo/two"),
      ],
    );

    expect(result[0]?.panes.map((pane) => pane.terminal.id)).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("recentMobileSessionPanes", () => {
  it("puts the latest output first and unreported terminals last, in tab order", () => {
    const at = (t: TerminalInfo, ms: number | null): TerminalInfo => ({ ...t, last_activity_ms: ms });
    const groups = buildMobileSessionGroups(
      [group("alpha", "Alpha", ["one", "two"]), group("beta", "Beta", ["three", "four"])],
      [
        at(terminal("one", "One", "/one"), 1_000),
        at(terminal("two", "Two", "/two"), null),
        at(terminal("three", "Three", "/three"), 5_000),
        terminal("four", "Four", "/four"),
      ],
    );

    const panes = recentMobileSessionPanes(groups);
    expect(panes.map((pane) => pane.terminal.id)).toEqual(["three", "one", "two", "four"]);
    expect(panes.map((pane) => pane.group.label)).toEqual(["Beta", "Alpha", "Alpha", "Beta"]);
  });
});
