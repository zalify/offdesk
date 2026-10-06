import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBrowserInfo } from "@offdesk/shared";
import { Globe, Plus, X } from "lucide-react";
import { AgentBrowserPane } from "./AgentBrowserPane.web";
import {
  browserControlledBy,
  browserLabel,
  browserNeedsPerson,
} from "@/lib/agentBrowserOverlay";
import { colors, colorAlpha } from "@/lib/colors";
import { useAgentBrowserTabs } from "@/lib/useAgentBrowserTabs";

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

// A floating panel over the workspace with one tab per agent browser of the
// machine, like a browser window. The workspace underneath stays mounted, so
// its terminals keep their connections. Only the selected tab streams; the
// body is AgentBrowserPane, which owns take over / hand back and input
// forwarding.
export function AgentBrowserOverlay({
  machineId,
  machineName,
  browsers,
  selectedId: rememberedId,
  deviceId,
  onSelect,
  onClose,
}: {
  machineId: string;
  machineName: string;
  browsers: AgentBrowserInfo[];
  /** The tab the person last picked on this machine; may be gone by now. */
  selectedId: string | null;
  deviceId: string | null;
  onSelect: (browserId: string) => void;
  onClose: () => void;
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
    onSelect,
  });

  // Take focus off whatever is below (an xterm would keep eating keystrokes)
  // and give it back on close.
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  // Esc closes the overlay, except while this device controls the page: then
  // Esc belongs to the page (the pane already swallows it; this is the guard
  // for focus sitting elsewhere in the overlay).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (controlling) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controlling, onClose]);

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
      data-testid="agent-browser-overlay-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: colorAlpha.backgroundShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Browser on ${machineName}`}
        data-testid="agent-browser-overlay"
        tabIndex={-1}
        style={{
          width: "min(92vw, 1400px)",
          height: "min(86vh, 900px)",
          display: "flex",
          flexDirection: "column",
          background: colors.bg0,
          color: colors.fg0,
          border: `1px solid ${colors.line}`,
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.35)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 8px",
            background: colors.bg1,
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
        >
          <div
            role="tablist"
            aria-label="Browser tabs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
              overflowX: "auto",
            }}
          >
            {browsers.map((browser) => {
              const active = browser.id === selectedBrowserId;
              const label = browserLabel(browser);
              const needsYou = browserNeedsPerson(browser);
              const mine = browserControlledBy(browser, deviceId);
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
                    gap: 6,
                    maxWidth: 220,
                    minWidth: 100,
                    padding: "5px 6px 5px 10px",
                    borderRadius: 6,
                    border: `1px solid ${active ? colorAlpha.accentLine : "transparent"}`,
                    background: active ? colors.bg0 : "transparent",
                    color: active ? colors.fg0 : colors.fg2,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    opacity: closing ? 0.5 : 1,
                  }}
                >
                  <Globe
                    size={12}
                    aria-hidden
                    style={{ flexShrink: 0, color: active ? colors.accent : colors.fg3 }}
                  />
                  {needsYou && (
                    <span
                      role="img"
                      aria-label="The agent needs you"
                      title="The agent needs you"
                      data-testid={`agent-browser-tab-attention-${browser.id}`}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: colors.warn,
                        flexShrink: 0,
                      }}
                    />
                  )}
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
                  {mine && (
                    <span
                      data-testid={`agent-browser-tab-you-${browser.id}`}
                      style={{
                        fontSize: 9,
                        padding: "0 5px",
                        borderRadius: 999,
                        background: colorAlpha.accentSoft,
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
                    style={{ ...iconButton, padding: 2, flexShrink: 0 }}
                  >
                    <X size={12} aria-hidden />
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
            style={{ ...iconButton, color: colors.fg2, flexShrink: 0 }}
          >
            <Plus size={16} aria-hidden />
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="agent-browser-overlay-close"
            aria-label="Close browser"
            title="Close"
            onClick={onClose}
            style={{ ...iconButton, color: colors.fg2, flexShrink: 0 }}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {showForm && (
          <form
            onSubmit={(event) => void submit(event)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderBottom: `1px solid ${colors.border}`,
              background: colors.bg1,
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
              placeholder="Enter a web address, e.g. example.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={opening}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "6px 10px",
                fontSize: 13,
                color: colors.foreground,
                background: colors.bg0,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                outline: "none",
              }}
            />
            <button
              type="submit"
              data-testid="agent-browser-url-submit"
              disabled={opening}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: colors.accent,
                color: colors.onAccent,
                cursor: opening ? "default" : "pointer",
                opacity: opening ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {opening ? "Opening…" : "Open"}
            </button>
          </form>
        )}
        {error && (
          <div
            role="alert"
            data-testid="agent-browser-overlay-error"
            style={{
              padding: "5px 10px",
              fontSize: 12,
              color: colors.danger,
              borderBottom: `1px solid ${colors.border}`,
              flexShrink: 0,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {selected ? (
            <AgentBrowserPane key={selected.id} browser={selected} />
          ) : (
            <div
              data-testid="agent-browser-overlay-empty"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: colors.foregroundMuted,
                fontSize: 13,
              }}
            >
              {awaitingId !== null || opening
                ? "Opening…"
                : "No browser tabs on this machine"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
