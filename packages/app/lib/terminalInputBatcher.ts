// Coalesce terminal input written in the same tick into one WS message.
//
// Scroll gestures are the heavy case: xterm emits one onData per SGR wheel
// report, and 60-120Hz trackpads emit several wheel events per animation
// frame. Pure wheel-report bursts are coalesced across the animation frame
// (`scheduleWheel`, e.g. requestAnimationFrame) so high-rate scroll gestures
// turn into one WS message and one tmux redraw per frame. Any non-wheel input
// (keystrokes, clicks, pastes) flushes in a microtask so typing latency stays
// zero and byte ordering is strictly preserved.

// SGR mouse wheel reports: button 64 (wheel up) and 65 (wheel down), with
// optional modifier bits (64..79 / 65..79).
const PURE_WHEEL_REPORT_RE = /^(?:\x1b\[<(?:64|65|68|69|72|73|76|77|80|81|84|85|88|89|92|93);\d+;\d+M)+$/;

export function isPureWheelInput(data: string): boolean {
  return data.length > 0 && PURE_WHEEL_REPORT_RE.test(data);
}

export interface InputBatcher {
  push(data: string): void;
  /** Send anything pending now. Call before sending a non-input message so
   *  cross-type ordering is preserved. */
  flush(): void;
}

export function createInputBatcher(
  send: (data: string) => void,
  schedule: (cb: () => void) => void = (cb) => queueMicrotask(cb),
  scheduleWheel?: (cb: () => void) => void,
): InputBatcher {
  let pending: string[] = [];
  let scheduledImmediate = false;
  let scheduledWheel = false;

  const flush = () => {
    scheduledImmediate = false;
    scheduledWheel = false;
    if (pending.length === 0) return;
    const data = pending.length === 1 ? pending[0] : pending.join("");
    pending = [];
    send(data);
  };

  return {
    push(data: string) {
      pending.push(data);
      if (scheduleWheel && isPureWheelInput(data)) {
        if (!scheduledImmediate && !scheduledWheel) {
          scheduledWheel = true;
          scheduleWheel(flush);
        }
        return;
      }
      if (!scheduledImmediate) {
        scheduledImmediate = true;
        schedule(flush);
      }
    },
    flush,
  };
}
