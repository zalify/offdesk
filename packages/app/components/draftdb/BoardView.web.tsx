// The columns-and-cards surface of a board, shared by the full board view and
// the read-only embed in a markdown draft. It owns only transient UI state
// (drag, move menu, "+ new" input); data and writes come in through props.
import { useState } from "react";
import { MoveRight } from "lucide-react";

import type { DraftDatabase, DraftDbColumn, DraftDbRow, DraftDbView } from "@/lib/api";
import { cardProperties } from "@/lib/draftDatabases";
import type { BoardColumn, BoardState } from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { OptionChip, optionColor } from "./chips.web";
import { MONO, Popover, fieldStyle, smallBtn } from "./ui.web";

interface BoardViewProps {
  db: Pick<DraftDatabase, "columns">;
  view: Pick<DraftDbView, "hidden_columns">;
  groupColumn: DraftDbColumn;
  columns: BoardColumn[];
  state: BoardState;
  loadingMore: Record<string, boolean>;
  compact: boolean;
  /** Embeds: no drag, no move menu, no "+ new", cards are not clickable. */
  readOnly?: boolean;
  onLoadMore: (key: string) => void;
  onOpenRow?: (rowId: string) => void;
  onMove?: (rowId: string, toKey: string) => void;
  onCreate?: (key: string, title: string) => Promise<void>;
}

