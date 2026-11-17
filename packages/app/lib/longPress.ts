import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Hold duration before a press becomes a long-press. Matches common
// Android/iOS context-menu timing closely enough that the gesture feels
// native without competing with a tap.
export const LONG_PRESS_DELAY_MS = 500;
// Pointer may wander this far from the down point without cancelling.
// 10px is inside a finger's typical jitter but below a scroll/drag start.
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressPoint {
  x: number;
  y: number;
}

export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface LongPressTracker {
  pointerDown(event: PointerLike): void;
  pointerMove(event: PointerLike): void;
  pointerUp(event: PointerLike): void;
  pointerCancel(event: PointerLike): void;
  dispose(): void;
}

export function createLongPressTracker(options: {
  onLongPress: (point: LongPressPoint) => void;
  delayMs?: number;
  slopPx?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
}): LongPressTracker {
  const delayMs = options.delayMs ?? LONG_PRESS_DELAY_MS;
  const slopPx = options.slopPx ?? LONG_PRESS_SLOP_PX;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((id) => window.clearTimeout(id));

  let timerId: number | null = null;
  let pointerId: number | null = null;
  let originX = 0;
  let originY = 0;

  const clearTimer = () => {
    if (timerId === null) return;
    clearTimeoutFn(timerId);
    timerId = null;
  };

  const reset = () => {
    clearTimer();
    pointerId = null;
  };

  return {
    pointerDown(event) {
      reset();
      pointerId = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      timerId = setTimeoutFn(() => {
        timerId = null;
        const id = pointerId;
        const x = originX;
        const y = originY;
        pointerId = null;
        if (id === null) return;
        options.onLongPress({ x, y });
      }, delayMs);
    },
    pointerMove(event) {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      if (Math.hypot(dx, dy) > slopPx) reset();
    },
    pointerUp(event) {
      if (event.pointerId !== pointerId) return;
      reset();
    },
    pointerCancel(event) {
      if (event.pointerId !== pointerId) return;
      reset();
    },
    dispose() {
      reset();
    },
  };
}

export function useLongPress(
  onLongPress: (point: LongPressPoint) => void,
  enabled: boolean,
  options?: { delayMs?: number; slopPx?: number },
): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const trackerRef = useRef<LongPressTracker | null>(null);
  const delayMs = options?.delayMs;
  const slopPx = options?.slopPx;

  useEffect(() => {
    if (!enabled) {
      trackerRef.current?.dispose();
      trackerRef.current = null;
      return;
    }
    const tracker = createLongPressTracker({
      onLongPress: (point) => onLongPressRef.current(point),
      delayMs,
      slopPx,
    });
    trackerRef.current = tracker;
    return () => {
      tracker.dispose();
      if (trackerRef.current === tracker) trackerRef.current = null;
    };
  }, [enabled, delayMs, slopPx]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      trackerRef.current?.pointerDown(event);
    },
    [],
  );
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      trackerRef.current?.pointerMove(event);
    },
    [],
  );
  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      trackerRef.current?.pointerUp(event);
    },
    [],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      trackerRef.current?.pointerCancel(event);
    },
    [],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
