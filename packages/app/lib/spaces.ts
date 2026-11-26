import type { TerminalInfo } from "@offdesk/shared";

import { groupWaitingCount } from "./sessionList";
import type { WorkspaceGroup } from "./terminalWorkspaceLayout";

export const ACTIVE_SPACE_STORAGE_KEY = "offdesk:active-space";

export const SPACE_COLOR_PRESETS = [
  "#22d3ee", // cyan
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#94a3b8", // slate
] as const;

export const SPACE_ICON_PRESETS = [
  "",
  "🚀",
  "💼",
  "🧪",
  "🛠️",
  "📦",
  "🌐",
  "📱",
  "⚡",
] as const;

export const DEFAULT_SPACE_COLOR = SPACE_COLOR_PRESETS[0];

export function readActiveSpaceId(): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function writeActiveSpaceId(spaceId: string | null): void {
  try {
    if (spaceId) {
      window.localStorage.setItem(ACTIVE_SPACE_STORAGE_KEY, spaceId);
    } else {
      window.localStorage.removeItem(ACTIVE_SPACE_STORAGE_KEY);
    }
  } catch {
    // Private mode or blocked storage: selection lasts this session only.
  }
}

export function filterGroupsBySpace(
  groups: WorkspaceGroup[],
  activeSpaceId: string | null | undefined,
): WorkspaceGroup[] {
  if (!activeSpaceId) return groups;
  return groups.filter((group) => group.spaceId === activeSpaceId);
}

export interface SpaceWaitingCounts {
  total: number;
  bySpace: Map<string | null, number>;
}

export function countWaitingBySpace(
  groups: WorkspaceGroup[],
  terminalsById: Map<string, TerminalInfo>,
): SpaceWaitingCounts {
  const bySpace = new Map<string | null, number>();
  let total = 0;
  for (const group of groups) {
    const count = groupWaitingCount(group, terminalsById);
    if (count <= 0) continue;
    total += count;
    const key = group.spaceId ?? null;
    bySpace.set(key, (bySpace.get(key) ?? 0) + count);
  }
  return { total, bySpace };
}
