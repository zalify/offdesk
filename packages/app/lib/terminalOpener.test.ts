import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";

import { terminalOpenerDescription, terminalOpenerText } from "./terminalOpener";

function terminal(opened_by?: TerminalInfo["opened_by"]): TerminalInfo {
  return {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    machine_id: "machine-1",
    title: "shell",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    reachable: true,
    opened_by,
  };
}

describe("terminalOpener", () => {
  it("marks nothing for terminals a person opened", () => {
    expect(terminalOpenerText(terminal())).toBeNull();
    expect(terminalOpenerText(terminal(null))).toBeNull();
    expect(terminalOpenerDescription(terminal())).toBeNull();
  });

  it("marks terminals the CLI opened, with its label", () => {
    const opened = terminal({ kind: "cli", label: "claude" });
    expect(terminalOpenerText(opened)).toBe("agent · claude");
    expect(terminalOpenerDescription(opened)).toBe(
      "Opened by an agent via the offdesk CLI (claude)",
    );
  });

  it("still marks a terminal without a label, or of a newer kind", () => {
    expect(terminalOpenerText(terminal({ kind: "cli" }))).toBe("agent");
    expect(terminalOpenerDescription(terminal({ kind: "other", label: " " }))).toBe(
      "Opened by an agent",
    );
  });
});
