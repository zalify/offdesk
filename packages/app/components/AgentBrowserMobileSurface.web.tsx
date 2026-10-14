import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBrowserInfo } from "@offdesk/shared";
import { AgentBrowserMobileView } from "./AgentBrowserMobileView.web";
import {
  browserControlledBy,
  browserLabel,
  browserNeedsPerson,
} from "@/lib/agentBrowserOverlay";
import { colors, colorAlpha } from "@/lib/colors";
import { useAgentBrowserTabs } from "@/lib/useAgentBrowserTabs";

const iconButton = {
  width: 40,
  height: 40,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  background: "transparent",
  color: colors.fg2,
  fontFamily: "var(--font-display)",
  cursor: "pointer",
} as const;

// The phone's browser: a full-screen surface over the terminal area (the
// terminals underneath stay mounted) with a back button, a scrolling tab strip
// of the machine's agent browsers, a "+" address field, and the selected tab's
// AgentBrowserMobileView below. Browsers are machine-wide, so they live here
// and not among the terminal sessions.
export function AgentBrowserMobileSurface({
  machineId,
  browsers,
  selectedId: rememberedId,
  deviceId,
  onSelect,
  onClose,
}: {
  machineId: string;
  browsers: AgentBrowserInfo[];
  /** The tab the person last picked on this machine; may be gone by now. */
  selectedId: string | null;
  deviceId: string | null;
  onSelect: (browserId: string) => void;
  onClose: () => void;
}) {
  const {
    selectedBrowserId,
    selected,
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

  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || browsers.length === 0) return;
    event.preventDefault();
    setAdding(false);
    setError(null);
  };

  return (
    <div
      data-testid="mobile-agent-browser-surface"
      // The surface takes its own touches; edge swipes do not switch terminals.
      data-edge-swipe="off"
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
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px",
          background: colors.bg0,
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
          fontFamily: "var(--font-display)",
        }}
      >
        <button
          type="button"
          data-testid="mobile-agent-browser-surface-back"
          aria-label="Back to terminals"
          title="Back to terminals"
          onClick={onClose}
          style={{ ...iconButton, fontSize: 15 }}
        >
          ←
        </button>
        <div
          role="tablist"
          aria-label="Browser tabs"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            overscrollBehaviorX: "contain",
          }}
        >
          {browsers.map((browser, index) => {
            const active = browser.id === selectedBrowserId;
            const label = browserLabel(browser);
            const closing = closingIds.has(browser.id);
            return (
              <div
                key={browser.id}
                role="tab"
                aria-selected={active}
                data-testid={`mobile-browser-tab-${browser.id}`}
                data-selected={active ? "true" : "false"}
                title={browser.url}
                onClick={() => onSelect(browser.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                  maxWidth: 200,
                  minHeight: 32,
                  padding: "0 2px 0 10px",
                  borderRadius: 3,
                  border: `1px solid ${active ? "transparent" : colors.line}`,
                  background: active ? colors.primary : "transparent",
                  color: active ? colors.onPrimary : colors.fg2,
                  fontWeight: active ? 600 : 500,
                  fontSize: 12,
                  opacity: closing ? 0.5 : 1,
                  cursor: "pointer",
                }}
              >
                <span aria-hidden style={{ flexShrink: 0 }}>{index}:</span>
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                {browserNeedsPerson(browser) && (
                  <span
                    role="img"
                    aria-label="The agent needs you"
                    data-testid={`mobile-browser-tab-attention-${browser.id}`}
                    style={{ color: active ? colors.onPrimary : colors.err, flexShrink: 0 }}
                  >
                    !
                  </span>
                )}
                {browserControlledBy(browser, deviceId) && (
                  <span
                    style={{
                      fontSize: 10.5,
                      padding: "0 5px",
                      border: `1px solid ${active ? colors.onPrimary : colors.line}`,
                      borderRadius: 3,
                      color: active ? colors.onPrimary : colors.accent,
                      flexShrink: 0,
                    }}
                  >
                    you
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`mobile-browser-tab-close-${browser.id}`}
                  aria-label={`Close ${label}`}
                  title="Close tab"
                  disabled={closing}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(browser);
                  }}
                  style={{ ...iconButton, width: 32, height: 32, fontSize: 11, color: active ? colors.onPrimary : colors.fg3 }}
                >
                  [x]
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          data-testid="mobile-browser-new-tab"
          aria-label="New tab"
          title="New tab"
          onClick={() => {
            setAdding((value) => !value);
            setError(null);
          }}
          style={{ ...iconButton, fontSize: 13, color: colors.fg0 }}
        >
          [+]
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
            borderBottom: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            flexShrink: 0,
          }}
        >
          <input
            data-testid="mobile-browser-url-input"
            aria-label="Web address"
            // Keep the keyboard off the terminal's tab while nothing is open.
            autoFocus
            // Native URL validation rejects bare hosts before submit can add a scheme.
            type="text"
            inputMode="url"
            enterKeyHint="go"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={onAddressKeyDown}
            placeholder="a web address, e.g. example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={opening}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 40,
              padding: "0 12px",
              fontFamily: "var(--font-display)",
              fontSize: 16,
              color: colors.fg0,
              background: colors.bg0,
              border: `1px solid ${colors.line}`,
              borderRadius: 4,
              outline: "none",
            }}
          />
          <button
            type="submit"
            data-testid="mobile-browser-url-submit"
            disabled={opening}
            style={{
              minHeight: 40,
              fontFamily: "var(--font-display)",
              fontSize: 13,
              fontWeight: 600,
              padding: "0 14px",
              borderRadius: 4,
              border: "none",
              background: colors.primary,
              color: colors.onPrimary,
              cursor: opening ? "default" : "pointer",
              opacity: opening ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {opening ? "opening…" : "open"}
          </button>
        </form>
      )}
      {error && (
        <div
          role="alert"
          data-testid="mobile-browser-surface-error"
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

      {selected ? (
        <AgentBrowserMobileView key={selected.id} browser={selected} />
      ) : (
        <div
          data-testid="mobile-browser-surface-empty"
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            color: colors.fg3,
            fontSize: 13,
          }}
        >
          {awaitingId !== null || opening
            ? "Opening…"
            : "No browser tabs on this machine"}
        </div>
      )}
    </div>
  );
}
