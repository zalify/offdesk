import { describe, expect, test } from "vitest";

import { parseArtifactSegments } from "./artifactSegments";

import type { DraftDbColumn, DraftDbRow, DraftDbView } from "./api";
import {
  NONE_KEY,
  PAGE_SIZE,
  applyBoardMove,
  boardColumnQuery,
  boardColumns,
  boardGroupColumn,
  boardGroupsBody,
  cardProperties,
  findInBoard,
  optionTintToken,
  parseDatabaseFence,
  reloadChunks,
  resolveDatabaseRef,
  resolveViewRef,
  viewsWithAdded,
  applyRowPatch,
  buildQueryBody,
  columnsWithAdded,
  columnsWithRemoved,
  columnsWithRenamed,
  completeFilters,
  hubErrorMessage,
  mapRowInPages,
  missingPages,
  opsForColumn,
  pageOf,
  pagesForWindow,
  parseCellInput,
  prunePages,
  queryKey,
  retargetFilter,
  revertRow,
  rowAt,
  sanitizeViewsForSave,
  toggleHiddenColumn,
  viewsWithRemoved,
  viewsWithUpdated,
  viewsWithoutColumn,
  visibleColumns,
  visibleRowWindow,
} from "./draftDatabases";

const columns: DraftDbColumn[] = [
  { id: "status", name: "Status", type: "select", options: [{ name: "todo" }] },
  { id: "due", name: "Due", type: "date" },
  { id: "n", name: "N", type: "number" },
];

const view: DraftDbView = {
  id: "default",
  name: "Table",
  type: "table",
  filters: [],
  sorts: [],
};

function row(id: string, props: DraftDbRow["properties"] = {}): DraftDbRow {
  return { id, database_id: "d", title: id, properties: props, has_content: false, created_at: 1, updated_at: 1 };
}

describe("opsForColumn", () => {
  test("offers type-appropriate operators", () => {
    expect(opsForColumn("text")).toContain("contains");
    expect(opsForColumn("text")).not.toContain("gt");
    expect(opsForColumn("number")).toContain("gte");
    expect(opsForColumn("number")).not.toContain("contains");
    expect(opsForColumn("checkbox")).toEqual(["eq", "neq"]);
    expect(opsForColumn("select")).toEqual(["eq", "neq", "is_empty", "is_not_empty"]);
    expect(opsForColumn("multi_select")).toContain("contains");
    expect(opsForColumn("multi_select")).not.toContain("eq");
    expect(opsForColumn("date")).toContain("lt");
  });

  test("retargeting a filter keeps a compatible op and resets the value", () => {
    const f = retargetFilter(columns, { column: "title", op: "contains", value: "x" }, "n");
    expect(f).toEqual({ column: "n", op: "eq", value: undefined });
    const g = retargetFilter(columns, { column: "n", op: "gt", value: 3 }, "due");
    expect(g.op).toBe("gt");
    expect(g.value).toBeUndefined();
  });
});

describe("buildQueryBody", () => {
  test("empty view yields only paging", () => {
    expect(buildQueryBody(view, "")).toEqual({ limit: PAGE_SIZE, offset: 0 });
  });

  test("includes filters, sorts, trimmed search and offset", () => {
    const v: DraftDbView = {
      ...view,
      filters: [{ column: "status", op: "eq", value: "todo" }],
      sorts: [{ column: "due", dir: "desc" }],
    };
    expect(buildQueryBody(v, "  fix ", { offset: 200 })).toEqual({
      limit: 100,
      offset: 200,
      filters: [{ column: "status", op: "eq", value: "todo" }],
      sorts: [{ column: "due", dir: "desc" }],
      search: "fix",
    });
  });

  test("drops filters that are still missing a value, keeps is_empty", () => {
    const v: DraftDbView = {
      ...view,
      filters: [
        { column: "status", op: "eq" },
        { column: "title", op: "contains", value: "" },
        { column: "due", op: "is_empty", value: "stale" },
      ],
    };
    expect(completeFilters(v.filters)).toEqual([{ column: "due", op: "is_empty" }]);
    expect(buildQueryBody(v, "").filters).toEqual([{ column: "due", op: "is_empty" }]);
  });

  test("queryKey changes with filters, sorts and search only", () => {
    const a = queryKey(view, "");
    expect(queryKey({ ...view, name: "other" } as DraftDbView, "")).toBe(a);
    expect(queryKey(view, "x")).not.toBe(a);
    expect(queryKey({ ...view, sorts: [{ column: "due", dir: "asc" }] }, "")).not.toBe(a);
    // an incomplete filter does not change what is fetched
    expect(queryKey({ ...view, filters: [{ column: "status", op: "eq" }] }, "")).toBe(a);
  });
});

