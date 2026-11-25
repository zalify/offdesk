import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";

import { displayTerminalTitle, shortenCwd } from "./displayTerminalTitle";

function terminal(title?: string, cwd = "/tmp"): TerminalInfo {
  return {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    machine_id: "machine-1",
    title: title as string,
    cwd,
    cols: 80,
    rows: 24,
    reachable: true,
  };
}

describe("displayTerminalTitle", () => {
  it("returns a meaningful terminal title", () => {
    expect(displayTerminalTitle(terminal("my-task"))).toBe("my-task");
  });

  it("falls back to shell for an empty or missing title", () => {
    expect(displayTerminalTitle(terminal(""))).toBe("shell");
    expect(displayTerminalTitle(terminal("   "))).toBe("shell");
    expect(displayTerminalTitle(terminal())).toBe("shell");
  });

  it("hides legacy generated terminal ids", () => {
    expect(displayTerminalTitle(terminal("Terminal deadbeef"))).toBe("shell");
  });

  it("strips noisy CLI flags and keeps the directory basename", () => {
    expect(
      displayTerminalTitle(
        terminal("agy --dangerously-sk ~/p/webmux", "/home/chareice/projects/webmux"),
      ),
    ).toBe("agy · webmux");
    expect(
      displayTerminalTitle(
        terminal("agy --dangerously-skip-permissions", "/home/chareice/projects/reach"),
      ),
    ).toBe("agy · reach");
    expect(
      displayTerminalTitle(
        terminal("claude --dangerously-skip-permissions --resume", "/Users/alice/app"),
      ),
    ).toBe("claude · app");
  });

  it("preserves explicit agent conversation titles", () => {
    expect(displayTerminalTitle(terminal("✳ 嘉顺客户回复", "/home/chareice/projects/reach"))).toBe(
      "✳ 嘉顺客户回复",
    );
    expect(displayTerminalTitle(terminal("agy refactoring sidebar", "/tmp"))).toBe(
      "agy refactoring sidebar",
    );
  });
});

describe("shortenCwd", () => {
  it("replaces /home/<user> and /Users/<user> with ~", () => {
    expect(shortenCwd("/home/chareice/projects/webmux")).toBe("~/projects/webmux");
    expect(shortenCwd("/Users/alice/dev/app")).toBe("~/dev/app");
    expect(shortenCwd("/home/chareice")).toBe("~");
    expect(shortenCwd("/var/log")).toBe("/var/log");
  });
});
