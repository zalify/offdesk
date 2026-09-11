import { createPortal } from "react-dom";
import { lazy, memo, Suspense, useRef, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import type { TerminalInfo } from "@offdesk/shared";
import { X } from "lucide-react";
import type { TerminalViewRef, SelectionSnapshot } from "./TerminalView.types";
import { ExtendedKeyBar } from "./ExtendedKeyBar";
import { TerminalPreviewText } from "./TerminalPreviewText.web";
import { terminalWsUrl } from "@/lib/api";
import { colors, terminalTheme } from "@/lib/colors";
import { useTerminalModifiers } from "@/lib/useTerminalModifiers";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { useVisualViewportHeight } from "@/lib/hooks";
import { useTerminalKeyboard } from "@/lib/useTerminalKeyboard";
import { useKeyBarSlot } from "@/lib/keyBarSlot";
import { getMobileViewportTerminalAction } from "@/lib/mobileViewportTerminal";
import { estimateInitialTerminalDimensions } from "@/lib/terminalViewModel";
import { lazyWithReload } from "@/lib/lazyWithReload";
import { LazyLoadingFallback } from "./LazyLoadingFallback";

const LiveTerminalView = lazy(() =>
  lazyWithReload(() =>
    import("./TerminalView.web").then((module) => ({
      default: module.TerminalView,
    })),
  ),
);

const FIT_REF_RETRY_LIMIT = 10;
const FIT_REF_RETRY_DELAY_MS = 100;
const MOBILE_VIEWPORT_SETTLE_MS = 150;

export interface TerminalCardRef {
  fitToContainer: (opts?: {
    skipIfUnchanged?: boolean;
    focusAfterFit?: boolean;
  }) => void;
  focus: () => void;
  blur: () => void;
  sendInput: (data: string) => void;
}

interface TerminalCardProps {
  terminal: TerminalInfo;
  displayMode: "card" | "tab";
  isCompact: boolean;
  isTouch: boolean;
  isActive: boolean;
  isController: boolean;
  canType: boolean;
  eventsReconnecting: boolean;
  reconnectIndicatorActive: boolean;
  deviceId: string;
  workpathLabel?: string; // shown in the top-left of the card body when in card mode
  onSelectTab: (id: string | null) => void;
  onDestroy: (terminal: TerminalInfo) => void;
  onRequestControl?: (machineId: string) => void;
  onReleaseControl?: (machineId: string) => void;
}

const TerminalCardComponent = forwardRef<TerminalCardRef, TerminalCardProps>(function TerminalCardComponent({
  terminal,
  displayMode,
  isCompact,
  isTouch,
  isActive,
  isController,
  canType,
  eventsReconnecting,
  reconnectIndicatorActive,
  deviceId,
  workpathLabel,
  onSelectTab,
  onDestroy,
  onRequestControl,
  onReleaseControl,
}, ref) {
  const termViewRef = useRef<TerminalViewRef>(null);
  const selectOverlayRef = useRef<HTMLPreElement>(null);
  const fitRefRetryTimer = useRef<number | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useTerminalKeyboard(isTouch && isActive, setKeyboardVisible);
  const [selectMode, setSelectMode] = useState(false);
  const [terminalReconnecting, setTerminalReconnecting] = useState(false);
  const [selectSnapshot, setSelectSnapshot] = useState<SelectionSnapshot | null>(null);
  const isTab = displayMode === "tab";
  const keyBarSlot = useKeyBarSlot();

  // Share modifiers between command keys and direct/IME input. They never
  // focus the terminal, and cannot leak across tabs, leases or reconnects.
  const modifiers = useTerminalModifiers(terminal.id, canType && isActive && !selectMode && !eventsReconnecting && !terminalReconnecting);
  const inputTransformRef = useRef<((data: string) => string) | null>(null);
  inputTransformRef.current = modifiers.transform;

  const clearFitRefRetryTimer = useCallback(() => {
    if (fitRefRetryTimer.current !== null) {
      window.clearTimeout(fitRefRetryTimer.current);
      fitRefRetryTimer.current = null;
    }
  }, []);

  const fitToContainer = useCallback(
    (
      opts: {
        attempt?: number;
        skipIfUnchanged?: boolean;
        focusAfterFit?: boolean;
      } = {},
    ) => {
      const attempt = opts.attempt ?? 0;
      const skipIfUnchanged = opts.skipIfUnchanged ?? false;
      const focusAfterFit = opts.focusAfterFit ?? true;
      if (!isController || !isTab) return;
      const view = termViewRef.current;
      if (!view) {
        if (attempt >= FIT_REF_RETRY_LIMIT) return;
        clearFitRefRetryTimer();
        fitRefRetryTimer.current = window.setTimeout(() => {
          fitRefRetryTimer.current = null;
          fitToContainer({
            attempt: attempt + 1,
            skipIfUnchanged,
            focusAfterFit,
          });
        }, FIT_REF_RETRY_DELAY_MS);
        return;
      }
      clearFitRefRetryTimer();
      view.fitToContainer({ skipIfUnchanged });
      if (!isTouch && focusAfterFit) {
        view.focus();
      }
    },
    [clearFitRefRetryTimer, isController, isTab, isTouch],
  );

  useEffect(() => clearFitRefRetryTimer, [clearFitRefRetryTimer]);

  // A terminal sized by another device — a phone that typed into it, since
  // typing claims control and control carries size — shows up on a desk as
  // a strip in a black field, with nothing saying why. Measure the pane and,
  // when the terminal is well under what would fit, say so and offer the
  // fit; the fit claims control first when this device does not hold it.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = contentRef.current;
    if (!node || !isTab || isCompact || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setPaneSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isTab, isCompact]);
  const wouldFit = paneSize
    ? estimateInitialTerminalDimensions(paneSize.width, paneSize.height)
    : null;
  const sizedElsewhere =
    isTab &&
    !isCompact &&
    terminal.reachable &&
    wouldFit !== null &&
    (terminal.cols < wouldFit.cols * 0.6 || terminal.rows < wouldFit.rows * 0.6);
  const [fitAfterControl, setFitAfterControl] = useState(false);
  useEffect(() => {
    if (!fitAfterControl || !isController) return;
    setFitAfterControl(false);
    fitToContainer({ focusAfterFit: true });
  }, [fitAfterControl, fitToContainer, isController]);
  const handleFitHere = useCallback(() => {
    if (isController) {
      fitToContainer({ focusAfterFit: true });
      return;
    }
    if (!onRequestControl) return;
    setFitAfterControl(true);
    onRequestControl(terminal.machine_id);
  }, [fitToContainer, isController, onRequestControl, terminal.machine_id]);

  useImperativeHandle(ref, () => ({
    fitToContainer: (opts) => {
      fitToContainer(opts);
    },
    focus: () => {
      termViewRef.current?.focus();
    },
    blur: () => {
      termViewRef.current?.blur();
    },
    sendInput: (data: string) => {
      termViewRef.current?.sendInput(data);
    },
  }), [fitToContainer]);

  useEffect(() => {
    if (canType) {
      return;
    }
    setKeyboardVisible(false);
  }, [canType]);

  // ExtendedKeyBar prevents pointer/mouse focus changes itself. Never focus
  // here: the OS may have dismissed its keyboard while keyboardVisible still
  // reflects the last toggle, and refocusing would unexpectedly reopen it.
  const handleToolbarKey = useCallback((data: string) => {
    if (!canType) return;
    termViewRef.current?.sendCommandInput(modifiers.transform(data));
  }, [canType, modifiers.transform]);

  const handleAttachFile = useCallback(async (file: File) => {
    if (!canType) throw new Error("Unlock view only to attach a file.");
    const view = termViewRef.current;
    if (!view) throw new Error("Reconnect to the terminal before attaching a file.");
    await view.sendImageFile(file);
  }, [canType]);

  const handleToggleKeyboard = useCallback(() => {
    if (!canType) return;
    const nextVisible = !keyboardVisible;
    setKeyboardVisible(nextVisible);
    if (nextVisible) {
      termViewRef.current?.focus();
    } else {
      termViewRef.current?.blur();
    }
  }, [canType, keyboardVisible]);

  const handleEnterSelectMode = useCallback(() => {
    if (!canType) return;
    // Snapshot the visible viewport BEFORE we touch focus or mouse modes
    // so we render exactly what was on screen when the user tapped.
    const snapshot = termViewRef.current?.getSelectionSnapshot() ?? null;
    if (!snapshot) return;
    termViewRef.current?.setMouseTrackingEnabled(false);
    // Drop focus so the soft keyboard retreats and the user has the
    // whole terminal area free for the long-press gesture.
    termViewRef.current?.blur();
    setKeyboardVisible(false);
    setSelectSnapshot(snapshot);
    setSelectMode(true);
  }, [canType]);

  const handleExitSelectMode = useCallback(() => {
    termViewRef.current?.setMouseTrackingEnabled(true);
    setSelectMode(false);
    setSelectSnapshot(null);
    if (typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const handleCopySelection = useCallback(async () => {
    // Pull from the browser's native selection (the user dragged on the
    // overlay) rather than xterm.getSelection() — xterm has no idea what
    // was selected because the overlay sits above its canvas.
    const text =
      typeof window !== "undefined"
        ? window.getSelection()?.toString() ?? ""
        : "";
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[offdesk] clipboard write failed", err);
      }
    }
    handleExitSelectMode();
    return text;
  }, [handleExitSelectMode]);

  const handleCardClick = useCallback(() => {
    if (!isTab) onSelectTab(terminal.id);
  }, [isTab, onSelectTab, terminal.id]);

  const wsUrl = terminal.reachable
    ? terminalWsUrl(terminal.machine_id, terminal.id, deviceId)
    : null;
  const handleMobileViewportRefit = useCallback(() => {
    fitToContainer({
      skipIfUnchanged: true,
      focusAfterFit: false,
    });
  }, [fitToContainer]);
  const handleMobileViewportScroll = useCallback(() => {
    termViewRef.current?.scrollToBottom();
  }, []);


  return (
    <div
      data-testid={`terminal-card-${terminal.id}`}
      style={
        isTab
          ? {
              flex: 1,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column" as const,
              background: colors.surface,
              position: "relative" as const,
            }
          : {
              position: "relative" as const,
              background: colors.surface,
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column" as const,
              transition: "border-color 0.2s",
            }
      }
      onMouseEnter={(e) => {
        if (!isTab)
          e.currentTarget.style.borderColor = colors.accent;
      }}
      onMouseLeave={(e) => {
        if (!isTab)
          e.currentTarget.style.borderColor = colors.border;
      }}
    >
      {isTouch && isTab && (
        <MobileViewportTerminalSync
          isActive={isActive}
          isController={isController}
          onRefit={handleMobileViewportRefit}
          onScrollToBottom={handleMobileViewportScroll}
        />
      )}
      {!terminal.reachable && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 0.6)",
            zIndex: 10,
            borderRadius: "inherit",
            pointerEvents: "all",
          }}
        >
          <span style={{ color: terminalTheme.foreground, fontSize: 14 }}>
            Waiting for reconnection…
          </span>
        </div>
      )}

      {reconnectIndicatorActive &&
        (eventsReconnecting || terminalReconnecting) && (
          <>
            <div
              data-testid="reconnect-indicator-bar"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 2,
                overflow: "hidden",
                zIndex: 20,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: "38%",
                  height: "100%",
                  background: colors.accent,
                  animation: "offdeskReconnect 1.1s ease-in-out infinite",
                }}
              />
            </div>
            <div
              data-testid="reconnect-indicator-chip"
              style={{
                position: "absolute",
                top: 8,
                right: 10,
                zIndex: 20,
                pointerEvents: "none",
                padding: "3px 7px",
                borderRadius: 999,
                background: "rgba(20, 20, 24, 0.88)",
                border: `1px solid ${colors.border}`,
                color: terminalTheme.foreground,
                fontSize: 10,
              }}
            >
              Reconnecting…
            </div>
          </>
        )}

      {/* Mobile controls (Stop Control / Fit / Controlling indicator)
          used to live here as a separate row, but they duplicated the
          workspace chrome — the ctrl pill in the mobile workspace top bar
          now toggles control, and the Fit icon lives there too. The
          keybar's accent-tinted buttons already signal "Controlling". */}

      {/* Card mode: title bar */}
      {!isTab && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.bg1,
            cursor: "pointer",
          }}
          onClick={handleCardClick}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isController) return;
                onDestroy(terminal);
              }}
              style={{
                background: "none",
                border: "none",
                color: isController ? colors.danger : colors.foregroundMuted,
                cursor: isController ? "pointer" : "not-allowed",
                padding: isCompact ? "10px 12px" : "2px 4px",
                display: "flex",
                alignItems: "center",
                opacity: isController ? 0.6 : 0.3,
              }}
              onMouseEnter={(e) => {
                if (isController) e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = isController ? "0.6" : "0.3";
              }}
              title={isController ? "Close terminal" : "View only - cannot close"}
              aria-label={isController ? "Close terminal" : "View only - cannot close"}
            >
              <X size={14} aria-hidden />
            </button>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
              minWidth: 0,
              flex: 1,
              marginLeft: 4,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colors.accent,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: colors.foreground,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayTerminalTitle(terminal)}
            </span>
          </div>
        </div>
      )}

      {/* Workpath label overlay — card mode only */}
      {!isTab && workpathLabel && (
        <div
          data-testid="terminal-card-workpath-label"
          style={{
            position: "absolute",
            top: 6,
            left: 8,
            fontSize: 9,
            color: colors.foregroundMuted,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          {workpathLabel}
        </div>
      )}

      {/* Terminal content */}
      <div
        style={isTab ? {
          flex: 1, display: "flex", flexDirection: "column" as const, overflow: "hidden", minHeight: 0,
        } : {
          aspectRatio: "5 / 3", overflow: "hidden", cursor: "pointer", position: "relative" as const,
        }}
        onClick={isTab ? undefined : handleCardClick}
      >
        <div style={isTab ? {
          flex: 1, display: "flex", overflow: "hidden", minHeight: 0,
        } : {
          width: "100%", height: "100%", pointerEvents: "none" as const, overflow: "hidden",
        }}>
          <div ref={contentRef} style={isTab ? {
            flex: 1, padding: "8px 10px", overflow: "hidden", background: terminalTheme.background,
            position: "relative" as const,
          } : {
            width: "100%", height: "100%",
          }}>
            {sizedElsewhere && (
              <div
                data-testid="terminal-size-banner"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 10,
                  zIndex: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px 6px 12px",
                  borderRadius: 8,
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                  color: colors.foregroundSecondary,
                  fontSize: 12,
                }}
              >
                <span>
                  Sized by another device · {terminal.cols}×{terminal.rows}
                </span>
                <button
                  type="button"
                  onClick={handleFitHere}
                  disabled={!isController && !onRequestControl}
                  style={{
                    background: colors.accent,
                    border: "none",
                    borderRadius: 6,
                    color: colors.onAccent,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "4px 10px",
                  }}
                >
                  {isController ? "Fit to this window" : "Take control and fit"}
                </button>
              </div>
            )}
            {terminal.reachable && isTab ? (
              <Suspense
                fallback={<LazyLoadingFallback />}
              >
                <LiveTerminalView
                  key={terminal.id}
                  ref={termViewRef}
                  machineId={terminal.machine_id}
                  terminalId={terminal.id}
                  wsUrl={wsUrl!}
                  cols={terminal.cols}
                  rows={terminal.rows}
                  displayMode={isTab ? "immersive" : "card"}
                  isController={isController}
                  canType={canType}
                  canResizeTerminal={isTab && isController}
                  onReconnectingChange={setTerminalReconnecting}
                  inputTransformRef={inputTransformRef}
                />
              </Suspense>
            ) : !isTab ? (
              <TerminalPreviewText
                machineId={terminal.machine_id}
                terminalId={terminal.id}
                cols={terminal.cols}
                rows={terminal.rows}
                reachable={terminal.reachable}
                enabled={terminal.reachable}
                maxLines={8}
                maxLineWidth={160}
                lineHeightPx={15}
                padding={10}
              />
            ) : null}

            {/* Mobile select overlay — xterm renders to canvas so its
                text isn't selectable by touch (xterm.js #3727). When
                select mode is active we paint the visible viewport on
                top as a <pre>, where browser long-press selection works
                natively. The user drags handles, taps Copy, we read
                window.getSelection(). */}
            {isTab && isTouch && selectMode && selectSnapshot && (
              <pre
                ref={selectOverlayRef}
                className="terminal-select-overlay"
                data-testid="terminal-select-overlay"
                style={{
                  position: "absolute",
                  inset: 0,
                  margin: 0,
                  padding: "8px 10px",
                  background: terminalTheme.background,
                  color: terminalTheme.foreground,
                  fontFamily: selectSnapshot.fontFamily,
                  fontSize: selectSnapshot.fontSize,
                  // Slightly looser line-height so soft-wrapped lines
                  // are easier to read than xterm's compact 1.0.
                  lineHeight: 1.25,
                  // pre-wrap (not pre): preserve real \n separators but
                  // let the browser soft-wrap long logical lines so the
                  // overlay doesn't scroll sideways. Combined with
                  // overflow-wrap: anywhere so an unbroken token still
                  // wraps inside the viewport.
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  overflow: "auto",
                  zIndex: 6,
                  // Allow native long-press selection on touch devices —
                  // global CSS sets `touch-action: manipulation` on *,
                  // which we override here so the browser treats touches
                  // as potential selection gestures.
                  touchAction: "auto",
                  WebkitUserSelect: "text",
                  userSelect: "text",
                  WebkitTouchCallout: "default",
                  cursor: "text",
                }}
              >
                {selectSnapshot.lines.join("\n")}
              </pre>
            )}
          </div>
        </div>

        {/* Compact phone: inline key bar. Large+touch: portal into the
            workspace bottom slot so one bar operates on the focused pane. */}
        {isTab && (isCompact || isTouch) && (
          <TerminalKeyBarPortal target={!isCompact && isActive ? keyBarSlot : null} hidden={!isCompact && !isActive}>
            <ExtendedKeyBar onKey={handleToolbarKey} onToggleKeyboard={handleToggleKeyboard}
              onPasteText={text => {
                const view = termViewRef.current;
                if (!view) throw new Error("Reconnect to the terminal before pasting.");
                view.pasteText(text);
              }} onAttachFile={handleAttachFile}
              onEnterSelectMode={handleEnterSelectMode} onExitSelectMode={handleExitSelectMode} onCopySelection={handleCopySelection}
              selectMode={selectMode} keyboardVisible={keyboardVisible} isController={canType}
              ctrlArmed={modifiers.ctrlArmed} onToggleCtrl={modifiers.toggleCtrl}
              shiftArmed={modifiers.shiftArmed} onToggleShift={modifiers.toggleShift}
              onShiftPress={modifiers.pressShift} onShiftRelease={modifiers.releaseShift} />
          </TerminalKeyBarPortal>
        )}
      </div>

      {/* Footer - only in card mode */}
      {!isTab && (
        <div
          style={{
            padding: "2px 8px",
            borderTop: `1px solid ${colors.border}`,
            fontSize: 9,
            color: colors.foregroundMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {terminal.cwd}
        </div>
      )}
    </div>
  );
});

