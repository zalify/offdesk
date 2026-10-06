// The "agent took control back" notice of an agent browser view. It shows only
// for a reclaim that happens while the view is mounted: `reclaimed` stays on the
// record until someone takes over, so one already there at mount is old news.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBrowserInfo } from "@offdesk/shared";

export const RECLAIM_NOTICE_MS = 20_000;

export interface ReclaimNotice {
  reason: string;
  /** This device is the one that lost control. */
  fromYou: boolean;
  dismiss: () => void;
}

export function reclaimNoticeText(reason: string, fromYou: boolean): string {
  return `The agent took control back${fromYou ? " from you" : ""}: ${reason}`;
}

export function useAgentBrowserReclaimNotice(
  browser: AgentBrowserInfo,
  deviceId: string | null,
  mine: boolean,
): ReclaimNotice | null {
  const [shown, setShown] = useState<{ reason: string; deviceId?: string } | null>(null);
  // The browser and reclaim time this view last saw; a different time is new.
  const seenRef = useRef<{ id: string; at: number | null }>({
    id: browser.id,
    at: browser.reclaimed?.at ?? null,
  });
  const reclaimed = browser.reclaimed;
  const at = reclaimed?.at ?? null;

  useEffect(() => {
    const seen = seenRef.current;
    if (seen.id !== browser.id) {
      seenRef.current = { id: browser.id, at };
      setShown(null);
      return;
    }
    if (seen.at === at) return;
    seen.at = at;
    if (reclaimed) {
      setShown({ reason: reclaimed.reason, deviceId: reclaimed.device_id });
    } else {
      setShown(null);
    }
  }, [browser.id, at, reclaimed]);

  // Taking control again ends the news.
  useEffect(() => {
    if (mine) setShown(null);
  }, [mine]);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), RECLAIM_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  const dismiss = useCallback(() => setShown(null), []);
  if (!shown) return null;
  return {
    reason: shown.reason,
    fromYou: deviceId !== null && shown.deviceId === deviceId,
    dismiss,
  };
}
