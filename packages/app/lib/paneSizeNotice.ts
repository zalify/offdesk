// "Sized by another device": the focused desktop pane's terminal has the
// size another client gave it. TerminalCard publishes it here; the status
// line shows it with the action that fits it to this window.

export interface PaneSizeNotice {
  terminalId: string;
  cols: number;
  rows: number;
  isController: boolean;
  canFit: boolean;
  fit: () => void;
}

type Listener = (notice: PaneSizeNotice | null) => void;
const listeners = new Set<Listener>();
let current: PaneSizeNotice | null = null;

export function publishPaneSizeNotice(notice: PaneSizeNotice | null): void {
  current = notice;
  for (const listener of listeners) listener(notice);
}

/** Clears only if the terminal still owns the notice. */
export function clearPaneSizeNotice(terminalId: string): void {
  if (current?.terminalId === terminalId) publishPaneSizeNotice(null);
}

export function subscribePaneSizeNotice(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}