describe("page cache math", () => {
  test("window covers viewport plus overscan and is clamped", () => {
    expect(visibleRowWindow(0, 320, 32, 100_000, 10)).toEqual({ first: 0, last: 19 });
    const w = visibleRowWindow(32 * 5000, 320, 32, 100_000, 10);
    expect(w.first).toBe(4990);
    expect(w.last).toBe(5019);
    expect(visibleRowWindow(32 * 99_990, 320, 32, 100_000, 10).last).toBe(99_999);
    expect(visibleRowWindow(0, 320, 32, 0).last).toBe(-1);
  });

  test("pages for a window and missing pages skip cached and in-flight", () => {
    const win = { first: 95, last: 215 };
    expect(pagesForWindow(win)).toEqual([0, 1, 2]);
    const cached = new Map([[0, [row("a")]]]);
    expect(missingPages(win, cached, new Set([1]))).toEqual([2]);
    expect(pagesForWindow({ first: 0, last: -1 })).toEqual([]);
    expect(pageOf(99)).toBe(0);
    expect(pageOf(100)).toBe(1);
  });

  test("rowAt resolves a global index inside its page", () => {
    const pages = new Map([[1, [row("r100"), row("r101")]]]);
    expect(rowAt(pages, 101)?.id).toBe("r101");
    expect(rowAt(pages, 5)).toBeNull();
  });

  test("prunePages keeps only pages near the window", () => {
    const pages = new Map<number, DraftDbRow[]>([
      [0, []],
      [10, []],
      [500, []],
    ]);
    const kept = prunePages(pages, { first: 1000, last: 1019 }, 1);
    expect([...kept.keys()]).toEqual([10]);
  });

  test("mapRowInPages updates one row immutably and ignores unknown ids", () => {
    const pages = new Map([[0, [row("a"), row("b")]]]);
    const next = mapRowInPages(pages, "b", (r) => ({ ...r, title: "B2" }));
    expect(next).not.toBe(pages);
    expect(next.get(0)?.[1].title).toBe("B2");
    expect(pages.get(0)?.[1].title).toBe("b");
    expect(mapRowInPages(pages, "zzz", (r) => r)).toBe(pages);
  });
});

describe("optimistic row merge and revert", () => {
  test("merges properties and removes on null or empty string", () => {
    const r = row("a", { status: "todo", due: "2026-12-01" });
    const next = applyRowPatch(r, { title: "New", properties: { status: "done", due: null } });
    expect(next.title).toBe("New");
    expect(next.properties).toEqual({ status: "done" });
    expect(applyRowPatch(r, { properties: { status: "" } }).properties).toEqual({ due: "2026-12-01" });
    // original untouched
    expect(r.properties.status).toBe("todo");
  });

  test("revert restores the snapshot without sharing mutable state", () => {
    const r = row("a", { status: "todo" });
    const snap = revertRow(r);
    expect(snap).toEqual(r);
    expect(snap.properties).not.toBe(r.properties);
  });

  test("hubErrorMessage unwraps the hub's JSON error", () => {
    expect(hubErrorMessage(new Error('400: {"error":"Due: invalid date"}'))).toBe("Due: invalid date");
    expect(hubErrorMessage(new Error("500: boom"))).toBe("boom");
  });

  test("parseCellInput coerces numbers and blanks", () => {
    expect(parseCellInput("number", " 3.5 ")).toBe(3.5);
    expect(parseCellInput("number", "")).toBeNull();
    expect(parseCellInput("number", "abc")).toBeUndefined();
    expect(parseCellInput("text", "  ")).toBeNull();
    expect(parseCellInput("title", "  keep ")).toBe("  keep ");
  });
});

