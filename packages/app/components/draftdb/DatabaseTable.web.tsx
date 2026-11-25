// Virtual-scrolled, inline-editable grid for one database view. Only the rows
// in (and just around) the viewport are mounted; their data comes from the
// paged cache in useDatabaseRows, so a 100k-row table costs one spacer div.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Plus } from "lucide-react";

import {
  createDraftDbRows,
  deleteDraftDbRows,
  patchDraftDbRow,
} from "@/lib/api";
import type {
  DraftDatabase,
  DraftDbColumn,
  DraftDbColumnInput,
  DraftDbColumnType,
  DraftDbValue,
  DraftDbView,
  DraftDbViewInput,
} from "@/lib/api";
import {
  applyRowPatch,
  columnsWithAdded,
  columnsWithOptions,
  columnsWithRemoved,
  columnsWithRenamed,
  hubErrorMessage,
  queryKey,
  revertRow,
  rowAt,
  toggleHiddenColumn,
  viewsWithoutColumn,
  visibleColumns,
  visibleRowWindow,
} from "@/lib/draftDatabases";
import type { RowWindow } from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { AddColumnPopover, ColumnMenu } from "./ColumnMenu.web";
import { PropertyCell } from "./PropertyCell.web";
import { ViewToolbar } from "./ViewToolbar.web";
import { MONO, smallBtn } from "./ui.web";
import { useDatabaseRows } from "./useDatabaseRows";

export const REFRESH_MS = 5000;

function columnWidth(type: DraftDbColumnType): number {
  switch (type) {
    case "checkbox":
      return 110;
    case "number":
      return 120;
    case "date":
      return 150;
    case "select":
      return 170;
    case "multi_select":
    case "url":
      return 230;
    default:
      return 210;
  }
}

interface DatabaseTableProps {
  db: DraftDatabase;
  view: DraftDbView;
  compact: boolean;
  /** False while a row page covers the table or the document is hidden: no polling. */
  active: boolean;
  onViewChange: (patch: Partial<Omit<DraftDbView, "id">>) => void;
  onSchemaChange: (patch: { columns?: DraftDbColumnInput[]; views?: DraftDbViewInput[] }) => Promise<void>;
  onRefreshDb: () => void;
  onOpenRow: (rowId: string) => void;
}

interface CellError {
  rowId: string;
  columnId: string;
  message: string;
}

