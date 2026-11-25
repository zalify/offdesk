// A read-only, height-capped window onto one database view, embedded in a
// markdown draft with a ```database fence. It reuses the paged data hooks of
// the real table and board; an unknown database or view, or a hub without the
// feature, shows one quiet line instead of anything that could throw.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { getDraftDatabase, listDraftDatabases } from "@/lib/api";
import type { DraftDatabase, DraftDbColumn, DraftDbView } from "@/lib/api";
import {
  boardGroupColumn,
  hubErrorMessage,
  resolveDatabaseRef,
  resolveViewRef,
  rowAt,
  visibleColumns,
  visibleRowWindow,
} from "@/lib/draftDatabases";
import type { RowWindow } from "@/lib/draftDatabases";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { BoardView } from "./BoardView.web";
import { OptionChip, optionColor } from "./chips.web";
import { MONO, smallBtn } from "./ui.web";
import { useBoardCards } from "./useBoardCards";
import { useDatabaseRows } from "./useDatabaseRows";
import { useRefreshPoll } from "./usePoll";

const EMBED_HEIGHT = 360;
const EMBED_REFRESH_MS = 10_000;
const ROW_H = 28;
const TITLE_W = 220;
const COL_W = 150;

type Resolved =
  | { status: "loading" }
  | { status: "note"; message: string }
  | { status: "ready"; db: DraftDatabase; view: DraftDbView };

export function DatabaseEmbed({
  database,
  view,
  projectGroup,
  onOpenDatabase,
}: {
  database: string;
  view?: string;
  projectGroup?: string;
  onOpenDatabase?: (databaseId: string, viewId?: string) => void;
}) {
  const [resolved, setResolved] = useState<Resolved>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const run = async (quiet: boolean) => {
      try {
        const list = await listDraftDatabases();
        if (cancelled) return;
        if (list === null) {
          setResolved({ status: "note", message: "Databases are not available on this hub." });
          return;
        }
        const found = resolveDatabaseRef(list, database, projectGroup);
        if (!found) {
          setResolved({ status: "note", message: `Database "${database}" was not found.` });
          return;
        }
        // The list carries columns and views already; fetch only if a hub trims them.
        const full = found.views?.length ? found : await getDraftDatabase(found.id);
        if (cancelled) return;
        const v = resolveViewRef(full.views, view);
        if (!v) {
          setResolved({ status: "note", message: `View "${view}" was not found in "${full.name}".` });
          return;
        }
        setResolved({ status: "ready", db: full, view: v });
      } catch (err) {
        if (!cancelled && !quiet) setResolved({ status: "note", message: `Could not load "${database}": ${hubErrorMessage(err)}` });
      }
    };
    void run(false);
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void run(true);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [database, view, projectGroup]);

  const frame: React.CSSProperties = {
    margin: "8px 0",
    border: `1px solid ${colors.lineSoft}`,
    borderRadius: 6,
    background: colors.bg1,
    fontFamily: MONO,
    overflow: "hidden",
  };

  if (resolved.status !== "ready") {
    return (
      <div data-testid="draft-artifact-database" data-state={resolved.status} style={{ ...frame, padding: "8px 10px", fontSize: rem(12), color: colors.fg2 }}>
        {resolved.status === "loading" ? "Loading database…" : resolved.message}
      </div>
    );
  }

  const { db, view: activeView } = resolved;
  return (
    <div data-testid="draft-artifact-database" data-state="ready" style={frame}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: `1px solid ${colors.lineSoft}`, background: colors.bg2 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: rem(12.5), fontWeight: 600, color: colors.fg0 }}>
          {db.name}
          <span style={{ fontWeight: 400, color: colors.fg2 }}> · {activeView.name}</span>
        </span>
        {onOpenDatabase && (
          <button
            type="button"
            data-testid="draft-artifact-database-open"
            onClick={() => onOpenDatabase(db.id, activeView.id)}
            style={smallBtn({ compact: false })}
          >
            <ExternalLink size={12} />
            open
          </button>
        )}
      </div>
      <div style={{ height: EMBED_HEIGHT, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {activeView.type === "board" ? (
          <EmbedBoard db={db} view={activeView} />
        ) : (
          <EmbedTable db={db} view={activeView} />
        )}
      </div>
    </div>
  );
}

