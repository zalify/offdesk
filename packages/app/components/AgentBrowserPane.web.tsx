import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from "react";
import type { AgentBrowserInfo, AgentBrowserInputEvent } from "@offdesk/shared";
import { Globe, Hand, Maximize2, Minimize2, X } from "lucide-react";
import {
  agentBrowserWsUrl,
  closeAgentBrowser,
  controlAgentBrowser,
} from "@/lib/api";
import {
  containedImageRect,
  isComposingKey,
  keyEvent,
  mapClientPointToViewport,
  mouseEvent,
  parseFrameMeta,
  textEvent,
  wheelEvent,
  type AgentBrowserFrameMeta,
} from "@/lib/agentBrowserInput";
import { getPersistentDeviceId } from "@/lib/deviceId";
import { usePrefixKey } from "@/lib/prefixKeyContext";
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

const bannerButton = {
  fontSize: 10,
  padding: "1px 8px",
  borderRadius: 4,
  border: `1px solid ${colorAlpha.accentLine}`,
  background: "transparent",
  color: colors.accent,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
} as const;

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

type WheelInput = Extract<AgentBrowserInputEvent, { kind: "wheel" }>;

function clampSize(value: number, max: number): number {
  return Math.max(MIN_STREAM_SIZE, Math.min(max, Math.round(value)));
}

