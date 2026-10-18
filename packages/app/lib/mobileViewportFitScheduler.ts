interface Size { width: number; height: number }

/** Fit when the terminal's own viewport changes, not just on window resize:
 * fixed chrome and the keyboard can land in separate layout passes. The fit
 * runs on the next frame (changes within one frame make one fit). Waiting
 * any longer leaves the old grid on screen — clipped below the keyboard as
 * it opens, half blank as it closes — for the whole wait. */
export function createMobileViewportFitScheduler<Timer>(options: {
  canFit: () => boolean;
  fit: () => void;
  /** Runs callback on the next frame (requestAnimationFrame). */
  schedule: (callback: () => void) => Timer;
  cancel: (timer: Timer) => void;
}) {
  let previous: Size | null = null;
  let timer: Timer | null = null;
  let disposed = false;
  const clear = () => {
    if (timer !== null) options.cancel(timer);
    timer = null;
  };
  return {
    observe(size: Size) {
      if (disposed) return;
      if (size.width <= 0 || size.height <= 0) { clear(); previous = null; return; }
      const changed = previous !== null && (previous.width !== size.width || previous.height !== size.height);
      previous = { ...size };
      if (!changed) return;
      clear();
      // Initial mounting, viewers, desktop windows and inactive panes must
      // retain the server's dimensions. Recheck the lease when the timer fires.
      if (!options.canFit()) return;
      timer = options.schedule(() => {
        timer = null;
        if (!disposed && options.canFit()) options.fit();
      });
    },
    dispose() { disposed = true; clear(); },
  };
}
