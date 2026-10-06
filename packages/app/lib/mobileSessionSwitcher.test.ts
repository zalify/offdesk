import { describe, expect, it } from "vitest";
import type { AgentBrowserInfo, TerminalInfo } from "@offdesk/shared";

import { buildMobileSessionGroups } from "./mobileSessionSwitcher";
import {
  createTerminalWorkspace,
  type WorkspaceGroup,
} from "./terminalWorkspaceLayout";

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
      result.flatMap((entry) => entry.panes.map((pane) => pane.id)),
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

    expect(result[0]?.panes.map((pane) => pane.id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("places agent browsers in their opener's tab or a tab of their own", () => {
    const terminals = [
      terminal("one", "Terminal One", "/repo/one"),
      terminal("two", "Terminal Two", "/repo/two"),
    ];
    const browsers: AgentBrowserInfo[] = [
      {
        id: "b-opened",
        machine_id: "machine-1",
        url: "https://example.com/",
        title: "Example",
        opener_terminal_id: "one",
      },
      {
        id: "b-solo",
        machine_id: "machine-1",
        url: "https://solo.test/page",
        title: "",
      },
    ];
    // The same derivation the desktop tab bar uses.
    const groups = createTerminalWorkspace(
      terminals,
      null,
      [],
      [],
      browsers,
    ).groups;
    const result = buildMobileSessionGroups(groups, terminals, browsers);

    const byPane = (id: string) =>
      result.find((entry) => entry.panes.some((pane) => pane.id === id));
    const opened = byPane("b-opened");
    expect(opened?.panes.map((pane) => pane.id)).toContain("one");
    expect(opened?.panes.map((pane) => pane.kind)).toContain("browser");
    const solo = byPane("b-solo");
    expect(solo?.panes.map((pane) => pane.id)).toEqual(["b-solo"]);
    expect(solo?.group.id).toBe("browser:b-solo");
    // Terminals keep their own entries.
    expect(byPane("two")?.panes.some((pane) => pane.kind === "terminal")).toBe(true);
  });

  it("drops a browser that is no longer listed", () => {
    const result = buildMobileSessionGroups(
      [group("alpha", "Alpha", ["one", "gone"])],
      [terminal("one", "Terminal One", "/repo/one")],
      [],
    );
    expect(result[0]?.panes.map((pane) => pane.id)).toEqual(["one"]);
  });
});
