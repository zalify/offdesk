import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";

import { activityAge, sessionRows } from "./sessionList";
import type { WorkspaceGroup } from "./terminalWorkspaceLayout";

function terminal(id: string, lastActivityMs?: number): TerminalInfo {
  return {
    id,
    machine_id: "machine-1",
    title: id,
    cwd: `/repo/${id}`,
    cols: 80,
    rows: 24,
    reachable: true,
    last_activity_ms: lastActivityMs,
  };
}

function group(id: string, terminalIds: string[]): WorkspaceGroup {
  const [first, ...rest] = terminalIds;
  let root: WorkspaceGroup["root"] = first ? { type: "leaf", terminalId: first } : null;
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
    label: id,
    cwd: `/groups/${id}`,
    workspaceGroupId: id,
    persistent: true,
    root,
    paneCount: terminalIds.length,
    layoutUpdatedAt: null,
  };
}

const byId = (...terminals: TerminalInfo[]) => new Map(terminals.map((t) => [t.id, t]));

describe("sessionRows", () => {
  const groups = [group("app", ["one", "two"]), group("api", ["three"]), group("empty", [])];
  const terminals = byId(
    terminal("one", 1_000),
    terminal("two"),
    terminal("three", 5_000),
  );

  it("keeps the tabs' order, panes within each tab, with each row's tab", () => {
    expect(
      sessionRows(groups, terminals, "tabs").map((row) => [row.terminal.id, row.group.id]),
    ).toEqual([
      ["one", "app"],
      ["two", "app"],
      ["three", "api"],
    ]);
  });

  it("puts the latest output first and terminals without activity last, in tab order", () => {
    const rows = sessionRows(
      [...groups, group("db", ["four"])],
      new Map([...terminals, ["four", terminal("four")]]),
      "recent",
    );
    expect(rows.map((row) => row.terminal.id)).toEqual(["three", "one", "two", "four"]);
  });

  it("skips panes whose terminal is gone", () => {
    expect(sessionRows([group("app", ["one", "gone"])], terminals, "recent")).toHaveLength(1);
  });
});

describe("activityAge", () => {
  const now = 10 * 24 * 3_600_000;

  it("says how long ago, coarsely", () => {
    expect(activityAge(now - 20_000, now)).toBe("now");
    expect(activityAge(now - 5 * 60_000, now)).toBe("5m");
    expect(activityAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(activityAge(now - 2 * 24 * 3_600_000, now)).toBe("2d");
  });

  it("says nothing without a time", () => {
    expect(activityAge(null, now)).toBeNull();
    expect(activityAge(undefined, now)).toBeNull();
  });
});
