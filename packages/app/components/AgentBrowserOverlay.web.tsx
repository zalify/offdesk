import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBrowserInfo, TerminalInfo } from "@offdesk/shared";
import { Globe, Plus, X } from "lucide-react";
import { controlAgentBrowser } from "@/lib/api";
import { AgentBrowserPane } from "./AgentBrowserPane.web";
import {
  browserControlledBy,
  browserIsPrivate,
  browserLabel,
  browserNeedsPerson,
  browserOwnerLabel,
  miniBrowserStatus,
} from "@/lib/agentBrowserOverlay";
import { colors, colorAlpha } from "@/lib/colors";
import { useAgentBrowserTabs } from "@/lib/useAgentBrowserTabs";
import { rem } from "@/lib/rem";

/** Distance of the mini window from the bottom edge: clears the status bar and the background-shelf bar above it. */
export const MINI_BOTTOM = 72;

const miniTextButton = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
} as const;

const iconButton = {
  background: "none",
  border: "none",
  color: colors.foregroundMuted,
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  borderRadius: 4,
} as const;

/** Canvas area of the mini window: 16:10, the ratio of the 1280x800 viewport. */
export const MINI_CANVAS_WIDTH = 320;
export const MINI_CANVAS_HEIGHT = 200;
/** Height of the mini window's status line (plus its border). */
export const MINI_STATUS_HEIGHT = 28;
/** Total height of the mini window, borders included. */
export const MINI_TOTAL_HEIGHT = MINI_CANVAS_HEIGHT + MINI_STATUS_HEIGHT + 2;