function MobileViewportTerminalSync({
  isActive,
  isController,
  onRefit,
  onScrollToBottom,
}: {
  isActive: boolean;
  isController: boolean;
  onRefit: () => void;
  onScrollToBottom: () => void;
}) {
  const viewportHeight = useVisualViewportHeight();
  const previousViewportHeightRef = useRef<number | null>(null);
  const viewportChangeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previousHeight = previousViewportHeightRef.current;
    previousViewportHeightRef.current = viewportHeight;
    const action = getMobileViewportTerminalAction({
      isMobile: true,
      isActive,
      isController,
      previousHeight,
      nextHeight: viewportHeight,
    });
    if (!action) return;

    if (viewportChangeTimerRef.current !== null) {
      window.clearTimeout(viewportChangeTimerRef.current);
    }
    viewportChangeTimerRef.current = window.setTimeout(() => {
      viewportChangeTimerRef.current = null;
      requestAnimationFrame(() => {
        if (action === "refit") onRefit();
        else onScrollToBottom();
      });
    }, MOBILE_VIEWPORT_SETTLE_MS);

    return () => {
      if (viewportChangeTimerRef.current !== null) {
        window.clearTimeout(viewportChangeTimerRef.current);
        viewportChangeTimerRef.current = null;
      }
    };
  }, [isActive, isController, onRefit, onScrollToBottom, viewportHeight]);

  return null;
}

