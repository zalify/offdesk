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

export function viewsWithAdded(
  views: DraftDbView[],
  name: string,
  type: DraftDbView["type"] = "table",
  groupBy?: string,
): DraftDbViewInput[] {
  const view: DraftDbViewInput = { name, type, filters: [], sorts: [] };
  if (type === "board" && groupBy) view.group_by = groupBy;
  return [...views, view];
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

// ------------------------------------------------------------------ board

export const NONE_KEY = "__none__";

export type GroupValue = string | boolean | null;

export interface GroupCount {
  value: GroupValue;
  count: number;
}

export interface BoardColumn {
  /** `__none__`, an option name, or "true" / "false" for checkboxes. */
  key: string;
  label: string;
  value: GroupValue;
  count: number;
}

export const BOARD_PAGE_SIZE = 30;
const BOARD_RELOAD_CHUNK = 500;

export function groupKey(value: GroupValue): string {
  return value === null ? NONE_KEY : String(value);
}

export function groupableColumns(columns: DraftDbColumn[]): DraftDbColumn[] {
  return columns.filter((c) => c.type === "select" || c.type === "checkbox");
}

/** The column a board groups by: its saved group_by, else the first groupable column. */
export function boardGroupColumn(
  columns: DraftDbColumn[],
  view: Pick<DraftDbView, "group_by">,
): DraftDbColumn | null {
  const groupable = groupableColumns(columns);
  return groupable.find((c) => c.id === view.group_by) ?? groupable[0] ?? null;
}

/**
 * Board columns for a group-by column and the hub's per-value counts.
 * select: a leading "no value" column (only when it has cards, or when there
 * are no options at all), then one per option in option order, then any value
 * that is in use but not an option (an option deleted under the cards).
 * checkbox: unchecked (false or unset) and checked.
 */
export function boardColumns(column: DraftDbColumn, groups: GroupCount[] | null): BoardColumn[] {
  if (column.type === "checkbox") {
    let checked = 0;
    let unchecked = 0;
    for (const g of groups ?? []) {
      if (g.value === true) checked += g.count;
      else unchecked += g.count;
    }
    return [
      { key: "false", label: "unchecked", value: false, count: unchecked },
      { key: "true", label: "checked", value: true, count: checked },
    ];
  }
  const counts = new Map<string, number>();
  for (const g of groups ?? []) {
    const key = groupKey(g.value);
    counts.set(key, (counts.get(key) ?? 0) + g.count);
  }
  const options = (column.options ?? []).map((o) => o.name);
  const out: BoardColumn[] = [];
  const noneCount = counts.get(NONE_KEY) ?? 0;
  if (noneCount > 0 || (options.length === 0 && groups !== null)) {
    out.push({ key: NONE_KEY, label: "no value", value: null, count: noneCount });
  }
  for (const name of options) out.push({ key: name, label: name, value: name, count: counts.get(name) ?? 0 });
  for (const [key, count] of counts) {
    if (key === NONE_KEY || options.includes(key) || count <= 0) continue;
    out.push({ key, label: key, value: key, count });
  }
  return out;
}

/** rows/query body for one board column: the view's query plus the column's value. */
export function boardColumnQuery(
  view: Pick<DraftDbView, "filters" | "sorts">,
  search: string,
  groupColumnId: string,
  col: Pick<BoardColumn, "value">,
  page: { limit?: number; offset?: number } = {},
): DraftDbQueryBody {
  const body = buildQueryBody(view, search, { limit: BOARD_PAGE_SIZE, ...page });
  const f: DraftDbFilter =
    col.value === null
      ? { column: groupColumnId, op: "is_empty" }
      : { column: groupColumnId, op: "eq", value: col.value };
  body.filters = [...(body.filters ?? []), f];
  return body;
}

/** rows/groups body for a board: the view's filters and the search, no paging. */
export function boardGroupsBody(
  view: Pick<DraftDbView, "filters">,
  search: string,
  groupColumnId: string,
): { group_by: string; filters?: DraftDbFilter[]; search?: string } {
  const body: { group_by: string; filters?: DraftDbFilter[]; search?: string } = { group_by: groupColumnId };
  const filters = completeFilters(view.filters);
  if (filters.length > 0) body.filters = filters;
  const q = search.trim();
  if (q) body.search = q;
  return body;
}

/** How many rows a refresh of a column must re-fetch, in request-sized chunks. */
export function reloadChunks(loaded: number): Array<{ offset: number; limit: number }> {
  const want = Math.max(BOARD_PAGE_SIZE, loaded);
  const out: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < want; offset += BOARD_RELOAD_CHUNK) {
    out.push({ offset, limit: Math.min(BOARD_RELOAD_CHUNK, want - offset) });
  }
  return out;
}

export interface BoardState {
  counts: Record<string, number>;
  rows: Record<string, DraftDbRow[]>;
}

