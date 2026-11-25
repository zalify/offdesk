// Per-column paged cards for a board view. Counts come from rows/groups, cards
// from one rows/query per column (30 at a time, more as the column scrolls).
// reload() swaps counts and the already-loaded cards of every column in one go.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { groupDraftDbRows, queryDraftDbRows } from "@/lib/api";
import type { DraftDbColumn, DraftDbRow, DraftDbValue, DraftDbView } from "@/lib/api";
import {
  applyBoardMove,
  boardColumnQuery,
  boardColumns,
  boardGroupsBody,
  findInBoard,
  hubErrorMessage,
  queryKey,
  reloadChunks,
} from "@/lib/draftDatabases";
import type { BoardColumn, BoardState, GroupCount } from "@/lib/draftDatabases";

interface Loaded {
  key: string;
  groups: GroupCount[] | null;
  state: BoardState;
}

const EMPTY: BoardState = { counts: {}, rows: {} };

export function useBoardCards(
  dbId: string,
  view: Pick<DraftDbView, "filters" | "sorts">,
  search: string,
  groupColumn: DraftDbColumn | null,
) {
  const groupId = groupColumn?.id ?? null;
  const optionsSig = JSON.stringify((groupColumn?.options ?? []).map((o) => o.name));
  const key = `${dbId}|${groupId}|${groupColumn?.type}|${queryKey(view, search)}`;
  const [loaded, setLoaded] = useState<Loaded>({ key, groups: null, state: EMPTY });
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});

  const viewRef = useRef(view);
  viewRef.current = view;
  const searchRef = useRef(search);
  searchRef.current = search;
  const colRef = useRef(groupColumn);
  colRef.current = groupColumn;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const genRef = useRef(0);
  const moreInflight = useRef(new Set<string>());

  const fresh = loaded.key === key;
  const groups = fresh ? loaded.groups : null;
  const state = fresh ? loaded.state : EMPTY;

  const columns: BoardColumn[] = useMemo(
    () => (groupColumn && groups ? boardColumns(groupColumn, groups) : []),
    // optionsSig stands in for groupColumn.options identity
    [groupColumn?.id, groupColumn?.type, optionsSig, groups],
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  /** Fetches counts plus the first `loaded` rows of every column. */
  const fetchAll = useCallback(
    async (prior: BoardState): Promise<{ groups: GroupCount[]; state: BoardState } | null> => {
      const col = colRef.current;
      if (!col) return null;
      const res = await groupDraftDbRows(dbId, boardGroupsBody(viewRef.current, searchRef.current, col.id));
      const cols = boardColumns(col, res.groups);
      const counts: Record<string, number> = {};
      const rows: Record<string, DraftDbRow[]> = {};
      await Promise.all(
        cols.map(async (c) => {
          counts[c.key] = c.count;
          if (c.count === 0) {
            rows[c.key] = [];
            return;
          }
          const parts = await Promise.all(
            reloadChunks(prior.rows[c.key]?.length ?? 0).map((chunk) =>
              queryDraftDbRows(dbId, boardColumnQuery(viewRef.current, searchRef.current, col.id, c, chunk)),
            ),
          );
          rows[c.key] = parts.flatMap((p) => p.rows);
        }),
      );
      return { groups: res.groups, state: { counts, rows } };
    },
    [dbId],
  );

  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    moreInflight.current.clear();
    setLoaded({ key, groups: null, state: EMPTY });
    setLoadingMore({});
    setError(null);
    if (!colRef.current) return;
    fetchAll(EMPTY)
      .then((res) => {
        if (gen !== genRef.current || !res) return;
        setLoaded({ key, groups: res.groups, state: res.state });
      })
      .catch((err) => {
        if (gen === genRef.current) setError(hubErrorMessage(err));
      });
  }, [key, fetchAll]);

  const reload = useCallback(async () => {
    if (!colRef.current) return;
    genRef.current += 1;
    const gen = genRef.current;
    moreInflight.current.clear();
    const keyNow = loadedRef.current.key;
    try {
      const res = await fetchAll(loadedRef.current.state);
      if (gen !== genRef.current || !res) return;
      setError(null);
      setLoadingMore({});
      setLoaded({ key: keyNow, groups: res.groups, state: res.state });
    } catch (err) {
      if (gen === genRef.current) setError(hubErrorMessage(err));
    }
  }, [fetchAll]);

  const loadMore = useCallback(
    async (colKey: string) => {
      const col = colRef.current;
      const column = columnsRef.current.find((c) => c.key === colKey);
      const cur = loadedRef.current;
      if (!col || !column || moreInflight.current.has(colKey)) return;
      const have = cur.state.rows[colKey]?.length ?? 0;
      if (have >= (cur.state.counts[colKey] ?? 0)) return;
      moreInflight.current.add(colKey);
      const gen = genRef.current;
      setLoadingMore((m) => ({ ...m, [colKey]: true }));
      try {
        const res = await queryDraftDbRows(
          dbId,
          boardColumnQuery(viewRef.current, searchRef.current, col.id, column, { offset: have }),
        );
        if (gen !== genRef.current) return;
        setLoaded((s) => {
          const existing = s.state.rows[colKey] ?? [];
          const seen = new Set(existing.map((r) => r.id));
          const rows = [...existing, ...res.rows.filter((r) => !seen.has(r.id))];
          return { ...s, state: { ...s.state, rows: { ...s.state.rows, [colKey]: rows } } };
        });
      } catch (err) {
        if (gen === genRef.current) setError(hubErrorMessage(err));
      } finally {
        moreInflight.current.delete(colKey);
        if (gen === genRef.current) setLoadingMore((m) => ({ ...m, [colKey]: false }));
      }
    },
    [dbId],
  );

  /**
   * Optimistic move. Returns an undo that puts the card back where it was,
   * or null when the card is not loaded (nothing to move).
   */
  const moveCard = useCallback(
    (rowId: string, toKey: string, toValue: DraftDbValue): (() => void) | null => {
      const col = colRef.current;
      const cur = loadedRef.current.state;
      const from = findInBoard(cur, rowId);
      if (!col || !from || from.key === toKey) return null;
      const original: DraftDbValue = from.row.properties[col.id] ?? null;
      setLoaded((s) => ({
        ...s,
        state: applyBoardMove(s.state, rowId, from.key, toKey, col.id, toValue),
      }));
      return () =>
        setLoaded((s) => ({
          ...s,
          state: applyBoardMove(s.state, rowId, toKey, from.key, col.id, original, from.index),
        }));
    },
    [],
  );

  const patchRow = useCallback((rowId: string, fn: (r: DraftDbRow) => DraftDbRow) => {
    setLoaded((s) => {
      const hit = findInBoard(s.state, rowId);
      if (!hit) return s;
      const rows = s.state.rows[hit.key].slice();
      rows[hit.index] = fn(hit.row);
      return { ...s, state: { ...s.state, rows: { ...s.state.rows, [hit.key]: rows } } };
    });
  }, []);

  return {
    ready: fresh && groups !== null,
    columns,
    state,
    error,
    loadingMore,
    loadMore,
    reload,
    moveCard,
    patchRow,
  };
}
