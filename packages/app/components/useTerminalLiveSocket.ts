import { openSocket } from "@/lib/secureTransport";
import { useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

import { createDeflateRawV1Session } from "@/lib/attachCompression";
import { createOrderedBinaryOutputQueue } from "@/lib/orderedBinaryOutput.mjs";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";

interface UseTerminalLiveSocketOptions {
  termRef: RefObject<Terminal | null>;
  onControlMessage?: (text: string) => void;
  onSocketClose?: () => void;
  wsRef: RefObject<WebSocket | null>;
  wsUrl?: string;
  terminalId?: string;
  // Echo-latency probe: TerminalView stamps this with the send time of each
  // input batch when localStorage offdesk:echo-probe=1. Stays null otherwise,
  // which keeps the probe a single null check per output chunk.
  echoProbeSentAtRef?: RefObject<number | null>;
  scheduleMeasure: () => void;
  sessionGeneration: number;
  setSessionGeneration: (next: (value: number) => number) => void;
  onReconnectingChange?: (reconnecting: boolean) => void;
  // Runs in the socket's open handler, before any of its messages. Must be
  // stable: it is an effect dependency.
  onSocketOpen?: () => void;
  // Optional observer called synchronously with each raw/inflated output chunk
  // (used by adaptive local echo prediction to advance/clear predictions).
  onOutputChunk?: (chunk: Uint8Array) => void;
  // While set, called as each output write is issued; the callback it
  // returns runs once that write is parsed and painted. TerminalView sets it
  // only until its first screen is up, so streaming output pays nothing.
  outputPaintWatcherRef?: RefObject<OutputPaintWatcher | null>;
  // False for hidden keep-alive panes: throttle output flushes so background
  // streaming terminals don't steal 60fps frames from the active terminal.
  isActive?: boolean;
}

export type OutputPaintWatcher = () => () => void;

const MAX_PENDING_OUTPUT_BYTES = 128 * 1024;
const HIDDEN_FLUSH_INTERVAL_MS = 250;
// Output arriving later than this after an input send is stream output, not
// the echo of that input.
const ECHO_PROBE_WINDOW_MS = 2000;
const ECHO_PROBE_EMA_ALPHA = 0.2;

interface EchoProbeStats {
  last: number;
  ema: number;
  n: number;
}

export function useTerminalLiveSocket({
  termRef,
  wsRef,
  wsUrl,
  terminalId,
  echoProbeSentAtRef,
  scheduleMeasure,
  sessionGeneration,
  setSessionGeneration,
  onReconnectingChange,
  onControlMessage,
  onSocketClose,
  onSocketOpen,
  onOutputChunk,
  outputPaintWatcherRef,
  isActive = true,
}: UseTerminalLiveSocketOptions) {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const flushNowRef = useRef<(() => void) | null>(null);

  // When a hidden keep-alive pane becomes active, immediately drain any
  // throttled background output so the visible screen is up-to-date in 0ms.
  useEffect(() => {
    if (isActive) {
      flushNowRef.current?.();
    }
  }, [isActive]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !wsUrl) return;
    let disposed = false;

    const ws = openSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const reconnectController = createTerminalReconnectController<number>({
      delayMs: 1000,
      // Coming back from the background reconnects right away: the old
      // socket may be dead without knowing it, and input typed meanwhile
      // waits in TerminalView's pending-input queue for the new one.
      resumeDelayMs: 0,
      openReadyState: WebSocket.OPEN,
      onReconnect: () => {
        if (!disposed) {
          setSessionGeneration((value) => value + 1);
        }
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    });

    let pendingChunks: Uint8Array[] = [];
    let pendingBytes = 0;
    let rafId = 0;
    let hiddenFlushTimer: number | null = null;

    const cancelScheduledFlush = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (hiddenFlushTimer !== null) {
        window.clearTimeout(hiddenFlushTimer);
        hiddenFlushTimer = null;
      }
    };

    // xterm parses a write asynchronously and paints it on its next render
    // frame, so two frames after the parse callback the write is on screen.
    const writeOutput = (data: Uint8Array) => {
      const painted = outputPaintWatcherRef?.current?.();
      if (!painted) {
        term.write(data);
        return;
      }
      term.write(data, () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!disposed) painted();
          });
        });
      });
    };

    const flushPending = () => {
      cancelScheduledFlush();
      if (pendingBytes > 0) {
        const merged = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const chunk of pendingChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        writeOutput(merged);
        pendingChunks = [];
        pendingBytes = 0;
      }
    };
    flushNowRef.current = flushPending;

    // Passive echo-latency probe: the first output chunk after an input
    // send approximates the keystroke echo round trip. Samples land on
    // window.__offdeskEcho[terminalId]; a summary is logged every 20.
    const recordEchoProbeSample = () => {
      const ref = echoProbeSentAtRef;
      const sentAt = ref?.current;
      if (sentAt == null || !ref || !terminalId) return;
      ref.current = null;
      const sample = performance.now() - sentAt;
      if (sample > ECHO_PROBE_WINDOW_MS) return;
      const winAny = window as unknown as {
        __offdeskEcho?: Record<string, EchoProbeStats>;
      };
      const store = (winAny.__offdeskEcho ??= {});
      const prev = store[terminalId];
      const next: EchoProbeStats = prev
        ? {
            last: sample,
            ema: prev.ema + ECHO_PROBE_EMA_ALPHA * (sample - prev.ema),
            n: prev.n + 1,
          }
        : { last: sample, ema: sample, n: 1 };
      store[terminalId] = next;
      if (next.n % 20 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[offdesk] echo probe ${terminalId}: last=${next.last.toFixed(1)}ms ema=${next.ema.toFixed(1)}ms n=${next.n}`,
        );
      }
    };

    const enqueueOutput = (chunk: Uint8Array) => {
      recordEchoProbeSample();
      onOutputChunk?.(chunk);
      if (isActiveRef.current && !rafId && hiddenFlushTimer === null && pendingBytes === 0) {
        // Interactive path: nothing queued this frame — write immediately so
        // a keystroke echo doesn't wait for the next animation frame. The rAF
        // is a burst marker: chunks arriving before it fires get batched.
        writeOutput(chunk);
        rafId = requestAnimationFrame(flushPending);
        return;
      }
      pendingChunks.push(chunk);
      pendingBytes += chunk.length;

      if (pendingBytes >= MAX_PENDING_OUTPUT_BYTES) {
        flushPending();
      } else if (!isActiveRef.current) {
        if (hiddenFlushTimer === null && !rafId) {
          hiddenFlushTimer = window.setTimeout(flushPending, HIDDEN_FLUSH_INTERVAL_MS);
        }
      } else if (!rafId) {
        if (hiddenFlushTimer !== null) {
          window.clearTimeout(hiddenFlushTimer);
          hiddenFlushTimer = null;
        }
        rafId = requestAnimationFrame(flushPending);
      }
    };

    const orderedOutput = createOrderedBinaryOutputQueue(enqueueOutput);

    // deflate-raw-v1: inactive until the hub's CompressionEnabled ack text
    // frame arrives (old hub / old machine / opted-out → never), so binary
    // frames before it are raw PTY bytes exactly as before. The ack is
    // guaranteed to precede every binary frame on this socket.
    const compression = createDeflateRawV1Session({
      onAck: () => {
        if (!terminalId) return;
        const winAny = window as unknown as {
          __offdeskCompression?: Record<string, boolean>;
        };
        (winAny.__offdeskCompression ??= {})[terminalId] = true;
      },
      onError: (error) => {
        // Inflate errors are unrecoverable (the stream context is corrupt):
        // log once and close so the reconnect path re-attaches with a fresh
        // context — renegotiation may also land uncompressed.
        // eslint-disable-next-line no-console
        console.warn("[offdesk] deflate-raw-v1 inflate failed, closing socket", error);
        ws.close();
      },
    });

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        onControlMessage?.(event.data);
        compression.handleText(event.data);
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const inflated = compression.handleBinary(event.data);
        if (inflated === null) {
          orderedOutput.push(event.data);
          return;
        }
        // push() is synchronous, so these chunks are already in stream order;
        // feeding enqueueOutput directly preserves immediate-first-write.
        for (const chunk of inflated) {
          enqueueOutput(chunk);
        }
        return;
      }

      if (event.data instanceof Blob) {
        orderedOutput.push(event.data);
      }
    };

    const refreshTerminalSurface = () => {
      term.refresh(0, Math.max(term.rows - 1, 0));
      scheduleMeasure();
    };

    const handleVisibilityChange = () => {
      reconnectController.handleVisibilityChange(
        document.visibilityState,
        ws.readyState,
      );
      const pendingReconnect = reconnectController.hasPendingReconnect();
      onReconnectingChange?.(pendingReconnect);
      if (document.visibilityState === "visible" && isActiveRef.current && !pendingReconnect) {
        refreshTerminalSurface();
      }
    };

    const handlePageShow = () => {
      reconnectController.handleVisibilityChange("visible", ws.readyState);
      const pendingReconnect = reconnectController.hasPendingReconnect();
      onReconnectingChange?.(pendingReconnect);
      if (isActiveRef.current && !pendingReconnect) {
        refreshTerminalSurface();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    ws.onopen = () => {
      onSocketOpen?.();
      reconnectController.handleSocketOpen();
      onReconnectingChange?.(false);
      if (isActiveRef.current) {
        refreshTerminalSurface();
      }
    };

    ws.onclose = () => {
      onSocketClose?.();
      if (disposed) return;
      onReconnectingChange?.(true);
      reconnectController.scheduleReconnect();
    };

    return () => {
      disposed = true;
      if (flushNowRef.current === flushPending) {
        flushNowRef.current = null;
      }
      onSocketClose?.();
      reconnectController.cancelReconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      cancelScheduledFlush();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.onclose = null;
      ws.close();
    };
  }, [
    scheduleMeasure,
    sessionGeneration,
    setSessionGeneration,
    termRef,
    terminalId,
    echoProbeSentAtRef,
    onReconnectingChange,
    onControlMessage,
    onSocketClose,
    onSocketOpen,
    onOutputChunk,
    outputPaintWatcherRef,
    wsRef,
    wsUrl,
  ]);
}
