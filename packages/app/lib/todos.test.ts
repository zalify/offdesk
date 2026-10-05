import { describe, expect, it } from "vitest";
import type { TodoInfo } from "@offdesk/shared";
import { cleanTitle, doneTodos, draftTodo, folderLabel, openTodos } from "./todos";
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
