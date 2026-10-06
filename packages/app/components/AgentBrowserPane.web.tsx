import type { AgentBrowserInfo } from "@offdesk/shared";
import { browserLabel } from "@/lib/terminalWorkspaceLayout";
import { colors, colorAlpha } from "@/lib/colors";

// Placeholder body for an agent-browser pane (title + URL). The next slice
// replaces it with the live screencast; the props are the contract.
export function AgentBrowserPane({
  browser,
  isActive,
  focusRing = true,
  onFocus,
}: {
  browser: AgentBrowserInfo;
  isActive: boolean;
  focusRing?: boolean;
  onFocus: (id: string) => void;
}) {
  return (
    <div
      data-testid="agent-browser-pane"
      data-browser-id={browser.id}
      onMouseDown={() => onFocus(browser.id)}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
        padding: 12,
        boxSizing: "border-box",
        background: colors.bg0,
        color: colors.fg0,
        border: `1px solid ${
          isActive && focusRing ? colorAlpha.accentLine : colors.line
        }`,
        boxShadow:
          isActive && focusRing ? `0 0 0 1px ${colorAlpha.accentLine}` : "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {browserLabel(browser)}
      </div>
      <div
        style={{
          color: colors.fg2,
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {browser.url}
      </div>
    </div>
  );
}
