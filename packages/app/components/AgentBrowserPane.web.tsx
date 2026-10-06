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
  containedImageRect,
  isComposingKey,
  keyEvent,
  mapClientPointToViewport,
  mouseEvent,
  textEvent,
  wheelEvent,
} from "@/lib/agentBrowserInput";
import { usePrefixKey } from "@/lib/prefixKeyContext";
import {
  DESKTOP_STREAM_QUALITY,
  STREAM_STATE_LABEL,
  useAgentBrowserStream,
} from "@/lib/useAgentBrowserStream";
import { browserLabel } from "@/lib/terminalWorkspaceLayout";
import { colors, colorAlpha } from "@/lib/colors";

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
  const browserId = browser.id;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prefixKey = usePrefixKey();
  const [inputFocused, setInputFocused] = useState(false);

  const {
    deviceId,
    mine,
    otherDevice,
    state,
    hasFrame,
    metaRef,
    sendInput,
    changeControl,
    controlBusy,
    error,
    closing,
    closeBrowser,
  } = useAgentBrowserStream({
    browser,
    visible,
    quality: DESKTOP_STREAM_QUALITY,
    bodyRef,
    canvasRef,
  });

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
    [metaRef],
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
            if (!closing) void closeBrowser();
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
          {STREAM_STATE_LABEL[state]}
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
