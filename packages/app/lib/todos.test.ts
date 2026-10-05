import { describe, expect, it } from "vitest";
import type { TerminalInfo, TodoInfo } from "@offdesk/shared";
import {
  agentLooksFinished,
  cleanTitle,
  composeTodoPrompt,
  doneTodos,
  draftTodo,
  folderLabel,
  openTodos,
  todoAgentState,
  unlinkedAgentTerminals,
} from "./todos";
import { newUuid } from "./uuid";

const todo = (id: string, extra: Partial<TodoInfo> = {}): TodoInfo => ({
  id,
  title: id,
  notes: "",
  status: "open",
  position: 0,
  created_at: 1,
  updated_at: 1,
  ...extra,
});

describe("to-do lists", () => {
  it("order open items by position and finished items by completion", () => {
    const todos = [
      todo("b", { position: 2 }),
      todo("a", { position: -1 }),
      todo("x", { status: "done", completed_at: 5 }),
      todo("y", { status: "done", completed_at: 9 }),
    ];
    expect(openTodos(todos).map((t) => t.id)).toEqual(["a", "b"]);
    expect(doneTodos(todos).map((t) => t.id)).toEqual(["y", "x"]);
  });

  it("put a new draft above everything", () => {
    const draft = draftTodo("n", "New", [todo("a", { position: -3 }), todo("b", { position: 4 })], 100);
    expect(draft.position).toBe(-4);
    expect(draft).toMatchObject({ status: "open", created_at: 100, updated_at: 100 });
    expect(draftTodo("n", "New", []).position).toBe(-1);
  });

  it("label folders and clean titles", () => {
    expect(folderLabel("/Users/r/workspaces/Zalify/Eng", "/Users/r")).toBe("Eng");
    expect(folderLabel("/Users/r", "/Users/r")).toBe("~");
    expect(folderLabel("/")).toBe("/");
    expect(cleanTitle("  Renew \n the   certificate ")).toBe("Renew the certificate");
    expect(newUuid({ getRandomValues: (b) => b.fill(1) })).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("to-dos handed to agents", () => {
  const linked = (extra: Partial<TodoInfo> = {}): TodoInfo => ({
    id: "t",
    title: "Backfill orders",
    notes: "",
    status: "open",
    position: 0,
    created_at: 1,
    updated_at: 1,
    agent: "claude",
    terminal_id: "term",
    progress: { done: 2, total: 2, items: [], updated_at: 1 },
    ...extra,
  });
  const terminal = (agent?: TerminalInfo["agent"]): TerminalInfo => ({
    id: "term",
    machine_id: "m",
    title: "claude",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    reachable: true,
    agent,
  });

  it("report what the agent is doing and when it looks finished", () => {
    expect(todoAgentState(linked({ agent: undefined }), [])).toEqual({ kind: "none" });
    const busy = todoAgentState(linked(), [terminal({ kind: "claude", activity: "busy" })]);
    expect(busy.kind).toBe("working");
    expect(agentLooksFinished(linked(), busy)).toBe(false);
    const idle = todoAgentState(linked(), [terminal({ kind: "claude", activity: "idle" })]);
    expect(agentLooksFinished(linked(), idle)).toBe(true);
    // The terminal closed after finishing: still offer it.
    expect(agentLooksFinished(linked(), todoAgentState(linked(), []))).toBe(true);
    // Unfinished tasks, or no tasks at all, never suggest done.
    const half = linked({ progress: { done: 1, total: 2, items: [], updated_at: 1 } });
    expect(agentLooksFinished(half, todoAgentState(half, []))).toBe(false);
    const none = linked({ progress: undefined });
    expect(agentLooksFinished(none, todoAgentState(none, []))).toBe(false);
    expect(agentLooksFinished(linked({ status: "done" }), idle)).toBe(false);
  });

  it("list agent task lists that no open to-do follows", () => {
    const withTasks = terminal({ kind: "claude", tasks: { done: 0, total: 1, items: [] } });
    expect(unlinkedAgentTerminals([withTasks], [linked()])).toEqual([]);
    // A finished to-do still owns its terminal's list; it does not reappear.
    expect(unlinkedAgentTerminals([withTasks], [linked({ status: "done" })])).toEqual([]);
    expect(unlinkedAgentTerminals([withTasks], [])).toEqual([withTasks]);
    expect(unlinkedAgentTerminals([terminal({ kind: "claude" })], [])).toEqual([]);
  });

  it("start agents with the title and notes", () => {
    expect(composeTodoPrompt(linked())).toBe("Backfill orders");
    expect(composeTodoPrompt(linked({ notes: "Since 09-22" }))).toBe("Backfill orders\n\nSince 09-22");
  });
});
