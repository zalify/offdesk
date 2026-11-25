// Search box plus the filter/sort builder for the active view. On phones the
// builder lives in a bottom sheet behind one button; on desktop it expands
// inline under the toolbar.
import { useEffect, useRef, useState } from "react";
import { ListFilter, Trash2, X } from "lucide-react";

import type { DraftDatabase, DraftDbFilter, DraftDbSort, DraftDbView } from "@/lib/api";
import {
  OP_LABELS,
  columnKind,
  filterValueFor,
  newFilter,
  opNeedsValue,
  opsForColumn,
  retargetFilter,
} from "@/lib/draftDatabases";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { MONO, Sheet, fieldStyle, smallBtn } from "./ui.web";

interface ViewToolbarProps {
  db: DraftDatabase;
  view: DraftDbView;
  compact: boolean;
  onSearch: (text: string) => void;
  onChangeView: (patch: Partial<Omit<DraftDbView, "id">>) => void;
  selectedCount: number;
  onBulkDelete: () => void;
  bulkBusy: boolean;
}

export function ViewToolbar({ db, view, compact, onSearch, onChangeView, selectedCount, onBulkDelete, bulkBusy }: ViewToolbarProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(() => {
    const t = window.setTimeout(() => onSearchRef.current(text), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (selectedCount === 0) setConfirmBulk(false);
  }, [selectedCount]);

  const active = view.filters.length + view.sorts.length;
  const panel = <FilterSortPanel db={db} view={view} compact={compact} onChangeView={onChangeView} />;

  return (
    <div style={{ borderBottom: `1px solid ${colors.lineSoft}`, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px" }}>
        <input
          data-testid="draftdb-search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="search titles"
          style={{ ...fieldStyle(compact), flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          data-testid="draftdb-filter-button"
          onClick={() => setOpen((o) => !o)}
          style={smallBtn({ compact, active: open || active > 0 })}
        >
          <ListFilter size={13} />
          {compact ? "filter / sort" : "filter · sort"}
          {active > 0 ? ` (${active})` : ""}
        </button>
        {selectedCount > 0 &&
          (confirmBulk ? (
            <button
              type="button"
              data-testid="draftdb-bulk-delete-confirm"
              disabled={bulkBusy}
              onClick={() => {
                setConfirmBulk(false);
                onBulkDelete();
              }}
              style={smallBtn({ compact, danger: true })}
            >
              confirm delete {selectedCount}
            </button>
          ) : (
            <button
              type="button"
              data-testid="draftdb-bulk-delete"
              onClick={() => setConfirmBulk(true)}
              style={smallBtn({ compact, danger: true })}
            >
              <Trash2 size={13} />
              delete {selectedCount}
            </button>
          ))}
      </div>
      {open &&
        (compact ? (
          <Sheet title="filter / sort" onClose={() => setOpen(false)} testId="draftdb-filter-sheet">
            {panel}
          </Sheet>
        ) : (
          <div data-testid="draftdb-filter-panel" style={{ padding: "0 12px 10px" }}>
            {panel}
          </div>
        ))}
    </div>
  );
}

function FilterSortPanel({
  db,
  view,
  compact,
  onChangeView,
}: {
  db: DraftDatabase;
  view: DraftDbView;
  compact: boolean;
  onChangeView: (patch: Partial<Omit<DraftDbView, "id">>) => void;
}) {
  const filterColumns = [{ id: "title", name: "Title" }, ...db.columns.map((c) => ({ id: c.id, name: c.name }))];
  const sortColumns = [
    ...filterColumns,
    { id: "created_at", name: "Created" },
    { id: "updated_at", name: "Updated" },
  ];
  const setFilter = (i: number, f: DraftDbFilter) =>
    onChangeView({ filters: view.filters.map((x, j) => (j === i ? f : x)) });
  const setSort = (i: number, s: DraftDbSort) =>
    onChangeView({ sorts: view.sorts.map((x, j) => (j === i ? s : x)) });
  const field = fieldStyle(compact);
  const label: React.CSSProperties = { fontFamily: MONO, fontSize: rem(11), color: colors.fg2, margin: "6px 0 4px", textTransform: "uppercase", letterSpacing: "0.04em" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={label}>filters (all must match)</div>
      {view.filters.length === 0 && <div style={{ color: colors.fg2, fontFamily: MONO, fontSize: rem(12) }}>No filters.</div>}
      {view.filters.map((f, i) => {
        const kind = columnKind(db.columns, f.column) ?? "text";
        const column = db.columns.find((c) => c.id === f.column);
        return (
          <div key={i} data-testid={`draftdb-filter-${i}`} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select value={f.column} onChange={(e) => setFilter(i, retargetFilter(db.columns, f, e.target.value))} style={field}>
              {filterColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => setFilter(i, { ...f, op: e.target.value as DraftDbFilter["op"] })} style={field}>
              {opsForColumn(kind).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {opNeedsValue(f.op) &&
              (kind === "select" || kind === "multi_select" ? (
                <select
                  value={typeof f.value === "string" ? f.value : ""}
                  onChange={(e) => setFilter(i, { ...f, value: filterValueFor(kind, e.target.value) })}
                  style={field}
                >
                  <option value="">choose…</option>
                  {(column?.options ?? []).map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : kind === "checkbox" ? (
                <select
                  value={f.value === undefined ? "" : String(f.value)}
                  onChange={(e) => setFilter(i, { ...f, value: filterValueFor(kind, e.target.value) })}
                  style={field}
                >
                  <option value="">choose…</option>
                  <option value="true">checked</option>
                  <option value="false">unchecked</option>
                </select>
              ) : (
                <input
                  type={kind === "number" ? "number" : kind === "date" || kind === "created_at" || kind === "updated_at" ? "date" : "text"}
                  value={f.value === undefined || f.value === null ? "" : String(f.value)}
                  placeholder="value"
                  onChange={(e) => setFilter(i, { ...f, value: filterValueFor(kind, e.target.value) })}
                  style={{ ...field, width: compact ? "100%" : 160 }}
                />
              ))}
            <button type="button" aria-label="Remove filter" onClick={() => onChangeView({ filters: view.filters.filter((_, j) => j !== i) })} style={smallBtn({ compact })}>
              <X size={13} />
            </button>
          </div>
        );
      })}
      <div>
        <button type="button" data-testid="draftdb-add-filter" onClick={() => onChangeView({ filters: [...view.filters, newFilter(db.columns)] })} style={smallBtn({ compact })}>
          + filter
        </button>
      </div>

      {(view.hidden_columns ?? []).length > 0 && (
        <>
          <div style={label}>hidden columns</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(view.hidden_columns ?? []).map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`draftdb-show-column-${id}`}
                onClick={() => onChangeView({ hidden_columns: (view.hidden_columns ?? []).filter((c) => c !== id) })}
                style={smallBtn({ compact })}
              >
                show {db.columns.find((c) => c.id === id)?.name ?? id}
              </button>
            ))}
          </div>
        </>
      )}

      <div style={label}>sort</div>
      {view.sorts.length === 0 && <div style={{ color: colors.fg2, fontFamily: MONO, fontSize: rem(12) }}>Oldest first (default).</div>}
      {view.sorts.map((s, i) => (
        <div key={i} data-testid={`draftdb-sort-${i}`} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select value={s.column} onChange={(e) => setSort(i, { ...s, column: e.target.value })} style={field}>
            {sortColumns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={s.dir} onChange={(e) => setSort(i, { ...s, dir: e.target.value as "asc" | "desc" })} style={field}>
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
          <button type="button" aria-label="Remove sort" onClick={() => onChangeView({ sorts: view.sorts.filter((_, j) => j !== i) })} style={smallBtn({ compact })}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          data-testid="draftdb-add-sort"
          onClick={() => onChangeView({ sorts: [...view.sorts, { column: "title", dir: "asc" }] })}
          style={smallBtn({ compact })}
        >
          + sort
        </button>
      </div>
    </div>
  );
}
