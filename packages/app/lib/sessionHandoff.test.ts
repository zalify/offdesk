import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";
import { agentFromProcess, suggestedHandoffTarget, formatHandoff, handoffTargets, newHandoffId, type HandoffContent } from "./sessionHandoff";

describe("manual session handoff", () => {
  it("only offers reachable, distinct terminals on the same machine and directory", () => {
    const source = { id: "a", machine_id: "m", cwd: "/repo", reachable: true } as TerminalInfo;
    const terminals = [source, { ...source, id: "b" }, { ...source, id: "offline", reachable: false },
      { ...source, id: "other", machine_id: "other" }, { ...source, id: "different", cwd: "/other" }];
    expect(handoffTargets(source, terminals).map(t => t.id)).toEqual(["b"]);
  });
  it("preserves literal user instructions and artifact paths without building commands", () => {
    const content: HandoffContent = { source_terminal_id: "a", target_terminal_id: "b", source_agent: "claude", target_agent: "codex",
      cwd: "/repo with spaces", goal: "Keep `$(example)` literal", intent: "Wire the API", summary: "Tests not yet run", artifacts: "assets/hero image.png" };
    const text = formatHandoff(content);
    expect(text).toContain(content.goal);
    expect(text).toContain(content.summary);
    expect(text).toContain(content.artifacts);
    expect(text).toContain("uncommitted changes");
    expect(text).not.toContain("codex resume");
  });
  it("creates UUID request IDs even without crypto.randomUUID", () => {
    expect(newHandoffId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newHandoffId()).not.toBe(newHandoffId());
  });
});

describe("automatic handoff matching", () => {
  it("identifies actual agent commands, not titles or generic node processes", () => {
    expect(agentFromProcess("/usr/local/bin/claude")).toBe("claude");
    expect(agentFromProcess("codex")).toBe("codex");
    expect(agentFromProcess("claude.exe")).toBe("claude");
    for (const command of ["node", "zsh", "my-codex-helper", null])
      expect(agentFromProcess(command)).toBeNull();
  });
  it("uses the previous live agent binding, then a unique match, never an ambiguous guess", () => {
    const terminals = [{ id: "a" }, { id: "b" }] as TerminalInfo[];
    const agents = { a: "codex", b: "codex" } as const;
    expect(suggestedHandoffTarget(terminals, agents, "codex", "b")).toBe("b");
    expect(suggestedHandoffTarget(terminals, agents, "codex", "")).toBe("");
    expect(suggestedHandoffTarget(terminals, { a: "claude", b: "codex" }, "codex", "a")).toBe("b");
    expect(suggestedHandoffTarget(terminals, { a: null, b: null }, "codex", "a")).toBe("");
  });
});
