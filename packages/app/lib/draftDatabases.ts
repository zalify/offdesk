// Pure logic for the draft-databases UI: query building, page-cache math,
// optimistic row merges and view/column patch builders. No React, no I/O.
import type {
  DraftDbColumn,
  DraftDbColumnInput,
  DraftDbColumnType,
  DraftDbFilter,
  DraftDbFilterOp,
  DraftDbQueryBody,
  DraftDbRow,
  DraftDbSort,
  DraftDbValue,
  DraftDbView,
  DraftDbViewInput,
} from "./api";

export const PAGE_SIZE = 100;
export const OVERSCAN_ROWS = 10;

/** Pseudo columns every database has. `title` is editable; the others are not. */
export const TITLE_COLUMN = "title";
export type FilterColumnKind = DraftDbColumnType | "title" | "created_at" | "updated_at";

// ---------------------------------------------------------------- filters

const TEXT_OPS: DraftDbFilterOp[] = ["contains", "not_contains", "eq", "neq", "is_empty", "is_not_empty"];
const NUMBER_OPS: DraftDbFilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"];

/** Filter operators the UI offers for a column kind. */
export function opsForColumn(kind: FilterColumnKind): DraftDbFilterOp[] {
  switch (kind) {
    case "title":
    case "text":
    case "url":
      return TEXT_OPS;
    case "number":
      return NUMBER_OPS;
    case "date":
      return NUMBER_OPS;
    case "created_at":
    case "updated_at":
      return ["eq", "neq", "gt", "gte", "lt", "lte"];
    case "select":
      return ["eq", "neq", "is_empty", "is_not_empty"];
    case "multi_select":
      return ["contains", "not_contains", "is_empty", "is_not_empty"];
    case "checkbox":
      return ["eq", "neq"];
  }
}

export const OP_LABELS: Record<DraftDbFilterOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "does not contain",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

export function opNeedsValue(op: DraftDbFilterOp): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

export function columnKind(columns: DraftDbColumn[], ref: string): FilterColumnKind | null {
  if (ref === "title" || ref === "created_at" || ref === "updated_at") return ref;
  return columns.find((c) => c.id === ref)?.type ?? null;
}

/** A filter is usable once it has a column and, when needed, a value. */
export function isFilterComplete(f: DraftDbFilter): boolean {
  if (!f.column) return false;
  if (!opNeedsValue(f.op)) return true;
  return f.value !== undefined && f.value !== null && f.value !== "";
}

export function completeFilters(filters: DraftDbFilter[]): DraftDbFilter[] {
  return filters.filter(isFilterComplete).map((f) =>
    opNeedsValue(f.op) ? f : { column: f.column, op: f.op },
  );
}

/** A fresh filter row for the first column, with the first op that kind allows. */
export function newFilter(columns: DraftDbColumn[]): DraftDbFilter {
  const column = TITLE_COLUMN;
  void columns;
  return { column, op: opsForColumn("title")[0] };
}

/** Switching column keeps the op only when the new kind still allows it. */
export function retargetFilter(
  columns: DraftDbColumn[],
  filter: DraftDbFilter,
  column: string,
): DraftDbFilter {
  const kind = columnKind(columns, column) ?? "text";
  const ops = opsForColumn(kind);
  const op = ops.includes(filter.op) ? filter.op : ops[0];
  return { column, op, value: undefined };
}

/** Converts what an input produced into the JSON the hub filters on. */
export function filterValueFor(kind: FilterColumnKind, raw: string): unknown {
  if (raw === "") return undefined;
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "checkbox") return raw === "true";
  return raw;
}

export function hasIncompleteFilters(views: DraftDbView[]): boolean {
  return views.some((v) => v.filters.some((f) => !isFilterComplete(f)));
}

// ------------------------------------------------------------------ query

/** Builds the rows/query body for a view plus the search box. */
export function buildQueryBody(
  view: Pick<DraftDbView, "filters" | "sorts">,
  search: string,
  page: { limit?: number; offset?: number } = {},
): DraftDbQueryBody {
  const body: DraftDbQueryBody = {
    limit: page.limit ?? PAGE_SIZE,
    offset: page.offset ?? 0,
  };
  const filters = completeFilters(view.filters);
  if (filters.length > 0) body.filters = filters;
  if (view.sorts.length > 0) body.sorts = view.sorts.filter((s) => s.column);
  const q = search.trim();
  if (q) body.search = q;
  return body;
}