export function DatabaseTable({ db, view, compact, active, onViewChange, onSchemaChange, onRefreshDb, onOpenRow }: DatabaseTableProps) {
  const ROW_H = compact ? 40 : 32;
  const HEADER_H = compact ? 40 : 32;
  const SEL_W = compact ? 40 : 32;
  const TITLE_W = compact ? 190 : 280;
  const STICKY_W = SEL_W + TITLE_W;

  const [search, setSearch] = useState("");
  const rows = useDatabaseRows(db.id, view, search);
  const columns = useMemo(() => visibleColumns(db.columns, view), [db.columns, view]);
  const totalWidth = STICKY_W + columns.reduce((w, c) => w + columnWidth(c.type), 0) + 56;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<RowWindow>({ first: 0, last: -1 });
  const [viewportH, setViewportH] = useState(600);
  const scrollTopRef = useRef(0);
  const rafRef = useRef(0);

  const [editing, setEditing] = useState<{ rowId: string; columnId: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [menu, setMenu] = useState<{ columnId: string; anchor: HTMLElement } | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [cellError, setCellError] = useState<CellError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const writesRef = useRef(0);

  const total = rows.total;
  const recompute = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || total === null) return;
    const next = visibleRowWindow(scrollTopRef.current, el.clientHeight || viewportH, ROW_H, total);
    setWin((w) => (w.first === next.first && w.last === next.last ? w : next));
  }, [total, viewportH, ROW_H]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(recompute, [recompute]);

  // New query: back to the top and forget the selection.
  const qKey = queryKey(view, search);
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    scrollTopRef.current = 0;
    setSelected(new Set());
  }, [qKey, db.id]);

  const { ensureWindow, reload } = rows;
  useEffect(() => {
    ensureWindow(win);
  }, [win, rows.total, rows.pages, ensureWindow]);

  const onScroll = () => {
    scrollTopRef.current = scrollerRef.current?.scrollTop ?? 0;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      recompute();
    });
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Coming back from a row page: whatever it wrote may have moved rows.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      void reload();
      onRefreshDb();
    }
    wasActive.current = active;
  }, [active, reload, onRefreshDb]);

  // Agents write through the CLI: poll while visible, never mid-edit.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (editingRef.current || writesRef.current > 0) return;
      void reload();
      onRefreshDb();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, reload, onRefreshDb]);

  const commit = async (rowId: string, column: DraftDbColumn | null, value: DraftDbValue) => {
    const patch = column ? { properties: { [column.id]: value } } : { title: String(value) };
    const snapshot = rows.patchRow(rowId, (r) => applyRowPatch(r, patch));
    writesRef.current += 1;
    try {
      const full = await patchDraftDbRow(db.id, rowId, patch);
      const { content: _content, ...row } = full;
      void _content;
      rows.patchRow(rowId, () => row);
      setCellError(null);
      if (column && (column.type === "select" || column.type === "multi_select")) onRefreshDb();
      void reload();
    } catch (err) {
      if (snapshot) rows.patchRow(rowId, () => revertRow(snapshot));
      setCellError({ rowId, columnId: column?.id ?? "title", message: hubErrorMessage(err) });
    } finally {
      writesRef.current -= 1;
    }
  };

  const addRow = async () => {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await createDraftDbRows(db.id, [{ title }], "create");
      setNewTitle("");
      setNotice(null);
      await reload();
      onRefreshDb();
      if (view.sorts.length === 0) {
        window.setTimeout(() => {
          const el = scrollerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }, 0);
      }
    } catch (err) {
      setNotice(hubErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const bulkDelete = async () => {
    setBulkBusy(true);
    try {
      await deleteDraftDbRows(db.id, [...selected]);
      setSelected(new Set());
      setNotice(null);
      await reload();
      onRefreshDb();
    } catch (err) {
      setNotice(hubErrorMessage(err));
    } finally {
      setBulkBusy(false);
    }
  };

  const schema = async (patch: { columns?: DraftDbColumnInput[]; views?: DraftDbViewInput[] }) => {
    try {
      await onSchemaChange(patch);
      setNotice(null);
      void reload();
    } catch (err) {
      setNotice(hubErrorMessage(err));
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const hasQuery = search.trim() !== "" || view.filters.length > 0;
  const shownError = notice ?? cellError?.message ?? rows.error;
  const menuColumn = menu ? db.columns.find((c) => c.id === menu.columnId) : undefined;

  const cellBorder = `1px solid ${colors.lineSoft}`;
  const idxs: number[] = [];
  for (let i = win.first; i <= win.last; i++) idxs.push(i);

  return (
    <div data-testid="draftdb-table" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ViewToolbar
        db={db}
        view={view}
        compact={compact}
        onSearch={setSearch}
        onChangeView={onViewChange}
        selectedCount={selected.size}
        onBulkDelete={() => void bulkDelete()}
        bulkBusy={bulkBusy}
      />
      {shownError && (
        <div
          role="alert"
          data-testid="draftdb-error"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: colorAlpha.dangerSoft, color: colors.fg0, fontFamily: MONO, fontSize: rem(12) }}
        >
          <span style={{ flex: 1 }}>{shownError}</span>
          <button
            type="button"
            onClick={() => {
              setCellError(null);
              setNotice(null);
            }}
            style={smallBtn({ compact })}
          >
            dismiss
          </button>
        </div>
      )}

      <div ref={scrollerRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative", background: colors.bg1 }}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 4,
              display: "flex",
              height: HEADER_H,
              width: totalWidth,
              background: colors.bg2,
              borderBottom: `1px solid ${colors.line}`,
              fontFamily: MONO,
              fontSize: rem(11.5),
              color: colors.fg2,
            }}
          >
            <div
              style={{ position: "sticky", left: 0, zIndex: 5, width: STICKY_W, flexShrink: 0, display: "flex", alignItems: "center", background: colors.bg2, borderRight: cellBorder }}
            >
              <span style={{ width: SEL_W, display: "inline-flex", justifyContent: "center" }}>
                <input
                  type="checkbox"
                  aria-label="Select loaded rows"
                  checked={selected.size > 0}
                  onChange={() => setSelected(selected.size > 0 ? new Set() : new Set(rows.loaded().map((r) => r.id)))}
                  style={{ width: compact ? 18 : 14, height: compact ? 18 : 14 }}
                />
              </span>
              <span style={{ paddingLeft: 4 }}>Title</span>
            </div>
            {columns.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`draftdb-column-header-${c.id}`}
                onClick={(e) => setMenu({ columnId: c.id, anchor: e.currentTarget })}
                title={`${c.name} (${c.type})`}
                style={{
                  width: columnWidth(c.type),
                  flexShrink: 0,
                  padding: "0 8px",
                  border: "none",
                  borderRight: cellBorder,
                  background: "transparent",
                  color: colors.fg1,
                  fontFamily: MONO,
                  fontSize: rem(11.5),
                  textAlign: "left",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.name}
              </button>
            ))}
            <button
              type="button"
              aria-label="Add column"
              data-testid="draftdb-add-column"
              onClick={(e) => setAddAnchor(e.currentTarget)}
              style={{ width: 56, flexShrink: 0, border: "none", background: "transparent", color: colors.fg1, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              <Plus size={14} />
            </button>
          </div>

          <div style={{ position: "relative", height: (total ?? 0) * ROW_H, width: totalWidth }}>
            {idxs.map((i) => {
              const row = rowAt(rows.pages, i);
              const top = i * ROW_H;
              if (!row) {
                return (
                  <div key={`s${i}`} aria-hidden style={{ position: "absolute", top, height: ROW_H, left: 0, width: totalWidth, borderBottom: cellBorder, display: "flex", alignItems: "center", paddingLeft: SEL_W + 8 }}>
                    <div style={{ height: 8, width: 120, borderRadius: 2, background: colors.bg3, opacity: 0.6 }} />
                  </div>
                );
              }
              const isSel = selected.has(row.id);
              const bg = isSel ? colors.bg3 : colors.bg1;
              const titleEditing = editing?.rowId === row.id && editing.columnId === "title";
              return (
                <div
                  key={row.id}
                  data-testid={`draftdb-row-${row.id}`}
                  style={{ position: "absolute", top, left: 0, height: ROW_H, width: totalWidth, display: "flex", borderBottom: cellBorder, background: bg }}
                >
                  <div style={{ position: "sticky", left: 0, zIndex: 2, width: STICKY_W, flexShrink: 0, display: "flex", alignItems: "center", background: bg, borderRight: cellBorder }}>
                    <span style={{ width: SEL_W, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        data-testid={`draftdb-select-${row.id}`}
                        checked={isSel}
                        onChange={() => toggleSelect(row.id)}
                        style={{ width: compact ? 18 : 14, height: compact ? 18 : 14 }}
                      />
                    </span>
                    <div style={{ flex: 1, minWidth: 0, height: "100%" }}>
                      <PropertyCell
                        column={null}
                        row={row}
                        compact={compact}
                        editing={titleEditing}
                        onStartEdit={() => setEditing({ rowId: row.id, columnId: "title" })}
                        onEndEdit={() => setEditing((e) => (e && e.rowId === row.id && e.columnId === "title" ? null : e))}
                        onCommit={(v) => void commit(row.id, null, v)}
                        invalid={cellError?.rowId === row.id && cellError.columnId === "title"}
                        testId={`draftdb-cell-${row.id}-title`}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="Open row"
                      title="Open as page"
                      data-testid={`draftdb-row-open-${row.id}`}
                      onClick={() => onOpenRow(row.id)}
                      style={{ ...smallBtn({ compact }), border: "none", background: "transparent", color: row.has_content ? colors.accent : colors.fg2, padding: 0, width: compact ? 36 : 28, minHeight: compact ? 36 : 26 }}
                    >
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {columns.map((c) => (
                    <div key={c.id} style={{ width: columnWidth(c.type), flexShrink: 0, borderRight: cellBorder, height: "100%" }}>
                      <PropertyCell
                        column={c}
                        row={row}
                        compact={compact}
                        editing={editing?.rowId === row.id && editing.columnId === c.id}
                        onStartEdit={() => setEditing({ rowId: row.id, columnId: c.id })}
                        onEndEdit={() => setEditing((e) => (e && e.rowId === row.id && e.columnId === c.id ? null : e))}
                        onCommit={(v) => void commit(row.id, c, v)}
                        invalid={cellError?.rowId === row.id && cellError.columnId === c.id}
                        testId={`draftdb-cell-${row.id}-${c.id}`}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        {total === 0 && (
          <div
            data-testid="draftdb-empty"
            style={{ position: "sticky", left: 0, padding: 24, color: colors.fg2, fontFamily: MONO, fontSize: rem(12.5), lineHeight: 1.6, maxWidth: 420 }}
          >
            {hasQuery
              ? "No rows match the current search and filters."
              : "No rows yet. Add one below, or let an agent write rows with `offdesk db`."}
          </div>
        )}
        {total === null && !rows.error && (
          <div style={{ position: "sticky", left: 0, padding: 24, color: colors.fg2, fontFamily: MONO, fontSize: rem(12.5) }}>Loading rows…</div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderTop: `1px solid ${colors.line}`, background: colors.bg1, flexShrink: 0 }}>
        <input
          data-testid="draftdb-new-row"
          value={newTitle}
          placeholder="+ new row — type a title, press enter"
          enterKeyHint="done"
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addRow();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: compact ? 40 : 30,
            padding: "0 10px",
            borderRadius: 4,
            border: `1px solid ${colors.line}`,
            background: colors.bg0,
            color: colors.fg0,
            fontFamily: MONO,
            fontSize: compact ? "16px" : rem(12.5),
            outline: "none",
          }}
        />
        <button type="button" data-testid="draftdb-new-row-submit" disabled={!newTitle.trim() || adding} onClick={() => void addRow()} style={{ ...smallBtn({ compact, active: true }), opacity: newTitle.trim() ? 1 : 0.5 }}>
          add
        </button>
        <span style={{ fontFamily: MONO, fontSize: rem(11.5), color: colors.fg2, whiteSpace: "nowrap" }} data-testid="draftdb-total">
          {total === null ? "…" : `${total.toLocaleString()} ${total === 1 ? "row" : "rows"}`}
        </span>
      </div>

      {menu && menuColumn && (
        <ColumnMenu
          column={menuColumn}
          anchor={menu.anchor}
          compact={compact}
          onClose={() => setMenu(null)}
          onRename={(name) => void schema({ columns: columnsWithRenamed(db.columns, menuColumn.id, name) })}
          onHide={() => onViewChange({ hidden_columns: toggleHiddenColumn(view, menuColumn.id, true) })}
          onDelete={() =>
            void schema({
              columns: columnsWithRemoved(db.columns, menuColumn.id),
              views: viewsWithoutColumn(db.views, menuColumn.id),
            })
          }
          onOptions={(options) => void schema({ columns: columnsWithOptions(db.columns, menuColumn.id, options) })}
        />
      )}
      {addAnchor && (
        <AddColumnPopover
          anchor={addAnchor}
          compact={compact}
          onClose={() => setAddAnchor(null)}
          onCreate={(name, type) => void schema({ columns: columnsWithAdded(db.columns, name, type) })}
        />
      )}
    </div>
  );
}