export function BoardView(props: BoardViewProps) {
  const { db, view, groupColumn, columns, state, loadingMore, compact, readOnly, onLoadMore, onOpenRow, onMove, onCreate } = props;
  const [drag, setDrag] = useState<{ rowId: string; fromKey: string } | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ rowId: string; fromKey: string; anchor: HTMLElement } | null>(null);
  const [newOpen, setNewOpen] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const colWidth = compact ? "85vw" : 272;

  const submitNew = async (key: string) => {
    const title = newTitle.trim();
    if (!title || creating || !onCreate) return;
    setCreating(true);
    try {
      await onCreate(key, title);
      setNewTitle("");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      data-testid="draftdb-board"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        gap: 10,
        padding: 12,
        overflowX: "auto",
        overflowY: "hidden",
        boxSizing: "border-box",
        background: colors.bg1,
        scrollSnapType: compact ? "x mandatory" : undefined,
        scrollPaddingLeft: compact ? 12 : undefined,
        fontFamily: MONO,
      }}
    >
      {columns.map((col) => {
        const rows = state.rows[col.key] ?? [];
        const count = state.counts[col.key] ?? col.count;
        const over = overKey === col.key && drag !== null && drag.fromKey !== col.key;
        return (
          <div
            key={col.key}
            data-testid={`draftdb-board-column-${col.key}`}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (overKey !== col.key) setOverKey(col.key);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setOverKey((k) => (k === col.key ? null : k));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const d = drag;
              setDrag(null);
              setOverKey(null);
              if (d && d.fromKey !== col.key) onMove?.(d.rowId, col.key);
            }}
            style={{
              width: colWidth,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRadius: 6,
              border: `1px solid ${over ? colors.accent : colors.lineSoft}`,
              background: over ? colorAlpha.accentSubtle : colors.bg0,
              scrollSnapAlign: compact ? "start" : undefined,
              boxSizing: "border-box",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexShrink: 0, fontSize: rem(12), color: colors.fg1 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, color: col.value === null ? colors.fg2 : colors.fg0 }}>
                {col.label}
              </span>
              <span data-testid={`draftdb-board-count-${col.key}`} style={{ color: colors.fg2, fontSize: rem(11.5) }}>
                {count}
              </span>
            </div>
            <div
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) onLoadMore(col.key);
              }}
              style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px", display: "flex", flexDirection: "column", gap: 6 }}
            >
              {rows.map((row) => (
                <BoardCard
                  key={row.id}
                  row={row}
                  columns={db.columns}
                  view={view}
                  groupColumn={groupColumn}
                  compact={compact}
                  readOnly={!!readOnly}
                  dragging={drag?.rowId === row.id}
                  onOpen={() => onOpenRow?.(row.id)}
                  onDragStart={() => setDrag({ rowId: row.id, fromKey: col.key })}
                  onDragEnd={() => {
                    setDrag(null);
                    setOverKey(null);
                  }}
                  onMoveMenu={(anchor) => setMoveMenu({ rowId: row.id, fromKey: col.key, anchor })}
                />
              ))}
              {rows.length < count && (
                <button
                  type="button"
                  onClick={() => onLoadMore(col.key)}
                  style={{ ...smallBtn({ compact }), alignSelf: "center", marginBottom: 6 }}
                >
                  {loadingMore[col.key] ? "loading…" : `load more (${count - rows.length})`}
                </button>
              )}
              {rows.length === 0 && count === 0 && (
                <div style={{ color: colors.fg3, fontSize: rem(11.5), padding: "4px 2px 8px" }}>empty</div>
              )}
            </div>
            {!readOnly && onCreate && (
              <div style={{ padding: 8, flexShrink: 0 }}>
                {newOpen === col.key ? (
                  <input
                    autoFocus
                    data-testid={`draftdb-board-new-input-${col.key}`}
                    value={newTitle}
                    placeholder="title, enter to add"
                    enterKeyHint="done"
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitNew(col.key);
                      else if (e.key === "Escape") {
                        setNewOpen(null);
                        setNewTitle("");
                      }
                    }}
                    onBlur={() => {
                      if (!newTitle.trim()) setNewOpen(null);
                    }}
                    style={{ ...fieldStyle(compact), width: "100%" }}
                  />
                ) : (
                  <button
                    type="button"
                    data-testid={`draftdb-board-new-${col.key}`}
                    onClick={() => {
                      setNewOpen(col.key);
                      setNewTitle("");
                    }}
                    style={{ ...smallBtn({ compact }), width: "100%", justifyContent: "flex-start", border: "none", background: "transparent", color: colors.fg2 }}
                  >
                    + new
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {moveMenu && (
        <Popover anchor={moveMenu.anchor} onClose={() => setMoveMenu(null)} width={220} testId="draftdb-move-menu">
          <div style={{ padding: "2px 6px 6px", color: colors.fg2, fontSize: rem(11) }}>move to…</div>
          {columns
            .filter((c) => c.key !== moveMenu.fromKey)
            .map((c) => (
              <button
                key={c.key}
                type="button"
                data-testid={`draftdb-move-to-${c.key}`}
                onClick={() => {
                  const m = moveMenu;
                  setMoveMenu(null);
                  onMove?.(m.rowId, c.key);
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  minHeight: compact ? 40 : 28,
                  alignItems: "center",
                  padding: "0 8px",
                  border: "none",
                  borderRadius: 4,
                  background: "transparent",
                  color: colors.fg0,
                  fontFamily: MONO,
                  fontSize: rem(12.5),
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {c.label}
              </button>
            ))}
        </Popover>
      )}
    </div>
  );
}

function BoardCard({
  row,
  columns,
  view,
  groupColumn,
  compact,
  readOnly,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onMoveMenu,
}: {
  row: DraftDbRow;
  columns: DraftDbColumn[];
  view: Pick<DraftDbView, "hidden_columns">;
  groupColumn: DraftDbColumn;
  compact: boolean;
  readOnly: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMoveMenu: (anchor: HTMLElement) => void;
}) {
  const props = cardProperties(columns, view, row, groupColumn.id, 3);
  const canDrag = !readOnly && !compact;
  return (
    <div
      data-testid={`draftdb-card-${row.id}`}
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={readOnly ? undefined : onOpen}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        minHeight: compact ? 44 : undefined,
        borderRadius: 4,
        border: `1px solid ${colors.lineSoft}`,
        background: colors.bg2,
        opacity: dragging ? 0.45 : 1,
        cursor: readOnly ? "default" : canDrag ? "grab" : "pointer",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: rem(13), color: row.title ? colors.fg0 : colors.fg3, wordBreak: "break-word" }}>
          {row.title || "(untitled)"}
        </span>
        {!readOnly && (
          <button
            type="button"
            data-testid={`draftdb-card-move-${row.id}`}
            aria-label="Move to…"
            title="Move to…"
            onClick={(e) => {
              e.stopPropagation();
              onMoveMenu(e.currentTarget);
            }}
            style={{
              ...smallBtn({ compact }),
              border: "none",
              background: "transparent",
              color: colors.fg2,
              padding: 0,
              width: compact ? 36 : 24,
              minWidth: compact ? 36 : 24,
              minHeight: compact ? 36 : 24,
              margin: compact ? "-8px -8px -8px 0" : "-3px -4px 0 0",
            }}
          >
            <MoveRight size={14} />
          </button>
        )}
      </div>
      {props.map((p) => (
        <div key={p.column.id} style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontSize: rem(11.5), color: colors.fg2 }}>
          {p.column.type === "select" || p.column.type === "multi_select" ? (
            p.values.map((v) => <OptionChip key={v} name={v} color={optionColor(p.column, v)} />)
          ) : p.column.type === "checkbox" ? (
            <span>✓ {p.column.name}</span>
          ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
              {p.column.name}: {p.values[0]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
