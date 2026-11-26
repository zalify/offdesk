// Database list for the drawer: loads on open, re-polls, and reports whether
// the hub supports draft databases at all (404 -> available === false).
import { useCallback, useEffect, useState } from "react";

import { listDraftDatabases } from "@/lib/api";
import type { DraftDatabase } from "@/lib/api";
import { hubErrorMessage } from "@/lib/draftDatabases";

const POLL_MS = 30_000;

export function useDraftDatabases(
  open: boolean,
  project: string | undefined,
  spaceId?: string | null,
) {
  const [databases, setDatabases] = useState<DraftDatabase[]>([]);
  /** null until the first answer; false when the hub answered 404. */
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listDraftDatabases(project, spaceId);
      if (list === null) {
        setAvailable(false);
        setDatabases([]);
      } else {
        setAvailable(true);
        setDatabases(list);
      }
      setError(null);
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [project, spaceId]);

  useEffect(() => {
    if (!open || available === false) return;
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [open, available, refresh]);

  return { databases, available, loading, error, refresh };
}
