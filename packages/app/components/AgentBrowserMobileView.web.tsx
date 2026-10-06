import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AgentBrowserInfo, AgentBrowserInputEvent } from "@offdesk/shared";
import { Globe, Hand, Keyboard as KeyboardIcon, X } from "lucide-react";
import {
  IDENTITY_VIEW_ZOOM,
  classifyTouchGesture,
  compositionEndAction,
  dragWheelEvent,
  isComposingKey,
  isDoubleTap,
  keyEvent,
  mapZoomedClientPointToViewport,
  panViewBy,
  pinchViewZoom,
  softInputAction,
  softKeyEvents,
  tapEvents,
  textEvent,
  toggleViewZoomAt,
  viewportPerClientPx,
  type Point,
  type SoftInputAction,
  type SoftKeyName,
  type ViewZoom,
} from "@/lib/agentBrowserInput";
import {
  COMPACT_STREAM_QUALITY,
  STREAM_STATE_LABEL,
  useAgentBrowserStream,
} from "@/lib/useAgentBrowserStream";
import { browserLabel } from "@/lib/terminalWorkspaceLayout";
import { colors, colorAlpha } from "@/lib/colors";

type WheelInput = Extract<AgentBrowserInputEvent, { kind: "wheel" }>;

const SOFT_KEYS: { name: SoftKeyName; label: string; text: string }[] = [
  { name: "Escape", label: "Escape", text: "Esc" },
  { name: "Tab", label: "Tab", text: "Tab" },
  { name: "ArrowLeft", label: "Arrow left", text: "←" },
  { name: "ArrowUp", label: "Arrow up", text: "↑" },
  { name: "ArrowDown", label: "Arrow down", text: "↓" },
  { name: "ArrowRight", label: "Arrow right", text: "→" },
  { name: "Backspace", label: "Backspace", text: "⌫" },
  { name: "Enter", label: "Enter", text: "Enter" },
];

const headerButton = {
  fontSize: 12,
  fontWeight: 600,
  minHeight: 30,
  padding: "0 10px",
  borderRadius: 999,
  border: `1px solid ${colorAlpha.accentLine}`,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
} as const;

