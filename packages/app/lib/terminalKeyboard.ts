export interface KeyboardViewport { width: number; height: number; scale: number }

/** Detect a docked keyboard closing without relying on focusout (IME dismissal
 * often leaves the editable focused). Small browser-chrome resizes and rotation
 * must not blur an input. Android also supplies actual IME visibility. */
export function createKeyboardViewportTracker(initial: KeyboardViewport) {
  let baseline = initial;
  let reduced = false;
  return (next: KeyboardViewport, editing: boolean): boolean => {
    if (Math.abs(next.width - baseline.width) > 40 || Math.abs(next.scale - baseline.scale) > 0.05) {
      baseline = next;
      reduced = false;
      return false;
    }
    if (!editing) {
      baseline = { ...next, height: Math.max(next.height, baseline.height) };
      reduced = false;
      return false;
    }
    if (baseline.height - next.height >= 120) reduced = true;
    const dismissed = reduced && next.height >= baseline.height - 40;
    if (dismissed) reduced = false;
    if (next.height > baseline.height) baseline = next;
    return dismissed;
  };
}
