import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBrowserInfo } from "@offdesk/shared";
import { Globe, Maximize2, Minimize2, X } from "lucide-react";
import { agentBrowserWsUrl, closeAgentBrowser } from "@/lib/api";
import { openSocket } from "@/lib/secureTransport";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";
import { browserLabel } from "@/lib/terminalWorkspaceLayout";
import { colors, colorAlpha } from "@/lib/colors";

// The agent browser's viewport is fixed at 1280x800 on the node; the stream
// is only ever downscaled to the pane.
const MAX_STREAM_WIDTH = 1280;
const MAX_STREAM_HEIGHT = 800;
const MIN_STREAM_SIZE = 200;
const STREAM_QUALITY = 60;
const PARAMS_DEBOUNCE_MS = 250;
const RECONNECT_DELAY_MS = 1000;

type StreamState = "connecting" | "live" | "reconnecting" | "paused" | "closed";

const STATE_LABEL: Record<StreamState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  paused: "Paused",
  closed: "Closed",
};

/** `host + path` of a page URL, without scheme, query or fragment. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:") return "data: URL";
    if (!parsed.host) return url;
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function clampSize(value: number, max: number): number {
  return Math.max(MIN_STREAM_SIZE, Math.min(max, Math.round(value)));
}

// Live, view-only screencast of one agent browser. Streams only while the
// pane is visible (its tab is active and the document is not hidden): a
// hidden pane holds no WebSocket, and the hub stops the screencast once the
// last viewer disconnects.
export function AgentBrowserPane({
  browser,
  isActive,
  focusRing = true,
  visible = true,
  isMaximized = false,
  onToggleMaximize,
  onFocus,
}: {
  browser: AgentBrowserInfo;
  isActive: boolean;
  focusRing?: boolean;
  /** False while the pane's workspace tab is not the shown one. */
  visible?: boolean;
  isMaximized?: boolean;
  onToggleMaximize?: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const machineId = browser.machine_id ?? "";
  const browserId = browser.id;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const framesRef = useRef(0);
  const paramsRef = useRef({
    max_width: MAX_STREAM_WIDTH,
    max_height: MAX_STREAM_HEIGHT,
    quality: STREAM_QUALITY,
  });
  const sentParamsRef = useRef("");

  const [documentHidden, setDocumentHidden] = useState(
    typeof document !== "undefined" && document.hidden,
  );
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<StreamState>("connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streaming = visible && !documentHidden && machineId !== "";

  useEffect(() => {
    const onVisibility = () => setDocumentHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const sendParams = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type: "params", ...paramsRef.current });
    if (message === sentParamsRef.current) return;
    sentParamsRef.current = message;
    ws.send(message);
  }, []);

  // Size the stream to the pane body: no point decoding more pixels than the
  // pane can show.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer = 0;
    const measure = (width: number, height: number) => {
      const dpr = window.devicePixelRatio || 1;
      paramsRef.current = {
        max_width: clampSize(width * dpr, MAX_STREAM_WIDTH),
        max_height: clampSize(height * dpr, MAX_STREAM_HEIGHT),
        quality: STREAM_QUALITY,
      };
      sendParams();
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => measure(rect.width, rect.height),
        PARAMS_DEBOUNCE_MS,
      );
    });
    observer.observe(body);
    const rect = body.getBoundingClientRect();
    measure(rect.width, rect.height);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [sendParams]);

  useEffect(() => {
    if (!streaming) {
      setState((current) => (current === "closed" ? current : "paused"));
      return;
    }
    let disposed = false;
    let destroyed = false;
    let decoding = false;
    let pending: Uint8Array | null = null;

    const ws = openSocket(agentBrowserWsUrl(machineId, browserId));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    sentParamsRef.current = "";
    setState(generation === 0 ? "connecting" : "reconnecting");

    const reconnect = createTerminalReconnectController<number>({
      delayMs: RECONNECT_DELAY_MS,
      openReadyState: WebSocket.OPEN,
      onReconnect: () => {
        if (!disposed) setGeneration((value) => value + 1);
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    });

    const drawLoop = async () => {
      if (decoding) return;
      decoding = true;
      try {
        while (pending && !disposed) {
          // Latest frame wins; anything older was superseded while decoding.
          const jpeg = pending;
          pending = null;
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(
              new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
            );
            const canvas = canvasRef.current;
            if (disposed || !canvas) continue;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
            framesRef.current += 1;
            canvas.dataset.frames = String(framesRef.current);
            setHasFrame(true);
          } catch {
            // A corrupt frame is skipped; the ack below still unblocks the hub.
          } finally {
            bitmap?.close();
          }
          if (!disposed && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ack" }));
          }
        }
      } finally {
        decoding = false;
      }
    };

    ws.onopen = () => {
      reconnect.handleSocketOpen();
      setState("live");
      sendParams();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === "destroyed") {
            destroyed = true;
            setState("closed");
          }
        } catch {
          // ignore malformed control messages
        }
        return;
      }
      // [u16 BE meta_len][meta JSON][jpeg]
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 2) return;
      const metaLen = (data[0] << 8) | data[1];
      if (data.length < 2 + metaLen) return;
      pending = data.subarray(2 + metaLen);
      void drawLoop();
    };
    ws.onclose = () => {
      if (disposed || destroyed) return;
      setState("reconnecting");
      reconnect.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };

    return () => {
      disposed = true;
      reconnect.cancelReconnect();
      if (wsRef.current === ws) wsRef.current = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    };
  }, [streaming, machineId, browserId, generation, sendParams]);

  const handleClose = useCallback(async () => {
    setClosing(true);
    setError(null);
    try {
      await closeAgentBrowser(machineId, browserId);
    } catch (e) {
      setError(
        `Could not close the browser: ${e instanceof Error ? e.message : String(e)}`,
      );
      setClosing(false);
    }
  }, [machineId, browserId]);

  const label = browserLabel(browser);
  const highlighted = isActive && focusRing;
  const iconButton = {
    background: "none",
    border: "none",
    color: colors.foregroundMuted,
    cursor: "pointer",
    padding: "2px 4px",
    display: "flex",
    alignItems: "center",
  } as const;

  return (
    <div
      data-testid={`agent-browser-pane-${browserId}`}
      data-browser-id={browserId}
      onMouseDown={() => onFocus(browserId)}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        background: colors.bg0,
        color: colors.fg0,
        border: `1px solid ${highlighted ? colorAlpha.accentLine : colors.line}`,
        boxShadow: highlighted ? `0 0 0 1px ${colorAlpha.accentLine}` : "none",
        overflow: "hidden",
      }}
    >
      <div
        data-testid="agent-browser-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.bg1,
          flexShrink: 0,
          gap: 6,
        }}
      >
        <button
          type="button"
          data-testid="agent-browser-close"
          onClick={(e) => {
            e.stopPropagation();
            if (!closing) void handleClose();
          }}
          disabled={closing}
          style={{ ...iconButton, color: colors.danger, opacity: closing ? 0.3 : 0.6 }}
          title="Close browser"
          aria-label="Close browser"
        >
          <X size={14} aria-hidden />
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflow: "hidden",
            minWidth: 0,
            flex: 1,
          }}
        >
          <Globe size={12} aria-hidden style={{ flexShrink: 0, color: colors.accent }} />
          <span
            data-testid="agent-browser-title"
            style={{
              fontSize: 11,
              color: colors.foreground,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
              maxWidth: "45%",
            }}
          >
            {label}
          </span>
          <span
            data-testid="agent-browser-url"
            title={browser.url}
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {shortUrl(browser.url)}
          </span>
        </div>
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 999,
            border: `1px solid ${colors.border}`,
            color: colors.foregroundMuted,
            flexShrink: 0,
          }}
        >
          View only
        </span>
        <span
          data-testid="agent-browser-state"
          style={{
            fontSize: 10,
            color: state === "live" ? colors.accent : colors.foregroundMuted,
            flexShrink: 0,
          }}
        >
          {STATE_LABEL[state]}
        </span>
        {onToggleMaximize && (
          <button
            type="button"
            data-testid="agent-browser-maximize"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize(browserId);
            }}
            style={iconButton}
            title={isMaximized ? "Restore pane" : "Maximize pane"}
            aria-label={isMaximized ? "Restore pane" : "Maximize pane"}
          >
            {isMaximized ? (
              <Minimize2 size={14} aria-hidden />
            ) : (
              <Maximize2 size={14} aria-hidden />
            )}
          </button>
        )}
      </div>
      {error && (
        <div
          role="alert"
          data-testid="agent-browser-error"
          style={{
            padding: "4px 8px",
            fontSize: 11,
            color: colors.danger,
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}
      <div
        ref={bodyRef}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          background: "#000",
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="agent-browser-canvas"
          data-frames="0"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            visibility: hasFrame ? "visible" : "hidden",
          }}
        />
        {!hasFrame && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: colors.foregroundMuted,
              fontSize: 12,
            }}
          >
            Waiting for the browser…
          </div>
        )}
      </div>
    </div>
  );
}
