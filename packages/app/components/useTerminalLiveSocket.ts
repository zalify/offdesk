import { openSocket } from "@/lib/secureTransport";
import { useEffect, type RefObject } from "react";
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
}

const MAX_PENDING_OUTPUT_BYTES = 128 * 1024;
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
}: UseTerminalLiveSocketOptions) {
  useEffect(() => {
    const term = termRef.current;
    if (!term || !wsUrl) return;
    let disposed = false;

    const ws = openSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const reconnectController = createTerminalReconnectController<number>({
      delayMs: 1000,
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

    const flushPending = () => {
      if (pendingBytes > 0) {
        const merged = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const chunk of pendingChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        term.write(merged);
        pendingChunks = [];
        pendingBytes = 0;
      }
      rafId = 0;
    };

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
      if (!rafId && pendingBytes === 0) {
        // Interactive path: nothing queued this frame — write immediately so
        // a keystroke echo doesn't wait for the next animation frame. The rAF
        // is a burst marker: chunks arriving before it fires get batched.
        term.write(chunk);
        rafId = requestAnimationFrame(flushPending);
        return;
      }
      pendingChunks.push(chunk);
      pendingBytes += chunk.length;

      if (pendingBytes >= MAX_PENDING_OUTPUT_BYTES) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        flushPending();
      } else if (!rafId) {
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
      if (document.visibilityState === "visible") {
        refreshTerminalSurface();
      }
      reconnectController.handleVisibilityChange(
        document.visibilityState,
        ws.readyState,
      );
      onReconnectingChange?.(reconnectController.hasPendingReconnect());
    };

    const handlePageShow = () => {
      refreshTerminalSurface();
      reconnectController.handleVisibilityChange("visible", ws.readyState);
      onReconnectingChange?.(reconnectController.hasPendingReconnect());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    ws.onopen = () => {
      reconnectController.handleSocketOpen();
      onReconnectingChange?.(false);
      refreshTerminalSurface();
    };

    ws.onclose = () => {
      onSocketClose?.();
      if (disposed) return;
      onReconnectingChange?.(true);
      reconnectController.scheduleReconnect();
    };

    return () => {
      disposed = true;
      onSocketClose?.();
      reconnectController.cancelReconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      if (rafId) cancelAnimationFrame(rafId);
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
    wsRef,
    wsUrl,
  ]);
}
