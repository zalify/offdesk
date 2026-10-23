// The desktop sessions list (WorkspaceManager as a pinned sidebar): every
// terminal of the machine as one row, in the tabs' order or by when each last
// had output. Pure so the ordering is testable without React.

import { useEffect, useState } from "react";
import type { TerminalInfo } from "@offdesk/shared";

import { collectPaneTerminalIds, type WorkspaceGroup } from "./terminalWorkspaceLayout";

export type SessionOrder = "recent" | "tabs";

export interface SessionRow {
  terminal: TerminalInfo;
  group: WorkspaceGroup;
}

/** Narrowest window that keeps the sidebar pinned; below it ≡ opens a drawer. */
export const SESSIONS_SIDEBAR_MIN_WIDTH = 1024;

/**
 * One row per terminal. "tabs" keeps the tab order and each tab's pane order;
 * "recent" puts the terminal with the latest output first, and the ones whose
 * node hasn't reported activity after them, still in tab order.
 */
export function sessionRows(
  groups: WorkspaceGroup[],
  terminalsById: Map<string, TerminalInfo>,
  order: SessionOrder,
): SessionRow[] {
  const rows = groups.flatMap((group) =>
    collectPaneTerminalIds(group.root).flatMap((terminalId) => {
      const terminal = terminalsById.get(terminalId);
      return terminal ? [{ terminal, group }] : [];
    }),
  );
  if (order === "tabs") return rows;
  const at = (row: SessionRow) => row.terminal.last_activity_ms ?? -Infinity;
  // Array.prototype.sort is stable, so ties keep the tab order.
  return [...rows].sort((a, b) => at(b) - at(a));
}

/** How long ago a terminal had output: "now", "5m", "3h", "2d". */
export function activityAge(atMs: number | null | undefined, nowMs: number): string | null {
  if (atMs == null) return null;
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const SIDEBAR_KEY = "offdesk:sessions-sidebar";
const ORDER_KEY = "offdesk:sessions-order";

/** Whether this device keeps the sidebar shown; shown unless hidden here. */
export function readSidebarShown(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "hidden";
  } catch {
    return true;
  }
}

export function writeSidebarShown(shown: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, shown ? "shown" : "hidden");
  } catch {
    // Private mode or blocked storage: the choice lasts this page only.
  }
}

/** Whether the window is wide enough to pin the sidebar beside the panes. */
export function useSidebarFits(): boolean {
  const query = `(min-width: ${SESSIONS_SIDEBAR_MIN_WIDTH}px)`;
  const [fits, setFits] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setFits(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return fits;
}

export function readSessionOrder(): SessionOrder {
  try {
    return localStorage.getItem(ORDER_KEY) === "tabs" ? "tabs" : "recent";
  } catch {
    return "recent";
  }
}

export function writeSessionOrder(order: SessionOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    // As above.
  }
}
