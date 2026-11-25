// One open database: header (back, name, view tabs), the table, and the row
// page laid over it. The table stays mounted under the row page so going
// back keeps the scroll position and the page cache.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Plus } from "lucide-react";

import {
  getDraftDatabase,
  updateDraftDatabase,
} from "@/lib/api";
import type { DraftDatabase, DraftDbColumnInput, DraftDbView, DraftDbViewInput } from "@/lib/api";
import {
  boardGroupColumn,
  columnsWithStatus,
  hasIncompleteFilters,
  hubErrorMessage,
  sanitizeViewsForSave,
  viewsWithAdded,
  viewsWithRemoved,
  viewsWithUpdated,
} from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { DatabaseBoard } from "./DatabaseBoard.web";
import { DatabaseTable } from "./DatabaseTable.web";
import { REFRESH_MS } from "./usePoll";
import { RowPage } from "./RowPage.web";
import { ShareControl } from "./ShareControl.web";
import { MONO, Popover, fieldStyle, smallBtn } from "./ui.web";

const VIEW_SAVE_DEBOUNCE_MS = 500;

export function DatabaseView({
  dbId,
  compact,
  initialViewId,
  onBack,
  onChanged,
}: {
  dbId: string;
  /** Opens on this view instead of the first one (from a database embed). */
  initialViewId?: string;
  compact: boolean;
  onBack: () => void;
  /** The database list is stale (renamed, row count changed). */
  onChanged: () => void;
}) {
  const [db, setDb] = useState<DraftDatabase | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(initialViewId ?? null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [tabMenu, setTabMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  const dbRef = useRef<DraftDatabase | null>(null);
  dbRef.current = db;
  const saveTimer = useRef<number | null>(null);
  const saving = useRef(0);

  const refreshDb = useCallback(async () => {
    if (saveTimer.current !== null || saving.current > 0) return;
    try {
      const fresh = await getDraftDatabase(dbId);
      if (saveTimer.current !== null || saving.current > 0) return;
      const local = dbRef.current;
      // Keep half-typed filter rows that the hub never saw.
      const views = local && hasIncompleteFilters(local.views) ? local.views : fresh.views;
      setDb({ ...fresh, views });
      setLoadError(null);
    } catch (err) {
      if (!dbRef.current) setLoadError(hubErrorMessage(err));
    }
  }, [dbId]);

  useEffect(() => {
    setDb(null);
    setViewId(initialViewId ?? null);
    setRowId(null);
    void refreshDb();
    // initialViewId only seeds the first view when a database is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbId, refreshDb]);

  const activeView: DraftDbView | null = db ? (db.views.find((v) => v.id === viewId) ?? db.views[0] ?? null) : null;

  /** Save immediately; pending debounced view edits ride along. */
  const saveDb = useCallback(
    async (patch: { name?: string; columns?: DraftDbColumnInput[]; views?: DraftDbViewInput[] }) => {
      const local = dbRef.current;
      if (!local) return null;
      const pending = saveTimer.current !== null;
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const payload = { ...patch };
      if (!payload.views && pending) payload.views = sanitizeViewsForSave(local.views);
      saving.current += 1;
      try {
        const resp = await updateDraftDatabase(dbId, payload);
        const cur = dbRef.current;
        const views = cur && hasIncompleteFilters(cur.views) && !patch.views ? cur.views : resp.views;
        setDb({ ...resp, views });
        onChanged();
        return resp;
      } finally {
        saving.current -= 1;
      }
    },
    [dbId, onChanged],
  );

  const onViewChange = useCallback(
    (patch: Partial<Omit<DraftDbView, "id">>) => {
      const local = dbRef.current;
      const view = local?.views.find((v) => v.id === viewId) ?? local?.views[0];
      if (!local || !view) return;
      setDb({ ...local, views: viewsWithUpdated(local.views, view.id, patch) });
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const latest = dbRef.current;
        if (!latest) return;
        saving.current += 1;
        updateDraftDatabase(dbId, { views: sanitizeViewsForSave(latest.views) })
          .then((resp) => {
            const cur = dbRef.current;
            const views = cur && hasIncompleteFilters(cur.views) ? cur.views : resp.views;
            setDb({ ...resp, views });
            setError(null);
          })
          .catch((err) => setError(hubErrorMessage(err)))
          .finally(() => {
            saving.current -= 1;
          });
      }, VIEW_SAVE_DEBOUNCE_MS);
    },
    [dbId, viewId],
  );

  // Flush a pending view save when leaving.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const latest = dbRef.current;
        if (latest) void updateDraftDatabase(dbId, { views: sanitizeViewsForSave(latest.views) }).catch(() => undefined);
      }
    },
    [dbId],
  );

  const refreshDbQuiet = useCallback(() => {
    void refreshDb();
  }, [refreshDb]);

  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(hubErrorMessage(err));
    }
  };

  const addView = (type: "table" | "board") =>
    guarded(async () => {
      const local = dbRef.current;
      if (!local) return;
      let columns = local.columns;
      let group = boardGroupColumn(columns, {});
      if (type === "board" && !group) {
        // Nothing to group by yet: create the Status column first so the view can point at it.
        const withStatus = await saveDb({ columns: columnsWithStatus(columns) });
        columns = withStatus?.columns ?? columns;
        group = columns.find((c) => c.name === "Status") ?? null;
      }
      const latest = dbRef.current ?? local;
      const label = type === "board" ? "Board" : "Table";
      const taken = latest.views.filter((v) => v.name.toLowerCase().startsWith(label.toLowerCase())).length;
      const name = taken === 0 ? label : `${label} ${taken + 1}`;
      const resp = await saveDb({ views: viewsWithAdded(latest.views, name, type, group?.id) });
      const created = resp?.views[resp.views.length - 1];
      if (created) setViewId(created.id);
    });

  const renameView = (id: string, name: string) =>
    guarded(async () => {
      const local = dbRef.current;
      if (local) await saveDb({ views: viewsWithUpdated(local.views, id, { name }) });
    });

  const deleteView = (id: string) =>
    guarded(async () => {
      const local = dbRef.current;
      if (!local) return;
      const next = viewsWithRemoved(local.views, id);
      if (next === local.views) return;
      await saveDb({ views: next });
      if (viewId === id) setViewId(null);
    });

  // Keep the freshness poll for the database record itself when the table is hidden by a row page.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible" && rowId === null) void refreshDb();
    }, REFRESH_MS * 3);
    return () => window.clearInterval(t);
  }, [refreshDb, rowId]);

  const header: React.CSSProperties = { fontFamily: MONO, color: colors.fg0 };

  if (!db || !activeView) {
    return (
      <div style={{ ...header, padding: 16, fontSize: rem(13), color: colors.fg2 }}>
        <button type="button" onClick={onBack} style={smallBtn({ compact })}>
          <ChevronLeft size={13} />
          back
        </button>
        <div style={{ marginTop: 12 }} role={loadError ? "alert" : undefined}>
          {loadError ?? "Loading database…"}
        </div>
      </div>
    );
  }

  const tabMenuView = tabMenu ? db.views.find((v) => v.id === tabMenu.id) : undefined;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative", ...header }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${colors.lineSoft}`, flexShrink: 0 }}>
        <button type="button" data-testid="draftdb-back" aria-label="Back to databases" onClick={onBack} style={smallBtn({ compact })}>
          <ChevronLeft size={13} />
          {compact ? "" : "back"}
        </button>
        {renaming ? (
          <input
            autoFocus
            data-testid="draftdb-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              setRenaming(false);
              const n = nameDraft.trim();
              if (n && n !== db.name) void guarded(() => saveDb({ name: n }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                setNameDraft(db.name);
                setRenaming(false);
              }
            }}
            style={{ ...fieldStyle(compact), flex: 1, fontWeight: 600 }}
          />
        ) : (
          <button
            type="button"
            data-testid="draftdb-name"
            title="Click to rename"
            onClick={() => {
              setNameDraft(db.name);
              setRenaming(true);
            }}
            style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", color: colors.fg0, fontFamily: MONO, fontSize: rem(14), fontWeight: 600, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minHeight: compact ? 36 : undefined }}
          >
            {db.name}
          </button>
        )}
        <ShareControl kind="database" targetId={db.id} viewId={activeView.id} compact={compact} />
        <span style={{ fontSize: rem(11.5), color: colors.fg2, whiteSpace: "nowrap" }}>
          {db.project_group} · {db.row_count.toLocaleString()} {db.row_count === 1 ? "row" : "rows"}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", overflowX: "auto", flexShrink: 0, borderBottom: `1px solid ${colors.lineSoft}` }}>
        {db.views.map((v) => {
          const on = v.id === activeView.id;
          return (
            <button
              key={v.id}
              type="button"
              data-testid={`draftdb-view-tab-${v.id}`}
              onClick={(e) => {
                if (on) setTabMenu({ id: v.id, anchor: e.currentTarget });
                else setViewId(v.id);
              }}
              style={{ ...smallBtn({ compact, active: on }), borderRadius: 999 }}
            >
              {v.name}
            </button>
          );
        })}
        <button type="button" data-testid="draftdb-add-view" aria-label="Add view" onClick={(e) => setAddAnchor(e.currentTarget)} style={smallBtn({ compact })}>
          <Plus size={13} />
        </button>
      </div>

      {error && (
        <div role="alert" data-testid="draftdb-view-error" style={{ padding: "6px 12px", background: colorAlpha.dangerSoft, fontSize: rem(12) }}>
          {error}
        </div>
      )}

      {activeView.type === "board" ? (
        <DatabaseBoard
          key={activeView.id}
          db={db}
          view={activeView}
          compact={compact}
          active={rowId === null}
          onViewChange={onViewChange}
          onSchemaChange={saveDb}
          onRefreshDb={refreshDbQuiet}
          onOpenRow={setRowId}
        />
      ) : (
        <DatabaseTable
          key={activeView.id}
          db={db}
          view={activeView}
          compact={compact}
          active={rowId === null}
          onViewChange={onViewChange}
          onSchemaChange={async (patch) => {
            await saveDb(patch);
          }}
          onRefreshDb={refreshDbQuiet}
          onOpenRow={setRowId}
        />
      )}

      {rowId && (
        <div style={{ position: "absolute", inset: 0, zIndex: 10, background: colors.bg1, display: "flex", flexDirection: "column" }}>
          <RowPage
            db={db}
            rowId={rowId}
            compact={compact}
            onBack={() => setRowId(null)}
            onDbChanged={() => {
              void refreshDb();
              onChanged();
            }}
          />
        </div>
      )}

      {addAnchor && (
        <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} width={220} testId="draftdb-add-view-menu">
          {(["table", "board"] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`draftdb-add-view-${t}`}
              onClick={() => {
                setAddAnchor(null);
                void addView(t);
              }}
              style={{ display: "flex", width: "100%", minHeight: compact ? 40 : 28, alignItems: "center", padding: "0 8px", border: "none", borderRadius: 4, background: "transparent", color: colors.fg0, fontFamily: MONO, fontSize: rem(12.5), textAlign: "left", cursor: "pointer" }}
            >
              {t === "table" ? "table view" : "board view"}
            </button>
          ))}
        </Popover>
      )}

      {tabMenu && tabMenuView && (
        <ViewTabMenu
          name={tabMenuView.name}
          canDelete={db.views.length > 1}
          anchor={tabMenu.anchor}
          compact={compact}
          onClose={() => setTabMenu(null)}
          onRename={(n) => void renameView(tabMenuView.id, n)}
          onDelete={() => void deleteView(tabMenuView.id)}
        />
      )}
    </div>
  );
}

