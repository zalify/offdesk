// Board view: one column per option of the group-by column. Counts and cards
// are paged per column on the hub; moving a card is a PATCH of the group
// property, applied optimistically and reverted when the hub refuses.
import { useEffect, useRef, useState } from "react";

import { createDraftDbRows, patchDraftDbRow } from "@/lib/api";
import type { DraftDatabase, DraftDbColumnInput, DraftDbView, DraftDbViewInput } from "@/lib/api";
import {
  boardGroupColumn,
  columnsWithStatus,
  groupableColumns,
  hubErrorMessage,
} from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { BoardView } from "./BoardView.web";
import { ViewToolbar } from "./ViewToolbar.web";
import { MONO, fieldStyle, smallBtn } from "./ui.web";
import { useBoardCards } from "./useBoardCards";
import { useRefreshPoll } from "./usePoll";

interface DatabaseBoardProps {
  db: DraftDatabase;
  view: DraftDbView;
  compact: boolean;
  active: boolean;
  onViewChange: (patch: Partial<Omit<DraftDbView, "id">>) => void;
  onSchemaChange: (patch: { columns?: DraftDbColumnInput[]; views?: DraftDbViewInput[] }) => Promise<DraftDatabase | null>;
  onRefreshDb: () => void;
  onOpenRow: (rowId: string) => void;
}

export function DatabaseBoard({ db, view, compact, active, onViewChange, onSchemaChange, onRefreshDb, onOpenRow }: DatabaseBoardProps) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const groupColumn = boardGroupColumn(db.columns, view);
  const cards = useBoardCards(db.id, view, search, groupColumn);
  const writes = useRef(0);

  const { reload } = cards;
  const tick = () => {
    if (writes.current > 0) return;
    void reload();
    onRefreshDb();
  };
  useRefreshPoll(active, tick);

  // Coming back from a row page: whatever it wrote may have moved cards.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      void reload();
      onRefreshDb();
    }
    wasActive.current = active;
  }, [active, reload, onRefreshDb]);

  const onMove = async (rowId: string, toKey: string) => {
    const target = cards.columns.find((c) => c.key === toKey);
    if (!target || !groupColumn) return;
    const undo = cards.moveCard(rowId, toKey, target.value);
    if (!undo) return;
    writes.current += 1;
    try {
      await patchDraftDbRow(db.id, rowId, { properties: { [groupColumn.id]: target.value } });
      setError(null);
    } catch (err) {
      undo();
      setError(`Could not move the card: ${hubErrorMessage(err)}`);
    } finally {
      writes.current -= 1;
      void reload();
    }
  };

  const onCreate = async (key: string, title: string) => {
    const target = cards.columns.find((c) => c.key === key);
    if (!target || !groupColumn) return;
    try {
      await createDraftDbRows(
        db.id,
        [{ title, properties: target.value === null ? undefined : { [groupColumn.id]: target.value } }],
        "create",
      );
      setError(null);
      await reload();
      onRefreshDb();
    } catch (err) {
      setError(hubErrorMessage(err));
    }
  };

  const createStatusColumn = async () => {
    try {
      const resp = await onSchemaChange({ columns: columnsWithStatus(db.columns) });
      const status = resp?.columns.find((c) => c.name === "Status");
      if (status) onViewChange({ group_by: status.id });
      setError(null);
    } catch (err) {
      setError(hubErrorMessage(err));
    }
  };

  const groupable = groupableColumns(db.columns);
  const groupSelect = groupColumn && (
    <select
      data-testid="draftdb-board-group-by"
      aria-label="Group by"
      value={groupColumn.id}
      onChange={(e) => onViewChange({ group_by: e.target.value })}
      style={{ ...fieldStyle(compact), ...(compact ? { flex: 1 } : {}) }}
    >
      {groupable.map((c) => (
        <option key={c.id} value={c.id}>
          group by {c.name}
        </option>
      ))}
    </select>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ViewToolbar
        db={db}
        view={view}
        compact={compact}
        onSearch={setSearch}
        onChangeView={onViewChange}
        selectedCount={0}
        onBulkDelete={() => undefined}
        bulkBusy={false}
        extra={groupSelect}
      />
      {(error ?? cards.error) && (
        <div
          role="alert"
          data-testid="draftdb-board-error"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: colorAlpha.dangerSoft, color: colors.fg0, fontFamily: MONO, fontSize: rem(12) }}
        >
          <span style={{ flex: 1 }}>{error ?? cards.error}</span>
          {error && (
            <button type="button" onClick={() => setError(null)} style={smallBtn({ compact })}>
              dismiss
            </button>
          )}
        </div>
      )}
      {!groupColumn ? (
        <div data-testid="draftdb-board-nogroup" style={{ padding: 24, fontFamily: MONO, fontSize: rem(12.5), color: colors.fg2, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <span>A board groups rows by a select or checkbox column, and this database has none.</span>
          <button type="button" data-testid="draftdb-board-create-status" onClick={() => void createStatusColumn()} style={smallBtn({ compact, active: true })}>
            add a Status column (todo / doing / done)
          </button>
        </div>
      ) : !cards.ready ? (
        <div style={{ padding: 24, fontFamily: MONO, fontSize: rem(12.5), color: colors.fg2 }}>Loading board…</div>
      ) : (
        <BoardView
          db={db}
          view={view}
          groupColumn={groupColumn}
          columns={cards.columns}
          state={cards.state}
          loadingMore={cards.loadingMore}
          compact={compact}
          onLoadMore={(k) => void cards.loadMore(k)}
          onOpenRow={onOpenRow}
          onMove={(rowId, key) => void onMove(rowId, key)}
          onCreate={onCreate}
        />
      )}
    </div>
  );
}