describe("view and column patch builders", () => {
  const views: DraftDbView[] = [
    { ...view, filters: [{ column: "status", op: "eq", value: "todo" }], hidden_columns: ["due"] },
    { id: "v2", name: "Second", type: "table", filters: [], sorts: [{ column: "n", dir: "asc" }] },
  ];

  test("updating a view keeps every id and other views", () => {
    const next = viewsWithUpdated(views, "v2", { sorts: [] });
    expect(next.map((v) => v.id)).toEqual(["default", "v2"]);
    expect(next[1].sorts).toEqual([]);
    expect(next[0]).toBe(views[0]);
  });

  test("the last view cannot be removed", () => {
    expect(viewsWithRemoved(views, "v2").map((v) => v.id)).toEqual(["default"]);
    const one = [views[0]];
    expect(viewsWithRemoved(one, "default")).toBe(one);
  });

  test("hidden columns toggle and filter the visible columns", () => {
    expect(toggleHiddenColumn(views[0], "n", true)).toEqual(["due", "n"]);
    expect(toggleHiddenColumn(views[0], "due", false)).toEqual([]);
    expect(visibleColumns(columns, views[0]).map((c) => c.id)).toEqual(["status", "n"]);
  });

  test("column builders produce full replacements; new columns have no id", () => {
    expect(columnsWithRenamed(columns, "due", "Deadline").map((c) => c.id)).toEqual(["status", "due", "n"]);
    expect(columnsWithRenamed(columns, "due", "Deadline")[1].name).toBe("Deadline");
    const added = columnsWithAdded(columns, "Tags", "multi_select");
    expect(added).toHaveLength(4);
    expect(added[3]).toEqual({ name: "Tags", type: "multi_select", options: [] });
    expect("id" in added[3]).toBe(false);
    expect(columnsWithAdded(columns, "Note", "text")[3]).toEqual({ name: "Note", type: "text" });
    expect(columnsWithRemoved(columns, "due").map((c) => c.id)).toEqual(["status", "n"]);
  });

  test("deleting a column removes it from filters, sorts and hidden lists", () => {
    const next = viewsWithoutColumn(
      [{ ...views[0], group_by: "status", sorts: [{ column: "status", dir: "asc" }] }, views[1]],
      "status",
    );
    expect(next[0].filters).toEqual([]);
    expect(next[0].sorts).toEqual([]);
    expect(next[0].group_by).toBeUndefined();
    expect(next[0].hidden_columns).toEqual(["due"]);
    expect(next[1].sorts).toEqual([{ column: "n", dir: "asc" }]);
  });

  test("sanitizeViewsForSave drops incomplete filters but keeps ids", () => {
    const v: DraftDbView[] = [{ ...view, filters: [{ column: "status", op: "eq" }, { column: "n", op: "gt", value: 2 }] }];
    const out = sanitizeViewsForSave(v);
    expect(out[0].id).toBe("default");
    expect(out[0].filters).toEqual([{ column: "n", op: "gt", value: 2 }]);
  });
});

