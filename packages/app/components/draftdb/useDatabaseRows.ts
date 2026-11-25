// Server-side paged row cache for one database view. Pages of PAGE_SIZE rows
// are fetched on demand; a query change drops the cache, and reload() swaps
// the pages around the visible window in one go so rows never flash blank.
import { useCallback, useEffect, useRef, useState } from "react";

import { queryDraftDbRows } from "@/lib/api";
import type { DraftDbRow, DraftDbView } from "@/lib/api";
import {
  PAGE_SIZE,
  buildQueryBody,
  findRow,
  hubErrorMessage,
  mapRowInPages,
  missingPages,
  pagesForWindow,
  prunePages,
  queryKey,
} from "@/lib/draftDatabases";
import type { PageMap, RowWindow } from "@/lib/draftDatabases";

interface RowsState {
  key: string;
  total: number | null;
  pages: PageMap;
}

export function useDatabaseRows(
  dbId: string,
  view: Pick<DraftDbView, "filters" | "sorts">,
  search: string,
) {
  const key = `${dbId}|${queryKey(view, search)}`;
  const [state, setState] = useState<RowsState>({ key, total: null, pages: new Map() });
  const [error, setError] = useState<string | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const searchRef = useRef(search);
  searchRef.current = search;
  const stateRef = useRef(state);
  stateRef.current = state;
  const genRef = useRef(0);
  const inflight = useRef(new Set<number>());
  const winRef = useRef<RowWindow>({ first: 0, last: -1 });

  const fetchPage = useCallback(
    (page: number) =>
      queryDraftDbRows(dbId, buildQueryBody(viewRef.current, searchRef.current, { offset: page * PAGE_SIZE })),
    [dbId],
  );

  const ensureWindow = useCallback(
    (win: RowWindow) => {
      winRef.current = win;
      const effective = stateRef.current.total === null ? { first: 0, last: 0 } : win;
      const gen = genRef.current;
      for (const page of missingPages(effective, stateRef.current.pages, inflight.current)) {
        inflight.current.add(page);
        fetchPage(page)
          .then((res) => {
            if (gen !== genRef.current) return;
            setError(null);
            setState((s) => {
              const pages = new Map(s.pages);
              pages.set(page, res.rows);
              return { ...s, total: res.total, pages: prunePages(pages, winRef.current) };
            });
          })
          .catch((err) => {
            if (gen === genRef.current) setError(hubErrorMessage(err));
          })
          .finally(() => {
            if (gen === genRef.current) inflight.current.delete(page);
          });
      }
    },
    [fetchPage],
  );

  // A different database, filter, sort or search: everything cached is wrong.
  useEffect(() => {
    genRef.current += 1;
    inflight.current.clear();
    setState({ key, total: null, pages: new Map() });
    setError(null);
    // ensureWindow reads stateRef, which is updated on the next render, so
    // fetch page 0 directly to learn `total`.
    const gen = genRef.current;
    inflight.current.add(0);
    fetchPage(0)
      .then((res) => {
        if (gen !== genRef.current) return;
        setState({ key, total: res.total, pages: new Map([[0, res.rows]]) });
      })
      .catch((err) => {
        if (gen === genRef.current) setError(hubErrorMessage(err));
      })
      .finally(() => {
        if (gen === genRef.current) inflight.current.delete(0);
      });
  }, [key, fetchPage]);

  /** Re-fetch the pages around the visible window and swap them in atomically. */
  const reload = useCallback(async () => {
    genRef.current += 1;
    inflight.current.clear();
    const gen = genRef.current;
    const win = winRef.current;
    const pageNos = win.last < win.first ? [0] : pagesForWindow(win);
    try {
      const results = await Promise.all(pageNos.map((p) => fetchPage(p)));
      if (gen !== genRef.current) return;
      const pages: PageMap = new Map();
      results.forEach((res, i) => pages.set(pageNos[i], res.rows));
      setError(null);
      setState((s) => ({ ...s, total: results[0]?.total ?? s.total, pages }));
    } catch (err) {
      if (gen === genRef.current) setError(hubErrorMessage(err));
    }
  }, [fetchPage]);

  const patchRow = useCallback((rowId: string, fn: (r: DraftDbRow) => DraftDbRow): DraftDbRow | null => {
    const snapshot = findRow(stateRef.current.pages, rowId);
    setState((s) => ({ ...s, pages: mapRowInPages(s.pages, rowId, fn) }));
    return snapshot;
  }, []);

  const loaded = useCallback((): DraftDbRow[] => {
    const out: DraftDbRow[] = [];
    for (const rows of stateRef.current.pages.values()) out.push(...rows);
    return out;
  }, []);

  return {
    total: state.key === key ? state.total : null,
    pages: state.key === key ? state.pages : (new Map() as PageMap),
    error,
    ensureWindow,
    reload,
    patchRow,
    loaded,
  };
}
