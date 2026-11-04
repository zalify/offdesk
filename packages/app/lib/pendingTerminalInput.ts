// Terminal input typed while the live socket can't take it: the socket is
// still connecting, or a reconnect is pending and the current socket is about
// to be replaced (it may be a dead socket that still reports OPEN after the
// app comes back from the background). The view sends what drain() returns
// on the next socket once it opens.

export const DEFAULT_PENDING_INPUT_MAX_CHARS = 64 * 1024;
export const DEFAULT_PENDING_INPUT_MAX_AGE_MS = 10_000;

export interface PendingTerminalInput {
  push: (data: string) => void;
  /** Everything queued, in order, and empties the queue. "" when the oldest
   * entry is older than the max age: stale keystrokes are not replayed. */
  drain: () => string;
  clear: () => void;
  readonly size: number;
  readonly isEmpty: boolean;
}

interface PendingTerminalInputOptions {
  now: () => number;
  /** Cap on queued input, counted in UTF-16 code units (string length). */
  maxChars?: number;
  maxAgeMs?: number;
}

export function createPendingTerminalInput({
  now,
  maxChars = DEFAULT_PENDING_INPUT_MAX_CHARS,
  maxAgeMs = DEFAULT_PENDING_INPUT_MAX_AGE_MS,
}: PendingTerminalInputOptions): PendingTerminalInput {
  let entries: string[] = [];
  let size = 0;
  let oldestAt = 0;
  // Once a push is refused, every later push is refused too until the queue
  // is emptied: replaying input with a hole in the middle would be worse
  // than replaying only the prefix.
  let full = false;

  const clear = () => {
    entries = [];
    size = 0;
    full = false;
  };

  return {
    push(data) {
      if (!data || full) return;
      if (size + data.length > maxChars) {
        full = true;
        return;
      }
      if (entries.length === 0) oldestAt = now();
      entries.push(data);
      size += data.length;
    },
    drain() {
      if (entries.length === 0) {
        clear();
        return "";
      }
      const stale = now() - oldestAt > maxAgeMs;
      const data = stale ? "" : entries.join("");
      clear();
      return data;
    },
    clear,
    get size() {
      return size;
    },
    get isEmpty() {
      return entries.length === 0;
    },
  };
}
