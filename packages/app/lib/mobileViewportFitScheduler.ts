interface Size { width: number; height: number }

/** Fit when the terminal's own viewport changes, not just on window resize:
 * fixed chrome and the keyboard can land in separate layout passes. The fit
 * runs on the next frame (changes within one frame make one fit). Waiting
 * any longer leaves the old grid on screen — clipped below the keyboard as
 * it opens, half blank as it closes — for the whole wait. */
export function createMobileViewportFitScheduler<Timer, SettleTimer = Timer>(options: {
  canFit: () => boolean;
  fit: () => void;
  /** Runs callback on the next frame (requestAnimationFrame). */
  schedule: (callback: () => void) => Timer;
  cancel: (timer: Timer) => void;
  /** Optional adaptive settle debounce for rapid multi-frame bursts (e.g.
   * animated soft keyboard open/close). A single discrete resize still runs on
   * the next animation frame; consecutive changes within `burstWindowMs`
   * coalesce behind `settleDebounceMs`. */
  settleDebounceMs?: number;
  burstWindowMs?: number;
  now?: () => number;
  scheduleSettle?: (callback: () => void, delayMs: number) => SettleTimer;
  cancelSettle?: (timer: SettleTimer) => void;
}) {
  let previous: Size | null = null;
  let timer: Timer | null = null;
  let settleTimer: SettleTimer | null = null;
  let lastChangeAt: number | null = null;
  let disposed = false;
  const settleDebounceMs = options.settleDebounceMs ?? 0;
  const burstWindowMs = options.burstWindowMs ?? 60;
  const readNow =
    options.now ??
    (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const clear = () => {
    if (timer !== null) options.cancel(timer);
    timer = null;
    if (settleTimer !== null && options.cancelSettle) {
      options.cancelSettle(settleTimer);
    }
    settleTimer = null;
  };
  return {
    observe(size: Size) {
      if (disposed) return;
      if (size.width <= 0 || size.height <= 0) {
        clear();
        previous = null;
        lastChangeAt = null;
        return;
      }
      const changed = previous !== null && (previous.width !== size.width || previous.height !== size.height);
      previous = { ...size };
      if (!changed) return;
      clear();
      // Initial mounting, viewers, desktop windows and inactive panes must
      // retain the server's dimensions. Recheck the lease when the timer fires.
      if (!options.canFit()) return;
      const now = readNow();
      const inBurst =
        settleDebounceMs > 0 &&
        Boolean(options.scheduleSettle && options.cancelSettle) &&
        lastChangeAt !== null &&
        now - lastChangeAt <= burstWindowMs;
      lastChangeAt = now;
      if (inBurst && options.scheduleSettle) {
        settleTimer = options.scheduleSettle(() => {
          settleTimer = null;
          if (!disposed && options.canFit()) options.fit();
        }, settleDebounceMs);
        return;
      }
      if (settleDebounceMs > 0 && options.scheduleSettle && options.cancelSettle) {
        // Wait one extra animation frame before firing so an animated soft
        // keyboard (which emits consecutive ResizeObserver frames ~16ms apart)
        // enters the burst settle path instead of firing a mid-animation resize
        // on frame 1. A single discrete resize still lands within 2 frames.
        timer = options.schedule(() => {
          timer = options.schedule(() => {
            timer = null;
            if (!disposed && options.canFit()) options.fit();
          });
        });
        return;
      }
      timer = options.schedule(() => {
        timer = null;
        if (!disposed && options.canFit()) options.fit();
      });
    },
    dispose() { disposed = true; clear(); },
  };
}
