import { describe, expect, test } from "vitest";

import type { DraftDbColumn, DraftDbRow, DraftDbView } from "./api";
import {
  PAGE_SIZE,
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