function ViewTabMenu({
  name,
  canDelete,
  anchor,
  compact,
  onClose,
  onRename,
  onDelete,
}: {
  name: string;
  canDelete: boolean;
  anchor: HTMLElement;
  compact: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const [confirm, setConfirm] = useState(false);
  const rename = () => {
    const n = draft.trim();
    if (n && n !== name) onRename(n);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={240} testId="draftdb-view-menu">
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          autoFocus
          value={draft}
          aria-label="View name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
          }}
          style={{ ...fieldStyle(compact), flex: 1 }}
        />
        <button type="button" onClick={rename} style={smallBtn({ compact })}>
          rename
        </button>
      </div>
      {canDelete ? (
        confirm ? (
          <button
            type="button"
            data-testid="draftdb-view-delete-confirm"
            onClick={() => {
              onDelete();
              onClose();
            }}
            style={smallBtn({ compact, danger: true })}
          >
            confirm delete view
          </button>
        ) : (
          <button type="button" data-testid="draftdb-view-delete" onClick={() => setConfirm(true)} style={smallBtn({ compact, danger: true })}>
            delete view
          </button>
        )
      ) : (
        <div style={{ color: colors.fg2, fontSize: rem(11.5), padding: 2 }}>The last view cannot be deleted.</div>
      )}
    </Popover>
  );
}