/** Stable identity of what a view + search would fetch; a change drops the cache. */
export function queryKey(view: Pick<DraftDbView, "filters" | "sorts">, search: string): string {
  const b = buildQueryBody(view, search);
  return JSON.stringify([b.filters ?? [], b.sorts ?? [], b.search ?? ""]);
}

// ------------------------------------------------------------- page cache

export type PageMap = Map<number, DraftDbRow[]>;

export interface RowWindow {
  first: number;
  last: number; // inclusive, -1 when empty
}

/** Row indexes to render for a scroll offset, including overscan. */
export function visibleRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = OVERSCAN_ROWS,
): RowWindow {
  if (total <= 0 || rowHeight <= 0) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(total - 1, Math.ceil((top + viewportHeight) / rowHeight) + overscan - 1);
  return { first: Math.min(first, total - 1), last: Math.max(last, first) };
}

export function pageOf(index: number, pageSize = PAGE_SIZE): number {
  return Math.floor(index / pageSize);
}

/** Page numbers a window touches. */
export function pagesForWindow(win: RowWindow, pageSize = PAGE_SIZE): number[] {
  if (win.last < win.first) return [];
  const pages: number[] = [];
  for (let p = pageOf(win.first, pageSize); p <= pageOf(win.last, pageSize); p++) pages.push(p);
  return pages;
}

/** Pages the window needs that are neither cached nor already in flight. */
export function missingPages(
  win: RowWindow,
  cached: Pick<PageMap, "has">,
  inflight: ReadonlySet<number>,
  pageSize = PAGE_SIZE,
): number[] {
  return pagesForWindow(win, pageSize).filter((p) => !cached.has(p) && !inflight.has(p));
}

export function rowAt(pages: PageMap, index: number, pageSize = PAGE_SIZE): DraftDbRow | null {
  const page = pages.get(pageOf(index, pageSize));
  return page?.[index % pageSize] ?? null;
}

/** Drops cached pages that are no longer near the window (bounded memory). */
export function prunePages(pages: PageMap, win: RowWindow, keepAround = 3, pageSize = PAGE_SIZE): PageMap {
  const lo = pageOf(win.first, pageSize) - keepAround;
  const hi = pageOf(Math.max(win.last, win.first), pageSize) + keepAround;
  const next: PageMap = new Map();
  for (const [p, rows] of pages) if (p >= lo && p <= hi) next.set(p, rows);
  return next;
}

/** Applies fn to the row with this id in whichever cached page holds it. */
export function mapRowInPages(
  pages: PageMap,
  rowId: string,
  fn: (row: DraftDbRow) => DraftDbRow,
): PageMap {
  for (const [p, rows] of pages) {
    const i = rows.findIndex((r) => r.id === rowId);
    if (i < 0) continue;
    const nextRows = rows.slice();
    nextRows[i] = fn(rows[i]);
    const next = new Map(pages);
    next.set(p, nextRows);
    return next;
  }
  return pages;
}

export function findRow(pages: PageMap, rowId: string): DraftDbRow | null {
  for (const rows of pages.values()) {
    const r = rows.find((x) => x.id === rowId);
    if (r) return r;
  }
  return null;
}

// ------------------------------------------------------ optimistic updates

export function isEmptyValue(v: DraftDbValue | undefined): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Optimistic merge of a row PATCH: properties merge, null/"" removes a key. */
export function applyRowPatch(
  row: DraftDbRow,
  patch: { title?: string; properties?: Record<string, DraftDbValue> },
): DraftDbRow {
  const properties = { ...row.properties };
  for (const [k, v] of Object.entries(patch.properties ?? {})) {
    if (v === null || v === "") delete properties[k];
    else properties[k] = v;
  }
  return { ...row, title: patch.title ?? row.title, properties };
}

