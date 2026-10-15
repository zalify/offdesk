import { describe, expect, it } from "vitest";
import type { AgentRunInfo } from "@offdesk/shared";
import { answerChoices, waitingRunsByTerminal } from "./agentRunRequests";

const run = (id: string, fields: Partial<AgentRunInfo> = {}): AgentRunInfo => ({
  id, machine_id: "m1", terminal_id: "t1", agent: "claude", cwd: "/w", status: "waiting",
  started_at_ms: 1, updated_at_ms: 1, ...fields,
});
const request = (kind: "approval" | "question" | "input", fields = {}) =>
  ({ id: "q", kind, source: "hooks", created_at_ms: 1, ...fields });

describe("waiting agent runs", () => {
  it("are the newest open run with a request, per terminal", () => {
    const runs = [
      run("old", { started_at_ms: 1, request: request("approval") }),
      run("new", { started_at_ms: 2, request: request("question") }),
      run("ended", { terminal_id: "t2", ended_at_ms: 3, request: request("approval") }),
      run("working", { terminal_id: "t3", status: "working" }),
    ];
    const waiting = waitingRunsByTerminal(runs);
    expect([...waiting.entries()].map(([t, r]) => [t, r.id])).toEqual([["t1", "new"]]);
  });

  it("offer yes/no, the first options, or nothing for input or once an answer is sent", () => {
    expect(answerChoices(run("a", { request: request("approval") })).map(c => [c.label, c.answer])).toEqual([
      ["yes", { approve: true }],
      ["no", { approve: false }],
    ]);
    const options = [1, 2, 3, 4].map(n => ({ id: String(n), label: `option ${n}` }));
    expect(answerChoices(run("q", { request: request("question", { options }) })).map(c => c.answer.option_id)).toEqual(["1", "2", "3"]);
    expect(answerChoices(run("i", { request: request("input") }))).toEqual([]);
    expect(answerChoices(run("s", { request: request("approval", { answer_sent_at_ms: 5 }) }))).toEqual([]);
  });
});