// Full-width, phone-sized view of one agent browser: live frames, local
// pinch / double-tap zoom, take over and hand back, and, while this device
// is in control, touch input (tap, drag to scroll, long press for a right
// click) and the soft keyboard. Mounted over the terminal area of the mobile
// workbench; the stream, control and close logic is the same hook the
// desktop pane uses.
export function AgentBrowserMobileView({
  browser,
  onClosed,
}: {
  browser: AgentBrowserInfo;
  onClosed?: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    visible: true,
    quality: COMPACT_STREAM_QUALITY,
    bodyRef,
    canvasRef,
  });

  const [zoom, setZoomState] = useState<ViewZoom>(IDENTITY_VIEW_ZOOM);
  const zoomRef = useRef<ViewZoom>(IDENTITY_VIEW_ZOOM);
  const setZoom = useCallback((next: ViewZoom) => {
    zoomRef.current = next;
    setZoomState(next);
  }, []);
  const [keyboardOn, setKeyboardOn] = useState(false);

  const mineRef = useRef(mine);
  mineRef.current = mine;
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  // Hand back (or lose control): drop the keyboard.
  useEffect(() => {
    if (!mine) textareaRef.current?.blur();
  }, [mine]);

  // ---- touch: tap / drag / long press / pinch / pan / double tap ----
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    interface Touch1 {
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      startTime: number;
      travel: number;
      maxTouches: number;
      mode: "none" | "drag" | "long" | "zoom";
    }
    let gesture: Touch1 | null = null;
    let pinch: {
      zoom: ViewZoom;
      center: Point;
      distance: number;
    } | null = null;
    let longTimer = 0;
    let lastTap: { time: number; x: number; y: number } | null = null;
    let lastPoint: Point | null = null;
    let pendingWheel: WheelInput | null = null;
    let frame = 0;

    const emit = (events: AgentBrowserInputEvent[]) => {
      for (const event of events) sendInputRef.current(event);
    };
    const flushWheel = () => {
      frame = 0;
      const wheel = pendingWheel;
      pendingWheel = null;
      if (wheel) sendInputRef.current(wheel);
    };
    const boxRect = () => body.getBoundingClientRect();
    const mapPoint = (clientX: number, clientY: number): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      return mapZoomedClientPointToViewport(
        clientX,
        clientY,
        boxRect(),
        zoomRef.current,
        canvas.width,
        canvas.height,
        metaRef.current,
      );
    };
    const touchCenter = (a: Touch, b: Touch, rect: DOMRect): Point => ({
      x: (a.clientX + b.clientX) / 2 - rect.left,
      y: (a.clientY + b.clientY) / 2 - rect.top,
    });
    const touchDistance = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const cancelLongPress = () => {
      window.clearTimeout(longTimer);
      longTimer = 0;
    };
    const reset = () => {
      cancelLongPress();
      gesture = null;
      pinch = null;
    };

    const onStart = (event: TouchEvent) => {
      event.preventDefault();
      if (event.touches.length === 1 && gesture === null) {
        const touch = event.touches[0];
        gesture = {
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          startTime: Date.now(),
          travel: 0,
          maxTouches: 1,
          mode: "none",
        };
        cancelLongPress();
        if (mineRef.current) {
          longTimer = window.setTimeout(() => {
            longTimer = 0;
            const current = gesture;
            if (!current || current.mode !== "none" || !mineRef.current) return;
            const kind = classifyTouchGesture({
              maxTouches: current.maxTouches,
              travel: current.travel,
              elapsedMs: Date.now() - current.startTime,
              ended: false,
            });
            if (kind !== "long-press") return;
            const point = mapPoint(current.startX, current.startY);
            current.mode = "long";
            if (point) emit(tapEvents(point, "right"));
          }, 500);
        }
        return;
      }
      if (event.touches.length >= 2 && gesture) {
        // Two fingers belong to local zoom / pan; the page never sees them.
        cancelLongPress();
        flushWheel();
        gesture.maxTouches = 2;
        gesture.mode = "zoom";
        const rect = boxRect();
        const [a, b] = [event.touches[0], event.touches[1]];
        pinch = {
          zoom: zoomRef.current,
          center: touchCenter(a, b, rect),
          distance: touchDistance(a, b),
        };
      }
    };

    const onMove = (event: TouchEvent) => {
      event.preventDefault();
      const current = gesture;
      if (!current) return;
      if (current.mode === "zoom") {
        if (event.touches.length < 2 || !pinch) return;
        const rect = boxRect();
        const [a, b] = [event.touches[0], event.touches[1]];
        setZoom(
          pinchViewZoom(
            pinch.zoom,
            pinch.center,
            pinch.distance,
            touchCenter(a, b, rect),
            touchDistance(a, b),
            { width: rect.width, height: rect.height },
          ),
        );
        return;
      }
      const touch = Array.from(event.touches).find(
        (t) => t.identifier === current.id,
      );
      if (!touch) return;
      current.travel = Math.max(
        current.travel,
        Math.hypot(touch.clientX - current.startX, touch.clientY - current.startY),
      );
      const kind = classifyTouchGesture({
        maxTouches: current.maxTouches,
        travel: current.travel,
        elapsedMs: Date.now() - current.startTime,
        ended: false,
      });
      if (kind === "drag" && current.mode === "none") {
        current.mode = "drag";
        cancelLongPress();
      }
      if (current.mode !== "drag") return;
      const dx = touch.clientX - current.lastX;
      const dy = touch.clientY - current.lastY;
      current.lastX = touch.clientX;
      current.lastY = touch.clientY;
      if (mineRef.current) {
        const canvas = canvasRef.current;
        if (!canvas || canvas.width === 0) return;
        const rect = boxRect();
        const factor = viewportPerClientPx(
          rect,
          zoomRef.current,
          canvas.width,
          canvas.height,
          metaRef.current,
        );
        const point =
          mapPoint(touch.clientX, touch.clientY) ?? lastPoint ?? { x: 640, y: 400 };
        lastPoint = point;
        const wheel = dragWheelEvent(point, dx, dy, factor) as WheelInput;
        if (pendingWheel) {
          wheel.delta_x = (wheel.delta_x ?? 0) + (pendingWheel.delta_x ?? 0);
          wheel.delta_y = (wheel.delta_y ?? 0) + (pendingWheel.delta_y ?? 0);
        }
        pendingWheel = wheel;
        if (frame === 0) frame = window.requestAnimationFrame(flushWheel);
      } else if (zoomRef.current.scale > 1) {
        // Viewing a zoomed page: one finger pans the view.
        const rect = boxRect();
        setZoom(
          panViewBy(zoomRef.current, dx, dy, {
            width: rect.width,
            height: rect.height,
          }),
        );
      }
    };

    const onEnd = (event: TouchEvent) => {
      event.preventDefault();
      const current = gesture;
      if (!current) return;
      if (current.mode === "zoom") {
        if (event.touches.length === 0) reset();
        return;
      }
      const changed = Array.from(event.changedTouches).find(
        (t) => t.identifier === current.id,
      );
      if (!changed) return;
      cancelLongPress();
      const mode = current.mode;
      const kind = classifyTouchGesture({
        maxTouches: current.maxTouches,
        travel: current.travel,
        elapsedMs: Date.now() - current.startTime,
        ended: true,
      });
      gesture = null;
      if (mode === "drag") {
        flushWheel();
        return;
      }
      if (mode !== "none") return;
      if (mineRef.current) {
        const point = mapPoint(changed.clientX, changed.clientY);
        if (!point) return;
        if (kind === "tap") emit(tapEvents(point, "left"));
        else if (kind === "long-press") emit(tapEvents(point, "right"));
        return;
      }
      if (kind !== "tap") return;
      const tap = { time: Date.now(), x: changed.clientX, y: changed.clientY };
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null;
        const rect = boxRect();
        setZoom(
          toggleViewZoomAt(
            zoomRef.current,
            { x: tap.x - rect.left, y: tap.y - rect.top },
            { width: rect.width, height: rect.height },
          ),
        );
      } else {
        lastTap = tap;
      }
    };

    const onCancel = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      pendingWheel = null;
      reset();
    };

    body.addEventListener("touchstart", onStart, { passive: false });
    body.addEventListener("touchmove", onMove, { passive: false });
    body.addEventListener("touchend", onEnd, { passive: false });
    body.addEventListener("touchcancel", onCancel);
    return () => {
      body.removeEventListener("touchstart", onStart);
      body.removeEventListener("touchmove", onMove);
      body.removeEventListener("touchend", onEnd);
      body.removeEventListener("touchcancel", onCancel);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.clearTimeout(longTimer);
    };
  }, [metaRef, setZoom]);

  // ---- soft keyboard: text from beforeinput / compositionend ----
  const composingRef = useRef(false);
  const justComposedRef = useRef(false);
  const skipInputRef = useRef(false);
  const clearTextarea = () => {
    if (textareaRef.current) textareaRef.current.value = "";
  };
  const applyAction = useCallback(
    (action: SoftInputAction | null) => {
      if (!action || !mineRef.current) return;
      if (action.kind === "text") {
        const text = textEvent(action.text);
        if (text) sendInput(text);
      } else {
        for (const event of softKeyEvents(action.key)) sendInput(event);
      }
    },
    [sendInput],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onBeforeInput = (event: InputEvent) => {
      const action = softInputAction(
        event.inputType,
        event.data,
        composingRef.current || event.isComposing,
      );
      if (!action) return;
      event.preventDefault();
      // If the platform ignores preventDefault, the matching `input` event
      // must not send the same text again.
      skipInputRef.current = true;
      window.setTimeout(() => {
        skipInputRef.current = false;
      }, 0);
      applyAction(action);
    };
    textarea.addEventListener("beforeinput", onBeforeInput);
    return () => textarea.removeEventListener("beforeinput", onBeforeInput);
  }, [applyAction]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mine) return;
    const native = event.nativeEvent;
    // IME keystrokes (keyCode 229) are handled by beforeinput / compositionend.
    if (isComposingKey(native) || composingRef.current) return;
    if (native.key === "Unidentified") return;
    if ((native.ctrlKey || native.metaKey) && native.key.toLowerCase() === "v") return;
    event.preventDefault();
    sendInput(keyEvent("down", native));
  };
  const handleKeyUp = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mine) return;
    const native = event.nativeEvent;
    if (isComposingKey(native) || composingRef.current) return;
    if (native.key === "Unidentified") return;
    if ((native.ctrlKey || native.metaKey) && native.key.toLowerCase() === "v") return;
    event.preventDefault();
    sendInput(keyEvent("up", native));
  };
  const handleCompositionEnd = (data: string) => {
    composingRef.current = false;
    justComposedRef.current = true;
    window.setTimeout(() => {
      justComposedRef.current = false;
    }, 0);
    clearTextarea();
    applyAction(compositionEndAction(data));
  };
  // Text that arrived without a usable beforeinput (some IMEs, dictation).
  const handleInput = (inputType: string) => {
    if (composingRef.current || justComposedRef.current) return;
    if (inputType === "insertCompositionText" || inputType === "insertFromComposition") {
      return;
    }
    const value = textareaRef.current?.value ?? "";
    clearTextarea();
    if (skipInputRef.current) return;
    applyAction(value ? { kind: "text", text: value } : null);
  };
  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (!mine) return;
    const text = textEvent(event.clipboardData.getData("text/plain"));
    if (text) sendInput(text);
  };

  const toggleKeyboard = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Focus has to happen inside the tap handler or the soft keyboard stays shut.
    if (document.activeElement === textarea) textarea.blur();
    else textarea.focus({ preventScroll: true });
  };

  const handleClose = async () => {
    await closeBrowser();
    onClosed?.();
  };

  const label = browserLabel(browser);
  const stateText = mine
    ? "In control"
    : otherDevice
      ? "Other device"
      : "Agent";

  return (
    <div
      data-testid="mobile-agent-browser"
      data-browser-id={browser.id}
      data-controlling={mine ? "true" : "false"}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: colors.bg0,
        color: colors.fg0,
      }}
    >
      <div
        data-testid="mobile-agent-browser-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          minHeight: 42,
          borderBottom: `1px solid ${colors.lineSoft}`,
          background: colors.bg1,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          data-testid="mobile-agent-browser-close"
          aria-label="Close browser"
          title="Close browser"
          disabled={closing}
          onClick={() => void handleClose()}
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: colors.danger,
            opacity: closing ? 0.3 : 0.8,
            cursor: "pointer",
          }}
        >
          <X size={16} aria-hidden />
        </button>
        <Globe size={14} aria-hidden style={{ flexShrink: 0, color: colors.accent }} />
        <span
          data-testid="mobile-agent-browser-title"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span
          data-testid="mobile-agent-browser-control-state"
          data-controller={mine ? "me" : otherDevice ? "other" : "agent"}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${mine ? colorAlpha.accentLine : colors.border}`,
            background: mine ? colorAlpha.accentSoft : "transparent",
            color: mine ? colors.accent : colors.foregroundMuted,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {stateText}
        </span>
        <button
          type="button"
          data-testid={mine ? "mobile-agent-browser-release" : "mobile-agent-browser-take"}
          disabled={controlBusy || deviceId === null}
          onClick={() => void changeControl(mine ? "release" : "take")}
          style={{
            ...headerButton,
            background: mine ? "transparent" : colors.accent,
            color: mine ? colors.accent : colors.onAccent,
            opacity: controlBusy ? 0.5 : 1,
          }}
        >
          {mine ? "Hand back" : "Take over"}
        </button>
        <span
          data-testid="mobile-agent-browser-state"
          data-state={state}
          title={STREAM_STATE_LABEL[state]}
          aria-label={STREAM_STATE_LABEL[state]}
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            flexShrink: 0,
            background: state === "live" ? colors.accent : colors.foregroundMuted,
          }}
        />
      </div>
      {error && (
        <div
          role="alert"
          data-testid="mobile-agent-browser-error"
          style={{
            padding: "4px 10px",
            fontSize: 12,
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
          data-testid="mobile-agent-browser-handoff"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            fontSize: 12,
            color: colors.fg0,
            background: colorAlpha.warningLight12,
            borderBottom: `1px solid ${colorAlpha.warningBorder}`,
            flexShrink: 0,
          }}
        >
          <Hand size={14} aria-hidden style={{ flexShrink: 0, color: colors.warning }} />
          <span
            data-testid="mobile-agent-browser-handoff-reason"
            style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
          >
            The agent needs you: {browser.handoff.reason}
          </span>
          <button
            type="button"
            data-testid={
              mine
                ? "mobile-agent-browser-handoff-release"
                : "mobile-agent-browser-handoff-take"
            }
            disabled={controlBusy || deviceId === null}
            onClick={() => void changeControl(mine ? "release" : "take")}
            style={{
              ...headerButton,
              background: "transparent",
              color: colors.accent,
            }}
          >
            {mine ? "Hand back" : "Take over"}
          </button>
        </div>
      )}
      <div
        ref={bodyRef}
        data-testid="mobile-agent-browser-body"
        data-edge-swipe="off"
        onContextMenu={(event) => event.preventDefault()}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          background: "#000",
          // The app's global rule is `touch-action: manipulation` on
          // everything; only this surface takes every touch itself.
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          boxShadow: mine ? `inset 0 0 0 2px ${colorAlpha.accentLine}` : "none",
        }}
      >
        <textarea
          ref={textareaRef}
          data-testid="mobile-agent-browser-input"
          aria-label="Type into the agent browser"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          onFocus={() => setKeyboardOn(true)}
          onBlur={() => setKeyboardOn(false)}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => handleCompositionEnd(event.data)}
          onInput={(event) =>
            handleInput((event.nativeEvent as InputEvent).inputType ?? "")
          }
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
            fontSize: 16,
            resize: "none",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        />
        <canvas
          ref={canvasRef}
          data-testid="mobile-agent-browser-canvas"
          data-frames="0"
          data-zoom={zoom.scale.toFixed(2)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transformOrigin: "0 0",
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            visibility: hasFrame ? "visible" : "hidden",
            touchAction: "none",
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
              fontSize: 13,
              pointerEvents: "none",
            }}
          >
            Waiting for the browser…
          </div>
        )}
        {zoom.scale > 1 && (
          <button
            type="button"
            data-testid="mobile-agent-browser-zoom-reset"
            aria-label="Reset zoom"
            onTouchStart={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            onClick={() => setZoom(IDENTITY_VIEW_ZOOM)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              minHeight: 32,
              padding: "0 12px",
              borderRadius: 999,
              border: `1px solid ${colors.line}`,
              background: colorAlpha.accentSoft,
              color: colors.fg0,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {zoom.scale.toFixed(1)}× · Reset
          </button>
        )}
      </div>
      {mine && (
        <div
          data-testid="mobile-agent-browser-keybar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            paddingBottom: "max(6px, env(safe-area-inset-bottom))",
            borderTop: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            data-testid="mobile-agent-browser-keyboard"
            aria-label="Keyboard"
            aria-pressed={keyboardOn}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleKeyboard}
            style={{
              width: 44,
              height: 40,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              border: `1px solid ${keyboardOn ? colorAlpha.accentLine : colors.line}`,
              background: keyboardOn ? colorAlpha.accentSoft : colors.bg0,
              color: keyboardOn ? colors.accent : colors.fg0,
              cursor: "pointer",
            }}
          >
            <KeyboardIcon size={18} aria-hidden />
          </button>
          <div
            style={{
              display: "flex",
              gap: 6,
              overflowX: "auto",
              minWidth: 0,
              flex: 1,
              overscrollBehaviorX: "contain",
            }}
          >
            {SOFT_KEYS.map((key) => (
              <button
                key={key.name}
                type="button"
                data-testid={`mobile-agent-browser-key-${key.name}`}
                aria-label={key.label}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  for (const event of softKeyEvents(key.name)) sendInput(event);
                }}
                style={{
                  minWidth: 42,
                  height: 40,
                  padding: "0 10px",
                  flexShrink: 0,
                  borderRadius: 10,
                  border: `1px solid ${colors.line}`,
                  background: colors.bg0,
                  color: colors.fg0,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {key.text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