/** Reverting is restoring the snapshot taken before the optimistic merge. */
export function revertRow(snapshot: DraftDbRow): DraftDbRow {
  return { ...snapshot, properties: { ...snapshot.properties } };
}

/** Pulls the hub's `{error}` message out of an ApiError ("<status>: <body>"). */
export function hubErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const body = raw.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // not JSON
  }
  return body || raw;
}

/** Turns the text of an input into the value to PATCH for a column type. */
export function parseCellInput(type: DraftDbColumnType | "title", text: string): DraftDbValue | undefined {
  const t = text.trim();
  if (type === "number") {
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined; // undefined = invalid, caller keeps editing
  }
  if (type === "title") return text;
  return t === "" ? null : t;
}

// ------------------------------------------------- view / column patch builders

type ViewLike = DraftDbView | DraftDbViewInput;

/** Full-replacement array with one view changed. Ids are always kept. */
export function viewsWithUpdated(
  views: DraftDbView[],
  viewId: string,
  patch: Partial<Omit<DraftDbView, "id">>,
): DraftDbView[] {
  return views.map((v) => (v.id === viewId ? { ...v, ...patch } : v));
}

export function viewsWithAdded(views: DraftDbView[], name: string): DraftDbViewInput[] {
  return [...views, { name, type: "table", filters: [], sorts: [] }];
}

/** Removing the last remaining view is refused (returns the input unchanged). */
export function viewsWithRemoved(views: DraftDbView[], viewId: string): DraftDbView[] {
  if (views.length <= 1) return views;
  return views.filter((v) => v.id !== viewId);
}

export function toggleHiddenColumn(view: ViewLike, columnId: string, hidden: boolean): string[] {
  const cur = (view.hidden_columns ?? []).filter((c) => c !== columnId);
  return hidden ? [...cur, columnId] : cur;
}

export function visibleColumns(columns: DraftDbColumn[], view: Pick<DraftDbView, "hidden_columns">): DraftDbColumn[] {
  const hidden = new Set(view.hidden_columns ?? []);
  return columns.filter((c) => !hidden.has(c.id));
}

export function columnsWithRenamed(columns: DraftDbColumn[], columnId: string, name: string): DraftDbColumn[] {
  return columns.map((c) => (c.id === columnId ? { ...c, name } : c));
}

export function columnsWithOptions(
  columns: DraftDbColumn[],
  columnId: string,
  options: DraftDbColumn["options"],
): DraftDbColumn[] {
  return columns.map((c) => (c.id === columnId ? { ...c, options } : c));
}

export function columnsWithAdded(
  columns: DraftDbColumn[],
  name: string,
  type: DraftDbColumnType,
): DraftDbColumnInput[] {
  const input: DraftDbColumnInput = { name, type };
  if (type === "select" || type === "multi_select") input.options = [];
  return [...columns, input];
}

export function columnsWithRemoved(columns: DraftDbColumn[], columnId: string): DraftDbColumn[] {
  return columns.filter((c) => c.id !== columnId);
}

/** Strips every reference to a deleted column from the views (hub validates them). */
export function viewsWithoutColumn(views: DraftDbView[], columnId: string): DraftDbView[] {
  return views.map((v) => {
    const next: DraftDbView = {
      ...v,
      filters: v.filters.filter((f) => f.column !== columnId),
      sorts: v.sorts.filter((s: DraftDbSort) => s.column !== columnId),
    };
    if (v.hidden_columns) next.hidden_columns = v.hidden_columns.filter((c) => c !== columnId);
    if (v.group_by === columnId) delete next.group_by;
    return next;
  });
}

/** Views as saved: incomplete filter rows (still being typed) are not persisted. */
export function sanitizeViewsForSave(views: DraftDbView[]): DraftDbView[] {
  return views.map((v) => ({ ...v, filters: completeFilters(v.filters) }));
}

/** Options of a select column that are not in `selected`, filtered by a typed query. */
export function matchingOptions(column: DraftDbColumn, query: string): string[] {
  const q = query.trim().toLowerCase();
  return (column.options ?? []).map((o) => o.name).filter((n) => !q || n.toLowerCase().includes(q));
}

export function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