function EmbedBoard({ db, view }: { db: DraftDatabase; view: DraftDbView }) {
  const groupColumn = boardGroupColumn(db.columns, view);
  const cards = useBoardCards(db.id, view, "", groupColumn);
  const { reload } = cards;
  useRefreshPoll(true, () => void reload(), EMBED_REFRESH_MS);
  if (!groupColumn) {
    return <Note>This board has no select or checkbox column to group by.</Note>;
  }
  if (cards.error && !cards.ready) return <Note>{cards.error}</Note>;
  if (!cards.ready) return <Note>Loading board…</Note>;
  return (
    <BoardView
      db={db}
      view={view}
      groupColumn={groupColumn}
      columns={cards.columns}
      state={cards.state}
      loadingMore={cards.loadingMore}
      compact={false}
      readOnly
      onLoadMore={(k) => void cards.loadMore(k)}
    />
  );
}

function EmbedTable({ db, view }: { db: DraftDatabase; view: DraftDbView }) {
  const rows = useDatabaseRows(db.id, view, "");
  const columns = useMemo(() => visibleColumns(db.columns, view), [db.columns, view]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<RowWindow>({ first: 0, last: -1 });
  const total = rows.total;
  const totalWidth = TITLE_W + columns.length * COL_W;

  const recompute = () => {
    const el = scrollerRef.current;
    if (!el || total === null) return;
    const next = visibleRowWindow(el.scrollTop, el.clientHeight || EMBED_HEIGHT, ROW_H, total);
    setWin((w) => (w.first === next.first && w.last === next.last ? w : next));
  };
  useLayoutEffect(recompute, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  const { ensureWindow, reload } = rows;
  useEffect(() => {
    ensureWindow(win);
  }, [win, rows.total, rows.pages, ensureWindow]);
  useRefreshPoll(true, () => void reload(), EMBED_REFRESH_MS);

  const idxs: number[] = [];
  for (let i = win.first; i <= win.last; i++) idxs.push(i);
  const border = `1px solid ${colors.lineSoft}`;

  return (
    <div ref={scrollerRef} onScroll={recompute} style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}>
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 2, display: "flex", height: ROW_H, width: totalWidth, background: colors.bg2, borderBottom: `1px solid ${colors.line}`, fontSize: rem(11.5), color: colors.fg2 }}>
          <div style={{ width: TITLE_W, flexShrink: 0, padding: "0 8px", display: "flex", alignItems: "center", borderRight: border }}>Title</div>
          {columns.map((c) => (
            <div key={c.id} style={{ width: COL_W, flexShrink: 0, padding: "0 8px", display: "flex", alignItems: "center", borderRight: border, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {c.name}
            </div>
          ))}
        </div>
        <div style={{ position: "relative", height: (total ?? 0) * ROW_H, width: totalWidth }}>
          {idxs.map((i) => {
            const row = rowAt(rows.pages, i);
            const top = i * ROW_H;
            if (!row) return <div key={`s${i}`} aria-hidden style={{ position: "absolute", top, height: ROW_H, width: totalWidth, borderBottom: border }} />;
            return (
              <div key={row.id} data-testid={`draft-artifact-database-row-${row.id}`} style={{ position: "absolute", top, left: 0, height: ROW_H, width: totalWidth, display: "flex", borderBottom: border, fontSize: rem(12.5), color: colors.fg0 }}>
                <Cell width={TITLE_W}>{row.title || "(untitled)"}</Cell>
                {columns.map((c) => (
                  <Cell key={c.id} width={COL_W}>
                    <Value column={c} value={row.properties[c.id]} />
                  </Cell>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {total === 0 && <Note>No rows.</Note>}
      {total === null && <Note>{rows.error ?? "Loading rows…"}</Note>}
    </div>
  );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div style={{ width, flexShrink: 0, padding: "0 8px", display: "flex", alignItems: "center", gap: 4, overflow: "hidden", whiteSpace: "nowrap", borderRight: `1px solid ${colors.lineSoft}` }}>
      {children}
    </div>
  );
}

function Value({ column, value }: { column: DraftDbColumn; value: unknown }) {
  if (value === undefined || value === null || value === "") return null;
  if (column.type === "checkbox") return <span>{value === true ? "✓" : ""}</span>;
  if (Array.isArray(value)) return <>{value.map((v) => <OptionChip key={String(v)} name={String(v)} color={optionColor(column, String(v))} />)}</>;
  if (column.type === "select") return <OptionChip name={String(value)} color={optionColor(column, String(value))} />;
  return <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{String(value)}</span>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "10px 12px", fontSize: rem(12), color: colors.fg2, fontFamily: MONO }}>{children}</div>;
}
