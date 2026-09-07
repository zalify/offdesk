import { openSocket } from "@/lib/secureTransport";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { terminalPreviewsWsUrl } from "@/lib/api";
import {
  createTerminalPreviewSubscriptionRegistry,
  decodeTerminalPreviewFrame,
  type TerminalPreviewChunkHandler,
  type TerminalPreviewClientMessage,
} from "@/lib/terminalPreviewMux";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";

interface TerminalPreviewMuxProviderProps {
  deviceId: string | null;
  children: ReactNode;
}

interface TerminalPreviewMuxContextValue {
  subscribe(
    machineId: string,
    terminalId: string,
    cols: number,
    rows: number,
    handler: TerminalPreviewChunkHandler,
  ): () => void;
}

interface UseTerminalPreviewOutputSourceOptions {
  enabled: boolean;
  machineId: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalOutputSource {
  subscribe: (onChunk: (chunk: Uint8Array) => void) => () => void;
}

const TerminalPreviewMuxContext =
  createContext<TerminalPreviewMuxContextValue | null>(null);

export function TerminalPreviewMuxProvider({
  deviceId,
  children,
}: TerminalPreviewMuxProviderProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const [generation, setGeneration] = useState(0);
  const [activeSubscriptionCount, setActiveSubscriptionCount] = useState(0);
  const hasPreviewSubscriptions = activeSubscriptionCount > 0;

  const sendMessage = useCallback((message: TerminalPreviewClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const registryRef = useRef(
    createTerminalPreviewSubscriptionRegistry(sendMessage),
  );

  useEffect(() => {
    if (!deviceId || !hasPreviewSubscriptions) return;

    let disposed = false;
    const ws = openSocket(terminalPreviewsWsUrl(deviceId));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const reconnectController = createTerminalReconnectController<
      ReturnType<typeof setTimeout>
    >({
      delayMs: 1000,
      openReadyState: WebSocket.OPEN,
      onReconnect: () => {
        if (!disposed) {
          setGeneration((value) => value + 1);
        }
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    });

    const dispatchBytes = (source: ArrayBuffer | Uint8Array) => {
      try {
        registryRef.current.dispatchFrame(decodeTerminalPreviewFrame(source));
      } catch {
        /* ignore malformed preview frames */
      }
    };

    ws.onopen = () => {
      reconnectController.handleSocketOpen();
      registryRef.current.replaySubscriptions();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        dispatchBytes(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(dispatchBytes).catch(() => {
          /* ignore */
        });
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (disposed) return;
      reconnectController.scheduleReconnect();
    };

    const handleVisibilityChange = () => {
      reconnectController.handleVisibilityChange(
        document.visibilityState,
        ws.readyState,
      );
    };
    const handlePageShow = () => {
      reconnectController.handleVisibilityChange("visible", ws.readyState);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      reconnectController.cancelReconnect();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.onclose = null;
      ws.close();
    };
  }, [deviceId, generation, hasPreviewSubscriptions]);

  const value = useMemo<TerminalPreviewMuxContextValue>(
    () => ({
      subscribe(machineId, terminalId, cols, rows, handler) {
        let active = true;
        const unsubscribe = registryRef.current.subscribe(
          { machineId, terminalId, cols, rows },
          handler,
        );
        setActiveSubscriptionCount(registryRef.current.subscriptionCount());

        return () => {
          if (!active) return;
          active = false;
          unsubscribe();
          setActiveSubscriptionCount(registryRef.current.subscriptionCount());
        };
      },
    }),
    [],
  );

  return (
    <TerminalPreviewMuxContext.Provider value={value}>
      {children}
    </TerminalPreviewMuxContext.Provider>
  );
}

export function useTerminalPreviewOutputSource({
  enabled,
  machineId,
  terminalId,
  cols,
  rows,
}: UseTerminalPreviewOutputSourceOptions): TerminalOutputSource | null {
  const mux = useContext(TerminalPreviewMuxContext);

  return useMemo(() => {
    if (!enabled || !mux) return null;
    return {
      subscribe(handler) {
        return mux.subscribe(machineId, terminalId, cols, rows, handler);
      },
    };
  }, [cols, enabled, machineId, mux, rows, terminalId]);
}