export function findInBoard(
  state: BoardState,
  rowId: string,
): { key: string; index: number; row: DraftDbRow } | null {
  for (const [key, rows] of Object.entries(state.rows)) {
    const index = rows.findIndex((r) => r.id === rowId);
    if (index >= 0) return { key, index, row: rows[index] };
  }
  return null;
}

/**
 * Optimistic card move: the row leaves `fromKey`, lands at `index` of `toKey`
 * with the group property set to `toValue`, and both counts follow. Moving
 * back with the original value and index is the revert.
 */
export function applyBoardMove(
  state: BoardState,
  rowId: string,
  fromKey: string,
  toKey: string,
  groupColumnId: string,
  toValue: DraftDbValue,
  index = 0,
): BoardState {
  const fromRows = state.rows[fromKey];
  const at = fromRows ? fromRows.findIndex((r) => r.id === rowId) : -1;
  if (at < 0 || fromKey === toKey) return state;
  const moved = applyRowPatch(fromRows[at], { properties: { [groupColumnId]: toValue } });
  const nextFrom = fromRows.filter((r) => r.id !== rowId);
  const toRows = state.rows[toKey] ?? [];
  const nextTo = toRows.slice();
  nextTo.splice(Math.max(0, Math.min(index, nextTo.length)), 0, moved);
  return {
    counts: {
      ...state.counts,
      [fromKey]: Math.max(0, (state.counts[fromKey] ?? 0) - 1),
      [toKey]: (state.counts[toKey] ?? 0) + 1,
    },
    rows: { ...state.rows, [fromKey]: nextFrom, [toKey]: nextTo },
  };
}

export interface CardProperty {
  column: DraftDbColumn;
  /** Option names for select / multi_select, otherwise one display string. */
  values: string[];
}

/** Up to `max` non-empty visible properties for a card, skipping the group column. */
export function cardProperties(
  columns: DraftDbColumn[],
  view: Pick<DraftDbView, "hidden_columns">,
  row: Pick<DraftDbRow, "properties">,
  groupColumnId: string | null,
  max = 3,
): CardProperty[] {
  const out: CardProperty[] = [];
  for (const column of visibleColumns(columns, view)) {
    if (out.length >= max) break;
    if (column.id === groupColumnId) continue;
    const v = row.properties[column.id];
    if (isEmptyValue(v) || v === false) continue;
    if (Array.isArray(v)) out.push({ column, values: v });
    else if (column.type === "checkbox") out.push({ column, values: [column.name] });
    else out.push({ column, values: [String(v)] });
  }
  return out;
}

// ------------------------------------------------------------- embeds

export interface DatabaseFence {
  database: string;
  view?: string;
}

/** Body of a ```database fence: first line names the database, optional `view:` line. */
export function parseDatabaseFence(body: string): DatabaseFence | null {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  let view: string | undefined;
  let database: string | undefined;
  for (const line of lines) {
    const m = /^view\s*:\s*(.*)$/i.exec(line);
    if (m) {
      if (view === undefined && m[1].trim()) view = m[1].trim();
    } else if (database === undefined) {
      database = line;
    }
  }
  if (!database) return null;
  return view ? { database, view } : { database };
}

/** Finds a database by id or name; names resolve in `projectGroup` first, then anywhere. */
export function resolveDatabaseRef<T extends { id: string; name: string; project_group: string }>(
  databases: T[],
  ref: string,
  projectGroup?: string,
): T | null {
  const byId = databases.find((d) => d.id === ref);
  if (byId) return byId;
  const name = ref.trim().toLowerCase();
  const named = databases.filter((d) => d.name.toLowerCase() === name);
  return named.find((d) => projectGroup && d.project_group === projectGroup) ?? named[0] ?? null;
}

/** Finds a view by id or name; no ref means the first view. */
export function resolveViewRef(views: DraftDbView[], ref?: string): DraftDbView | null {
  if (!ref) return views[0] ?? null;
  const name = ref.trim().toLowerCase();
  return views.find((v) => v.id === ref) ?? views.find((v) => v.name.toLowerCase() === name) ?? null;
}

// ----------------------------------------------------------- option tints

/** Option colours that map onto a semantic theme token; everything else stays neutral. */
export function optionTintToken(color: string | undefined): "err" | "warn" | null {
  switch ((color ?? "").toLowerCase()) {
    case "red":
      return "err";
    case "orange":
    case "yellow":
    case "brown":
      return "warn";
    default:
      return null;
  }
}

/** Column list with a `Status` select (todo / doing / done) appended, for boards on a database with nothing to group by. */
export function columnsWithStatus(columns: DraftDbColumn[]): DraftDbColumnInput[] {
  return [
    ...columns,
    { name: "Status", type: "select", options: [{ name: "todo" }, { name: "doing" }, { name: "done" }] },
  ];
}