// A floating panel over the workspace with one tab per agent browser of the
// machine, like a browser window. The workspace underneath stays mounted, so
// its terminals keep their connections. Only the selected tab streams; the
// body is AgentBrowserPane, which owns take over / hand back and input
// forwarding.
//
// `mini` shrinks the same mounted tree into a read-only picture-in-picture
// window (bottom-right, no backdrop) so the stream and its WebSocket survive
// minimising; only the container styling and the chrome around the pane change.
export function AgentBrowserOverlay({
  machineId,
  machineName,
  browsers,
  selectedId: rememberedId,
  deviceId,
  terminals,
  activeTerminalId = null,
  onSelect,
  onClose,
  mini = false,
  miniBottom = MINI_BOTTOM,
  onMinimize,
  onExpand,
}: {
  machineId: string;
  machineName: string;
  browsers: AgentBrowserInfo[];
  /** The tab the person last picked on this machine; may be gone by now. */
  selectedId: string | null;
  deviceId: string | null;
  /** Terminals of the workspace; an opener's name labels its tabs. */
  terminals: readonly TerminalInfo[];
  /** The focused terminal; its browser is picked when the shown tab goes away. */
  activeTerminalId?: string | null;
  onSelect: (browserId: string) => void;
  onClose: () => void;
  /** Show as the small read-only window instead of the dialog. */
  mini?: boolean;
  /** Distance of the mini window from the bottom edge. */
  miniBottom?: number;
  onMinimize: () => void;
  onExpand: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const {
    selectedBrowserId,
    selected,
    controlling,
    showForm,
    setAdding,
    address,
    setAddress,
    opening,
    error,
    setError,
    closingIds,
    awaitingId,
    submit,
    closeTab,
  } = useAgentBrowserTabs({
    machineId,
    browsers,
    rememberedId,
    deviceId,
    activeTerminalId,
    onSelect,
  });

  // Expanded: take focus off whatever is below (an xterm would keep eating
  // keystrokes). Mini and close give it back; the mini never takes focus.
  const previousFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!panelRef.current?.contains(active) && active !== document.body) {
      previousFocusRef.current = active;
    }
    if (mini) return;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const previous = previousFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [mini]);

  // Esc closes the overlay, except while this device controls the page: then
  // Esc belongs to the page (the pane already swallows it; this is the guard
  // for focus sitting elsewhere in the overlay).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (mini || controlling) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mini, controlling, onClose]);

  const [handBackBusy, setHandBackBusy] = useState(false);
  // The mini keeps control when minimised; hand back without expanding.
  const handBack = async () => {
    if (!selected || deviceId === null) return;
    setHandBackBusy(true);
    try {
      await controlAgentBrowser(machineId, selected.id, {
        action: "release",
        device_id: deviceId,
      });
    } catch {
      // The status line keeps saying "you in control", so the person can retry.
    } finally {
      setHandBackBusy(false);
    }
  };
  const status = selected ? miniBrowserStatus(selected, deviceId) : null;
  const selectedOwner = selected ? browserOwnerLabel(selected, terminals) : null;

  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    // With tabs open Esc only folds the field away; with none it closes the
    // overlay like anywhere else.
    if (browsers.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setAdding(false);
      setError(null);
    }
  };

  return (
    <div
      data-testid={mini ? undefined : "agent-browser-overlay-backdrop"}
      onMouseDown={(event) => {
        if (!mini && event.target === event.currentTarget) onClose();
      }}
      style={
        mini
          ? { position: "fixed", right: 16, bottom: miniBottom, zIndex: 56 }
          : {
              position: "fixed",
              inset: 0,
              zIndex: 900,
              background: colorAlpha.overlay,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }
      }
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Browser on ${machineName}`}
        data-testid={mini ? "agent-browser-mini" : "agent-browser-overlay"}
        data-mini={mini ? "true" : "false"}
        tabIndex={-1}
        // The mini never steals focus from the terminal under it.
        onMouseDown={mini ? (event) => event.preventDefault() : undefined}
        style={{
          width: mini ? MINI_CANVAS_WIDTH + 2 : "min(92vw, 1400px)",
          height: mini ? MINI_TOTAL_HEIGHT : "min(86vh, 900px)",
          display: "flex",
          flexDirection: "column",
          background: colors.bg1,
          color: colors.fg0,
          border: `1px solid ${mini && status?.tone === "needsYou" ? colors.err : colors.line}`,
          borderRadius: 6,
          boxShadow: mini ? "0 8px 24px rgb(0 0 0 / 0.4)" : "0 24px 64px rgb(0 0 0 / 0.45)",
          fontFamily: "var(--font-display)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        {!mini && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            gap: 4,
            height: 36,
            padding: "0 8px",
            borderBottom: `1px solid ${colors.lineSoft}`,
            flexShrink: 0,
          }}
        >
          <div
            role="tablist"
            aria-label="Browser tabs"
            style={{
              display: "flex",
              alignItems: "stretch",
              minWidth: 0,
              overflowX: "auto",
            }}
          >
            {browsers.map((browser, index) => {
              const active = browser.id === selectedBrowserId;
              const label = browserLabel(browser);
              const needsYou = browserNeedsPerson(browser);
              const mine = browserControlledBy(browser, deviceId);
              const owner = browserOwnerLabel(browser, terminals);
              const closing = closingIds.has(browser.id);
              return (
                <div
                  key={browser.id}
                  role="tab"
                  aria-selected={active}
                  data-testid={`agent-browser-tab-${browser.id}`}
                  data-selected={active ? "true" : "false"}
                  title={browser.url}
                  onClick={() => onSelect(browser.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    maxWidth: 260,
                    padding: "0 6px 0 12px",
                    borderBottom: `2px solid ${active ? colors.accent : "transparent"}`,
                    boxSizing: "border-box",
                    color: active ? colors.fg0 : colors.fg3,
                    cursor: "pointer",
                    fontSize: rem(12.5),
                    flexShrink: 0,
                    opacity: closing ? 0.5 : 1,
                  }}
                >
                  {needsYou && (
                    <span
                      role="img"
                      aria-label="The agent needs you"
                      title="The agent needs you"
                      data-testid={`agent-browser-tab-attention-${browser.id}`}
                      style={{ color: colors.err, flexShrink: 0 }}
                    >
                      !
                    </span>
                  )}
                  <span aria-hidden style={{ flexShrink: 0 }}>{index}:</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </span>
                  {owner && (
                    <span
                      data-testid={`agent-browser-tab-owner-${browser.id}`}
                      title={`Opened by ${owner}`}
                      style={{
                        fontSize: rem(10.5),
                        maxWidth: 90,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: colors.fg3,
                        flexShrink: 1,
                      }}
                    >
                      {owner}
                    </span>
                  )}
                  {browserIsPrivate(browser) && (
                    <span
                      data-testid="agent-browser-tab-private"
                      title="Private browser: separate from the machine's logins"
                      style={{ fontSize: rem(10.5), color: colors.fg3, flexShrink: 0 }}
                    >
                      [private]
                    </span>
                  )}
                  {mine && (
                    <span
                      data-testid={`agent-browser-tab-you-${browser.id}`}
                      style={{
                        fontSize: rem(10.5),
                        padding: "0 5px",
                        border: `1px solid ${colors.line}`,
                        borderRadius: 3,
                        color: colors.accent,
                        flexShrink: 0,
                      }}
                    >
                      you
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid={`agent-browser-tab-close-${browser.id}`}
                    aria-label={`Close ${label}`}
                    title="Close tab"
                    disabled={closing}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(browser);
                    }}
                    className="odk-text-btn"
                    style={{ minHeight: 24, padding: "0 4px", fontSize: rem(12), flexShrink: 0 }}
                  >
                    [x]
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            data-testid="agent-browser-new-tab"
            aria-label="New tab"
            title="New tab"
            onClick={() => {
              setAdding((value) => !value);
              setError(null);
            }}
            className="odk-text-btn"
            style={{ alignSelf: "center", flexShrink: 0 }}
          >
            [+]
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="agent-browser-overlay-minimize"
            aria-label="Minimise browser"
            title="Minimise"
            onClick={onMinimize}
            className="odk-text-btn"
            style={{ alignSelf: "center", flexShrink: 0 }}
          >
            [_]
          </button>
          <button
            type="button"
            data-testid="agent-browser-overlay-close"
            aria-label="Close browser"
            title="Close"
            onClick={onClose}
            className="odk-text-btn"
            style={{ alignSelf: "center", flexShrink: 0 }}
          >
            [esc]
          </button>
        </div>
        )}

        {!mini && showForm && (
          <form
            onSubmit={(event) => void submit(event)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderBottom: `1px solid ${colors.lineSoft}`,
              flexShrink: 0,
            }}
          >
            <input
              data-testid="agent-browser-url-input"
              aria-label="Web address"
              autoFocus
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={onAddressKeyDown}
              placeholder="a web address, e.g. example.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={opening}
              className="odk-input"
              style={{ flex: 1, minWidth: 0, height: 32, background: colors.bg0 }}
            />
            <button
              type="submit"
              data-testid="agent-browser-url-submit"
              disabled={opening}
              className="odk-btn odk-btn--primary odk-btn--sm"
              style={{ flexShrink: 0 }}
            >
              {opening ? "opening…" : "open"}
            </button>
          </form>
        )}
        {!mini && error && (
          <div
            role="alert"
            data-testid="agent-browser-overlay-error"
            style={{
              padding: "5px 10px",
              fontSize: rem(12),
              color: colors.err,
              borderBottom: `1px solid ${colors.lineSoft}`,
              flexShrink: 0,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            position: "relative",
          }}
        >
          {selected ? (
            <AgentBrowserPane key={selected.id} browser={selected} readOnly={mini} />
          ) : (
            <div
              data-testid="agent-browser-overlay-empty"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: colors.foregroundMuted,
                fontSize: rem(13),
              }}
            >
              {awaitingId !== null || opening
                ? "Opening…"
                : "No browser tabs on this machine"}
            </div>
          )}
          {mini && (
            <button
              type="button"
              data-testid="agent-browser-mini-expand"
              aria-label="Expand browser"
              title="Expand"
              onClick={onExpand}
              style={{
                position: "absolute",
                inset: 0,
                padding: 0,
                border: "none",
                background: "transparent",
                cursor: "pointer",
              }}
            />
          )}
        </div>
        {mini && (
          <div
            data-testid="agent-browser-mini-status"
            data-tone={status?.tone ?? "none"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: MINI_STATUS_HEIGHT,
              padding: "0 6px 0 8px",
              borderTop: `1px solid ${colors.lineSoft}`,
              fontSize: rem(11.5),
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <button
              type="button"
              data-testid="agent-browser-mini-label"
              onClick={onExpand}
              title={selected ? browserLabel(selected) : undefined}
              style={{
                ...miniTextButton,
                maxWidth: "40%",
                flexShrink: 1,
                color: colors.fg0,
              }}
            >
              {selected ? browserLabel(selected) : "No browser tabs"}
            </button>
            {selectedOwner && (
              <span
                data-testid="agent-browser-mini-owner"
                title={`Opened by ${selectedOwner}`}
                style={{
                  ...miniTextButton,
                  maxWidth: "30%",
                  flexShrink: 1,
                  color: colors.fg3,
                }}
              >
                {selectedOwner}
              </span>
            )}
            {selected && browserIsPrivate(selected) && (
              <span
                data-testid="agent-browser-tab-private"
                title="Private browser"
                style={{ color: colors.fg3, flexShrink: 0 }}
              >
                [private]
              </span>
            )}
            {status && (
              <span
                data-testid="agent-browser-mini-state"
                title={status.text}
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: status.tone === "you" ? 600 : 400,
                  color:
                    status.tone === "you"
                      ? colors.accent
                      : status.tone === "needsYou"
                        ? colors.err
                        : colors.fg3,
                }}
              >
                {status.text}
              </span>
            )}
            {!status && <span style={{ flex: 1 }} />}
            {status?.tone === "you" && (
              <button
                type="button"
                data-testid="agent-browser-mini-release"
                disabled={handBackBusy}
                onClick={() => void handBack()}
                className="odk-text-btn"
                style={{ minHeight: 22, padding: "0 4px", fontSize: rem(11.5), flexShrink: 0 }}
              >
                [hand back]
              </button>
            )}
            <button
              type="button"
              data-testid="agent-browser-mini-close"
              aria-label="Close browser"
              title="Close"
              onClick={onClose}
              className="odk-text-btn"
              style={{ minHeight: 22, padding: "0 4px", fontSize: rem(11.5), flexShrink: 0 }}
            >
              [x]
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
