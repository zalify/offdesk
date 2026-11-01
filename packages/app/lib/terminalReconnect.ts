export interface TerminalReconnectController {
  cancelReconnect: () => void;
  handleSocketOpen: () => void;
  handleVisibilityChange: (visibilityState: string, readyState: number) => void;
  hasPendingReconnect: () => boolean;
  scheduleReconnect: () => void;
}

interface TerminalReconnectControllerOptions<TimerHandle> {
  /** Delay before reconnecting after the socket closes. */
  delayMs: number;
  /** Delay before reconnecting when the page comes back to the foreground
   * (or is visible with a socket that is not open). Defaults to delayMs. */
  resumeDelayMs?: number;
  openReadyState: number;
  onReconnect: () => void;
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
  cancel: (timerHandle: TimerHandle) => void;
}

export function createTerminalReconnectController<TimerHandle>({
  delayMs,
  resumeDelayMs = delayMs,
  openReadyState,
  onReconnect,
  schedule,
  cancel,
}: TerminalReconnectControllerOptions<TimerHandle>): TerminalReconnectController {
  let reconnectTimer: TimerHandle | null = null;
  let reconnectTimerDelayMs = 0;
  let wasHidden = false;

  const cancelReconnect = () => {
    if (reconnectTimer === null) {
      return;
    }
    cancel(reconnectTimer);
    reconnectTimer = null;
  };

  // One reconnect at a time: a request while one is pending is a no-op,
  // unless it wants a shorter delay — then the pending one is rescheduled.
  const requestReconnect = (requestedDelayMs: number) => {
    if (reconnectTimer !== null) {
      if (reconnectTimerDelayMs <= requestedDelayMs) {
        return;
      }
      cancelReconnect();
    }
    reconnectTimerDelayMs = requestedDelayMs;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      onReconnect();
    }, requestedDelayMs);
  };

  const scheduleReconnect = () => {
    requestReconnect(delayMs);
  };

  return {
    cancelReconnect,
    handleSocketOpen() {
      cancelReconnect();
    },
    handleVisibilityChange(visibilityState, readyState) {
      if (visibilityState !== "visible") {
        wasHidden = true;
        return;
      }
      const shouldReconnect = wasHidden || readyState !== openReadyState;
      wasHidden = false;
      if (!shouldReconnect) return;
      requestReconnect(resumeDelayMs);
    },
    hasPendingReconnect() {
      return reconnectTimer !== null;
    },
    scheduleReconnect,
  };
}