describe("board columns", () => {
  const status: DraftDbColumn = {
    id: "status",
    name: "Status",
    type: "select",
    options: [{ name: "todo" }, { name: "doing" }, { name: "done" }],
  };
  const done: DraftDbColumn = { id: "done", name: "Done", type: "checkbox" };

  test("select: options in order, no-value column only when it has cards", () => {
    const cols = boardColumns(status, [
      { value: "doing", count: 2 },
      { value: "todo", count: 5 },
    ]);
    expect(cols.map((c) => [c.key, c.count])).toEqual([
      ["todo", 5],
      ["doing", 2],
      ["done", 0],
    ]);
    const withNone = boardColumns(status, [{ value: null, count: 3 }, { value: "todo", count: 1 }]);
    expect(withNone[0]).toEqual({ key: NONE_KEY, label: "no value", value: null, count: 3 });
    expect(withNone).toHaveLength(4);
  });

  test("select: unknown values in use get their own column, loading groups show none", () => {
    const cols = boardColumns(status, [{ value: "legacy", count: 4 }]);
    expect(cols.map((c) => c.key)).toEqual(["todo", "doing", "done", "legacy"]);
    expect(boardColumns(status, null).map((c) => c.key)).toEqual(["todo", "doing", "done"]);
  });

  test("select without options keeps the no-value column so cards have somewhere to live", () => {
    const bare: DraftDbColumn = { id: "s", name: "S", type: "select" };
    expect(boardColumns(bare, []).map((c) => c.key)).toEqual([NONE_KEY]);
  });

  test("checkbox: unchecked folds false and unset together", () => {
    const cols = boardColumns(done, [
      { value: null, count: 2 },
      { value: false, count: 3 },
      { value: true, count: 4 },
    ]);
    expect(cols).toEqual([
      { key: "false", label: "unchecked", value: false, count: 5 },
      { key: "true", label: "checked", value: true, count: 4 },
    ]);
  });

  test("group column prefers the saved group_by, then the first groupable column", () => {
    const cols: DraftDbColumn[] = [{ id: "n", name: "N", type: "number" }, done, status];
    expect(boardGroupColumn(cols, { group_by: "status" })?.id).toBe("status");
    expect(boardGroupColumn(cols, {})?.id).toBe("done");
    expect(boardGroupColumn(cols, { group_by: "gone" })?.id).toBe("done");
    expect(boardGroupColumn([{ id: "n", name: "N", type: "number" }], {})).toBeNull();
  });

  test("per-column query ANDs the group value onto the view filters", () => {
    const v: DraftDbView = { ...view, filters: [{ column: "n", op: "gt", value: 1 }], sorts: [{ column: "due", dir: "asc" }] };
    expect(boardColumnQuery(v, " x ", "status", { value: "todo" })).toEqual({
      limit: 30,
      offset: 0,
      filters: [
        { column: "n", op: "gt", value: 1 },
        { column: "status", op: "eq", value: "todo" },
      ],
      sorts: [{ column: "due", dir: "asc" }],
      search: "x",
    });
    expect(boardColumnQuery(view, "", "status", { value: null }, { offset: 30 }).filters).toEqual([
      { column: "status", op: "is_empty" },
    ]);
    expect(boardColumnQuery(view, "", "done", { value: false }).filters).toEqual([
      { column: "done", op: "eq", value: false },
    ]);
  });

  test("groups body carries filters and search but no paging or sorts", () => {
    const v: DraftDbView = { ...view, filters: [{ column: "n", op: "gt", value: 1 }, { column: "n", op: "eq" }], sorts: [{ column: "n", dir: "asc" }] };
    expect(boardGroupsBody(v, " q ", "status")).toEqual({
      group_by: "status",
      filters: [{ column: "n", op: "gt", value: 1 }],
      search: "q",
    });
    expect(boardGroupsBody(view, "", "status")).toEqual({ group_by: "status" });
  });

  test("a refresh re-fetches what is loaded in request-sized chunks", () => {
    expect(reloadChunks(0)).toEqual([{ offset: 0, limit: 30 }]);
    expect(reloadChunks(60)).toEqual([{ offset: 0, limit: 60 }]);
    expect(reloadChunks(1200)).toEqual([
      { offset: 0, limit: 500 },
      { offset: 500, limit: 500 },
      { offset: 1000, limit: 200 },
    ]);
  });

  test("new board views carry group_by, table views do not", () => {
    expect(viewsWithAdded([], "Board", "board", "status")[0]).toMatchObject({ type: "board", group_by: "status" });
    expect(viewsWithAdded([], "T")[0]).toEqual({ name: "T", type: "table", filters: [], sorts: [] });
  });
});

describe("optimistic board move", () => {
  const a = row("a", { status: "todo" });
  const b = row("b", { status: "todo" });
  const c = row("c", { status: "done" });
  const state = {
    counts: { todo: 2, doing: 0, done: 1 },
    rows: { todo: [a, b], doing: [], done: [c] },
  };

  test("moves the card, rewrites the group property and adjusts both counts", () => {
    const next = applyBoardMove(state, "a", "todo", "doing", "status", "doing");
    expect(next.rows.todo.map((r) => r.id)).toEqual(["b"]);
    expect(next.rows.doing.map((r) => r.id)).toEqual(["a"]);
    expect(next.rows.doing[0].properties.status).toBe("doing");
    expect(next.counts).toEqual({ todo: 1, doing: 1, done: 1 });
    // input untouched
    expect(state.rows.todo).toHaveLength(2);
  });

  test("moving to no value removes the property", () => {
    const next = applyBoardMove(state, "c", "done", NONE_KEY, "status", null);
    expect(next.rows[NONE_KEY][0].properties).toEqual({});
    expect(next.counts[NONE_KEY]).toBe(1);
  });

  test("moving back with the original value and index is an exact revert", () => {
    const at = findInBoard(state, "b")!;
    expect(at).toMatchObject({ key: "todo", index: 1 });
    const moved = applyBoardMove(state, "b", "todo", "done", "status", "done");
    const back = applyBoardMove(moved, "b", "done", "todo", "status", "todo", at.index);
    expect(back.rows.todo.map((r) => r.id)).toEqual(["a", "b"]);
    expect(back.rows.todo[1].properties.status).toBe("todo");
    expect(back.rows.done.map((r) => r.id)).toEqual(["c"]);
    expect(back.counts).toEqual(state.counts);
  });

  test("unknown rows and same-column drops are no-ops", () => {
    expect(applyBoardMove(state, "zzz", "todo", "done", "status", "done")).toBe(state);
    expect(applyBoardMove(state, "a", "todo", "todo", "status", "todo")).toBe(state);
  });
});

