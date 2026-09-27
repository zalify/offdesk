import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@offdesk/shared";
import { formatHandoff, handoffTargets, newHandoffId, type HandoffContent } from "./sessionHandoff";

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
