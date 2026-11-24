// In-memory LRU cache of the last painted terminal viewport per terminal ID.
// When a cold terminal mounts (outside the live keep-alive pool), TerminalView
// renders this snapshot immediately so the user sees the last known screen in
// 0ms while the WebSocket + tmux attach catches up in the background.

export interface TerminalScreenSnapshot {
  lines: string[];
  fontFamily: string;
  fontSize: number;
  capturedAt: number;
}

export interface SnapshotReadableBuffer {
  viewportY: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

export interface SnapshotReadableTerminal {
  rows: number;
  buffer: { active: SnapshotReadableBuffer };
  options: { fontFamily?: string; fontSize?: number };
}

const MAX_SNAPSHOTS = 64;
const snapshots = new Map<string, TerminalScreenSnapshot>();

export function captureTerminalSnapshot(
  terminalId: string,
  term: SnapshotReadableTerminal,
): TerminalScreenSnapshot | null {
  const active = term.buffer.active;
  const startY = Math.max(0, active.viewportY);
  const rawLines: string[] = [];
  for (let i = 0; i < term.rows; i += 1) {
    const line = active.getLine(startY + i);
    rawLines.push(line ? line.translateToString(true) : "");
  }
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  if (rawLines.length === 0) {
    return null;
  }

  const snapshot: TerminalScreenSnapshot = {
    lines: rawLines,
    fontFamily: term.options.fontFamily ?? "monospace",
    fontSize: term.options.fontSize ?? 14,
    capturedAt: Date.now(),
  };

  // Refresh LRU order.
  snapshots.delete(terminalId);
  snapshots.set(terminalId, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return snapshot;
}

export function getTerminalSnapshot(
  terminalId: string,
): TerminalScreenSnapshot | null {
  const existing = snapshots.get(terminalId);
  if (!existing) return null;
  // Touch LRU order.
  snapshots.delete(terminalId);
  snapshots.set(terminalId, existing);
  return existing;
}

export function clearTerminalSnapshot(terminalId: string): void {
  snapshots.delete(terminalId);
}

export function clearAllTerminalSnapshots(): void {
  snapshots.clear();
}