describe("card properties", () => {
  const cols: DraftDbColumn[] = [
    { id: "status", name: "Status", type: "select", options: [] },
    { id: "owner", name: "Owner", type: "text" },
    { id: "due", name: "Due", type: "date" },
    { id: "tags", name: "Tags", type: "multi_select", options: [] },
    { id: "done", name: "Done", type: "checkbox" },
    { id: "n", name: "N", type: "number" },
  ];
  test("skips the group column, empties and unchecked boxes; caps at 3", () => {
    const r = row("r", { status: "todo", owner: "me", due: "", tags: ["a", "b"], done: true, n: 3 });
    const props = cardProperties(cols, { hidden_columns: [] }, r, "status");
    expect(props.map((p) => p.column.id)).toEqual(["owner", "tags", "done"]);
    expect(props[1].values).toEqual(["a", "b"]);
    expect(cardProperties(cols, {}, row("e", { done: false }), "status")).toEqual([]);
  });
  test("respects hidden columns", () => {
    const r = row("r", { owner: "me", n: 3 });
    expect(cardProperties(cols, { hidden_columns: ["owner"] }, r, null).map((p) => p.column.id)).toEqual(["n"]);
  });
});

describe("database fence", () => {
  test("first line is the database, view: is optional and case-insensitive", () => {
    expect(parseDatabaseFence("tasks\nview: Board")).toEqual({ database: "tasks", view: "Board" });
    expect(parseDatabaseFence("\n  tasks  \n\n View : By status \n")).toEqual({ database: "tasks", view: "By status" });
    expect(parseDatabaseFence("tasks")).toEqual({ database: "tasks" });
    expect(parseDatabaseFence("view: Board")).toBeNull();
    expect(parseDatabaseFence("   \n ")).toBeNull();
  });

  test("databases resolve by id, then by name inside the draft's project first", () => {
    const dbs = [
      { id: "1", name: "Tasks", project_group: "a" },
      { id: "2", name: "tasks", project_group: "b" },
    ];
    expect(resolveDatabaseRef(dbs, "2", "a")?.id).toBe("2");
    expect(resolveDatabaseRef(dbs, "tasks", "b")?.id).toBe("2");
    expect(resolveDatabaseRef(dbs, "TASKS", "a")?.id).toBe("1");
    expect(resolveDatabaseRef(dbs, "tasks")?.id).toBe("1");
    expect(resolveDatabaseRef(dbs, "nope", "a")).toBeNull();
  });

  test("views resolve by id or name, default to the first", () => {
    const views: DraftDbView[] = [view, { ...view, id: "v2", name: "Board", type: "board" }];
    expect(resolveViewRef(views)?.id).toBe("default");
    expect(resolveViewRef(views, "board")?.id).toBe("v2");
    expect(resolveViewRef(views, "v2")?.id).toBe("v2");
    expect(resolveViewRef(views, "missing")).toBeNull();
  });
});

describe("parseArtifactSegments", () => {
  test("splits markdown around mermaid, svg, html and database fences", () => {
    const src = "intro\n\n```database\ntasks\nview: Board\n```\n\nmiddle\n\n```mermaid\ngraph TD; A-->B\n```\n";
    expect(parseArtifactSegments(src)).toEqual([
      { kind: "markdown", text: "intro" },
      { kind: "database", database: "tasks", view: "Board" },
      { kind: "markdown", text: "middle" },
      { kind: "mermaid", code: "graph TD; A-->B" },
    ]);
  });

  test("an empty or nameless database fence is dropped, not rendered", () => {
    expect(parseArtifactSegments("a\n```database\n```\nb")).toEqual([
      { kind: "markdown", text: "a" },
      { kind: "markdown", text: "b" },
    ]);
    expect(parseArtifactSegments("```database\nview: x\n```")).toEqual([]);
  });

  test("standalone html and svg documents stay one artifact", () => {
    expect(parseArtifactSegments("<!doctype html><p>x</p>")).toEqual([{ kind: "html", code: "<!doctype html><p>x</p>" }]);
    expect(parseArtifactSegments("   ")).toEqual([]);
  });
});

describe("option tints", () => {
  test("only red / orange / yellow map to a tint; the rest stay neutral", () => {
    expect(optionTintToken("red")).toBe("err");
    expect(optionTintToken("Orange")).toBe("warn");
    expect(optionTintToken("green")).toBeNull();
    expect(optionTintToken(undefined)).toBeNull();
  });
});
