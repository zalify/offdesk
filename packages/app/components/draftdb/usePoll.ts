// Shared 5 s refresh timer for a view: ticks only while the document is visible.
import { useEffect, useRef } from "react";

export const REFRESH_MS = 5000;

export function useRefreshPoll(active: boolean, tick: () => void, intervalMs = REFRESH_MS) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") tickRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}
