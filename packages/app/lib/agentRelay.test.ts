import { describe, expect, it } from "vitest";
import type { RelayBrief } from "@offdesk/shared";
import {
  composeRelayBrief,
  finalRelayPrompt,
  newRelayId,
  otherAgent,
  relayPromptProblem,
} from "./agentRelay";

const brief: RelayBrief = {
  agent: "claude",
  cwd: "/work/repo",
  title: "Fix order enrichment",
  goal: "Restore order enrichment and backfill",
  latest: "Backfill is at 31,240 of 76,000.",
  tasks: [
    { subject: "Find the cause", status: "completed" },
    { subject: "Backfill orders", status: "in_progress" },
    { subject: "Add a stall alert", status: "pending" },
  ],
  git: { branch: "fix/enrichment", changed: ["jobs/enrich.ts", "lib/orders.ts"], more: 3 },
  usage_limit: "Usage limit reached · resets 3pm",
  warnings: [],
};

describe("agent relay prompts", () => {
  it("turn a brief into a self-contained handoff", () => {
    const text = composeRelayBrief(brief);
    expect(text.startsWith("Continue a task that Claude was working on")).toBe(true);
    expect(text).toContain("Claude stopped: Usage limit reached · resets 3pm.");
    expect(text).toContain("Original request:\nRestore order enrichment and backfill");
    expect(text).toContain("- [x] Find the cause\n- [ ] Backfill orders (in progress)\n- [ ] Add a stall alert");
    expect(text).toContain("Claude's latest update:\nBackfill is at 31,240 of 76,000.");
    expect(text).toContain("Uncommitted changes on fix/enrichment: jobs/enrich.ts, lib/orders.ts, +3 more");
    expect(text).toContain("Start by checking the current state of the files");
  });

  it("stay honest when the session could not be read", () => {
    const text = composeRelayBrief({ agent: "codex", cwd: "/w", tasks: [], warnings: ["x"] });
    expect(text).toContain("Codex handed it over.");
    expect(text).not.toContain("Original request");
    expect(text).not.toContain("Uncommitted changes");
  });

  it("append the person's note and never start with an option dash", () => {
    expect(finalRelayPrompt(" body \n", "  don't touch pixels ")).toBe("body\n\nNote from me: don't touch pixels");
    expect(finalRelayPrompt("body", "  ")).toBe("body");
    expect(finalRelayPrompt("--yolo do it", "")).toBe("yolo do it");
    expect(relayPromptProblem("  ")).toBe("The prompt is empty.");
    expect(relayPromptProblem("x".repeat(32 * 1024 + 1))).toMatch(/too long/);
    expect(relayPromptProblem("ok")).toBeNull();
  });

  it("name the other agent and make retry-safe ids without randomUUID", () => {
    expect(otherAgent("claude")).toBe("codex");
    expect(otherAgent("codex")).toBe("claude");
    const id = newRelayId({ getRandomValues: (b) => b.fill(0xab) });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