function areTerminalCardPropsEqual(
  previous: TerminalCardProps,
  next: TerminalCardProps,
): boolean {
  return (
    previous.terminal === next.terminal &&
    previous.displayMode === next.displayMode &&
    previous.isCompact === next.isCompact &&
    previous.isTouch === next.isTouch &&
    previous.isActive === next.isActive &&
    previous.isController === next.isController &&
    previous.canType === next.canType &&
    previous.eventsReconnecting === next.eventsReconnecting &&
    previous.reconnectIndicatorActive === next.reconnectIndicatorActive &&
    previous.deviceId === next.deviceId &&
    previous.workpathLabel === next.workpathLabel &&
    previous.onSelectTab === next.onSelectTab &&
    previous.onDestroy === next.onDestroy &&
    previous.onRequestControl === next.onRequestControl &&
    previous.onReleaseControl === next.onReleaseControl
  );
}

export const TerminalCard = memo(TerminalCardComponent, areTerminalCardPropsEqual);

function TerminalKeyBarPortal({ target, hidden, children }: { target: HTMLElement | null; hidden: boolean; children: import("react").ReactNode }) {
  const content = <div hidden={hidden} style={{ flexShrink: 0, minWidth: 0 }}>{children}</div>;
  return target ? createPortal(content, target) : content;
}
