interface Size { width: number; height: number }

/** Fit after the terminal's own viewport settles, not just window resize.
 * Fixed chrome and IME animations can finish in separate layout passes. */
export function createMobileViewportFitScheduler<Timer>(options: {
  canFit: () => boolean;
  fit: () => void;
  schedule: (callback: () => void, delay: number) => Timer;
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
      }, 150);
    },
    dispose() { disposed = true; clear(); },
  };
}