// Live screencast of one agent browser. View only until the person takes
// control, then pointer, wheel, keyboard, IME and paste input goes to the
// page. Streams only while the pane is visible (its tab is active and the
// document is not hidden): a hidden pane holds no WebSocket, and the hub
// stops the screencast once the last viewer disconnects (and hands control
// back to the agent if the controlling device stays away for 2 minutes).
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const metaRef = useRef<AgentBrowserFrameMeta | null>(null);
  const framesRef = useRef(0);
  const prefixKey = usePrefixKey();
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
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  const controller = browser.controller ?? "agent";
  const mine =
    controller === "human" &&
    deviceId !== null &&
    browser.controller_device_id === deviceId;
  const otherDevice = controller === "human" && !mine;

  const streaming =
    visible && !documentHidden && machineId !== "" && deviceId !== null;

  useEffect(() => {
    let cancelled = false;
    void getPersistentDeviceId().then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

    const ws = openSocket(agentBrowserWsUrl(machineId, browserId, deviceId ?? undefined));
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
      metaRef.current = parseFrameMeta(data.subarray(2, 2 + metaLen));
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
  }, [streaming, machineId, browserId, deviceId, generation, sendParams]);

  const changeControl = useCallback(
    async (action: "take" | "release") => {
      if (!deviceId) return;
      setControlBusy(true);
      setError(null);
      try {
        await controlAgentBrowser(machineId, browserId, {
          action,
          device_id: deviceId,
        });
      } catch (e) {
        setError(
          `Could not ${action === "take" ? "take over" : "hand back"}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setControlBusy(false);
      }
    },
    [deviceId, machineId, browserId],
  );

  const sendInput = useCallback((event: AgentBrowserInputEvent) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", event }));
  }, []);

  /** Viewport point of a client position; `clamp` pins it to the image edge (drags). */
  const viewportPoint = useCallback(
    (clientX: number, clientY: number, clamp: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      const box = canvas.getBoundingClientRect();
      if (clamp) {
        const image = containedImageRect(box, canvas.width, canvas.height);
        if (!image) return null;
        clientX = Math.min(image.left + image.width, Math.max(image.left, clientX));
        clientY = Math.min(image.top + image.height, Math.max(image.top, clientY));
      }
      return mapClientPointToViewport(
        clientX,
        clientY,
        box,
        canvas.width,
        canvas.height,
        metaRef.current,
      );
    },
    [],
  );

  // Take focus into the hidden textarea whenever the person is in control, so
  // typing and IME land there.
  useEffect(() => {
    if (mine && isActive) textareaRef.current?.focus({ preventScroll: true });
  }, [mine, isActive]);

  // Mouse moves and wheel deltas coalesce to one message per animation frame.
  const pendingMoveRef = useRef<AgentBrowserInputEvent | null>(null);
  const pendingWheelRef = useRef<WheelInput | null>(null);
  const frameRef = useRef(0);
  const flushPending = useCallback(() => {
    frameRef.current = 0;
    const wheel = pendingWheelRef.current;
    const move = pendingMoveRef.current;
    pendingWheelRef.current = null;
    pendingMoveRef.current = null;
    if (move) sendInput(move);
    if (wheel) sendInput(wheel);
  }, [sendInput]);
  const scheduleFlush = useCallback(() => {
    if (frameRef.current === 0) {
      frameRef.current = window.requestAnimationFrame(flushPending);
    }
  }, [flushPending]);
  useEffect(
    () => () => {
      if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!mine) {
      pendingMoveRef.current = null;
      pendingWheelRef.current = null;
    }
  }, [mine]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!mine) return;
    textareaRef.current?.focus({ preventScroll: true });
    if (!event.isPrimary) return;
    const point = viewportPoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    flushPending();
    sendInput(mouseEvent("down", point, event));
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!mine || !event.isPrimary) return;
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
    const point = viewportPoint(event.clientX, event.clientY, captured);
    if (!point) return;
    pendingMoveRef.current = mouseEvent("move", point, event);
    scheduleFlush();
  };
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!mine || !event.isPrimary) return;
    const captured = event.currentTarget.hasPointerCapture(event.pointerId);
    const point = viewportPoint(event.clientX, event.clientY, captured);
    if (captured) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!point || !captured) return;
    flushPending();
    sendInput(mouseEvent("up", point, event));
  };

  // React registers wheel listeners as passive; preventDefault needs a native one.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !mine) return;
    const onWheel = (event: WheelEvent) => {
      const point = viewportPoint(event.clientX, event.clientY, false);
      if (!point) return;
      event.preventDefault();
      const next = wheelEvent(point, event) as WheelInput;
      const queued = pendingWheelRef.current;
      if (queued) {
        next.delta_x = (next.delta_x ?? 0) + (queued.delta_x ?? 0);
        next.delta_y = (next.delta_y ?? 0) + (queued.delta_y ?? 0);
      }
      pendingWheelRef.current = next;
      scheduleFlush();
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [mine, viewportPoint, scheduleFlush]);

  const composingRef = useRef(false);
  const justComposedRef = useRef(false);
  // Ctrl/Cmd+V is delivered by the `paste` event, not as a key press.
  const isPasteShortcut = (event: { key: string; ctrlKey: boolean; metaKey: boolean }) =>
    (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mine) return;
    // The workspace's own prefix key (Ctrl+B ...) is never sent to the page.
    if (prefixKey.handleKeydown(event.nativeEvent).type !== "pass") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isComposingKey(event.nativeEvent) || composingRef.current) return;
    if (isPasteShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    sendInput(keyEvent("down", event.nativeEvent));
  };
  const handleKeyUp = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mine) return;
    if (isComposingKey(event.nativeEvent) || composingRef.current) return;
    if (isPasteShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    sendInput(keyEvent("up", event.nativeEvent));
  };
  const clearTextarea = () => {
    if (textareaRef.current) textareaRef.current.value = "";
  };
  const handleCompositionEnd = (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    justComposedRef.current = true;
    window.setTimeout(() => {
      justComposedRef.current = false;
    }, 0);
    clearTextarea();
    if (!mine) return;
    const text = textEvent(event.data);
    if (text) sendInput(text);
  };
  // Text that arrived without key events (some IMEs and dictation).
  const handleInput = () => {
    const value = textareaRef.current?.value ?? "";
    if (composingRef.current || justComposedRef.current) return;
    clearTextarea();
    if (!mine) return;
    const text = textEvent(value);
    if (text) sendInput(text);
  };
  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (!mine) return;
    const text = textEvent(event.clipboardData.getData("text/plain"));
    if (text) sendInput(text);
  };

  const handleClose = useCallback(async () => {
    setClosing(true);
    setError(null);
    try {
      // The hub refuses to close a browser a person controls; hand it back first.
      if (mine && deviceId) {
        await controlAgentBrowser(machineId, browserId, {
          action: "release",
          device_id: deviceId,
        });
      }
      await closeAgentBrowser(machineId, browserId);
    } catch (e) {
      setError(
        `Could not close the browser: ${e instanceof Error ? e.message : String(e)}`,
      );
      setClosing(false);
    }
  }, [machineId, browserId, mine, deviceId]);

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
          data-testid="agent-browser-control-state"
          data-controller={mine ? "me" : otherDevice ? "other" : "agent"}
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 999,
            border: `1px solid ${mine ? colorAlpha.accentLine : colors.border}`,
            background: mine ? colorAlpha.accentSoft : "transparent",
            color: mine ? colors.accent : colors.foregroundMuted,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {mine
            ? "You're in control"
            : otherDevice
              ? "Controlled on another device"
              : "Agent in control"}
        </span>
        <button
          type="button"
          data-testid={mine ? "agent-browser-release" : "agent-browser-take"}
          disabled={controlBusy || deviceId === null}
          onClick={(e) => {
            e.stopPropagation();
            void changeControl(mine ? "release" : "take");
          }}
          style={{
            fontSize: 10,
            padding: "1px 8px",
            borderRadius: 4,
            border: `1px solid ${colorAlpha.accentLine}`,
            background: mine ? "transparent" : colors.accent,
            color: mine ? colors.accent : colors.onAccent,
            cursor: controlBusy ? "default" : "pointer",
            opacity: controlBusy ? 0.5 : 1,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {mine ? "Hand back" : "Take over"}
        </button>
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
      {browser.handoff && (
        <div
          role="status"
          data-testid="agent-browser-handoff"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 8px",
            fontSize: 11,
            color: colors.fg0,
            background: colorAlpha.warningLight12,
            borderBottom: `1px solid ${colorAlpha.warningBorder}`,
            flexShrink: 0,
          }}
        >
          <Hand size={12} aria-hidden style={{ flexShrink: 0, color: colors.warning }} />
          <span
            data-testid="agent-browser-handoff-reason"
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
            title={browser.handoff.reason}
          >
            The agent needs you: {browser.handoff.reason}
          </span>
          {mine ? (
            <button
              type="button"
              data-testid="agent-browser-handoff-release"
              disabled={controlBusy}
              onClick={(e) => {
                e.stopPropagation();
                void changeControl("release");
              }}
              style={bannerButton}
            >
              Hand back
            </button>
          ) : (
            <button
              type="button"
              data-testid="agent-browser-handoff-take"
              disabled={controlBusy || deviceId === null}
              onClick={(e) => {
                e.stopPropagation();
                void changeControl("take");
              }}
              style={bannerButton}
            >
              Take over
            </button>
          )}
        </div>
      )}
      <div
        ref={bodyRef}
        data-testid="agent-browser-body"
        data-controlling={mine ? "true" : "false"}
        tabIndex={mine ? 0 : -1}
        onFocus={() => {
          setInputFocused(true);
          if (mine) textareaRef.current?.focus({ preventScroll: true });
        }}
        onBlur={() => setInputFocused(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => {
          if (mine) e.preventDefault();
        }}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          background: "#000",
          cursor: mine ? "crosshair" : "default",
          outline: "none",
          boxShadow:
            mine && inputFocused
              ? `inset 0 0 0 2px ${colorAlpha.accentLine}`
              : "none",
          touchAction: mine ? "none" : "auto",
          userSelect: "none",
        }}
      >
        <textarea
          ref={textareaRef}
          data-testid="agent-browser-input"
          aria-label="Type into the agent browser"
          tabIndex={-1}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          onPaste={handlePaste}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            resize: "none",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        />
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
