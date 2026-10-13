import { useEffect, useRef, useState } from "react";
import { sendAttentionEnter } from "@/lib/attentionEnter";
import type { AgentBrowserInfo, MachineInfo, TerminalInfo } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { browserLabel } from "@/lib/agentBrowserOverlay";

const NO_BROWSERS: AgentBrowserInfo[] = [];

export function MobileTerminalAttention({ terminals, machines, activeTerminalId, groupLabels, onPick, deviceId, canSend, browsers = NO_BROWSERS, activeBrowserId = null, onPickBrowser }: {
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeTerminalId: string | null;
  groupLabels: Map<string, string>;
  onPick: (id: string) => void;
  deviceId: string | null;
  canSend: (machineId: string) => boolean;
  /** Agent browsers of the active machine; a pending handoff asks for a person. */
  browsers?: AgentBrowserInfo[];
  activeBrowserId?: string | null;
  onPickBrowser?: (id: string) => void;
}) {
  const pending = terminals.filter(t => t.id !== activeTerminalId && t.reachable && t.attention === "confirmation"
    && machines.some(m => m.id === t.machine_id));
  // A browser the agent handed off, that this device is not already helping with.
  const handoffs = browsers.filter(b => b.handoff && b.id !== activeBrowserId
    && !(b.controller === "human" && b.controller_device_id === deviceId));
  const live = useRef({ pending, canSend, deviceId });
  live.current = { pending, canSend, deviceId };
  const requests = useRef(new Map<string, AbortController>());
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<Record<string, "sent" | "check">>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
  }, []);
  useEffect(() => {
    const ids = new Set(terminals.filter(t => t.reachable && t.attention === "confirmation").map(t => t.id));
    setSent(previous => [...previous].some(id => !ids.has(id))
      ? new Set([...previous].filter(id => ids.has(id))) : previous);
    setResult(previous => Object.keys(previous).some(id => !ids.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))) : previous);
  }, [terminals]);
  const enter = async (terminal: TerminalInfo) => {
    if (sent.has(terminal.id) || requests.current.has(terminal.id) || !deviceId) return;
    const controller = new AbortController();
    requests.current.set(terminal.id, controller);
    setSent(previous => new Set(previous).add(terminal.id));
    setError(null);
    setResult(previous => { const next = { ...previous }; delete next[terminal.id]; return next; });
    try {
      await sendAttentionEnter({ machineId: terminal.machine_id, terminalId: terminal.id, deviceId,
        signal: controller.signal,
        isAllowed: () => live.current.deviceId === deviceId && live.current.canSend(terminal.machine_id)
          && live.current.pending.some(t => t.id === terminal.id && t.machine_id === terminal.machine_id),
      });
      if (!controller.signal.aborted) setResult(previous => ({ ...previous, [terminal.id]: "sent" }));
    } catch (reason) {
      if (!controller.signal.aborted) setResult(previous => ({ ...previous, [terminal.id]: "check" }));
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Open the terminal to check.");
    } finally { requests.current.delete(terminal.id); }
    // Keep disabled until the prompt clears, even after an uncertain delivery.
  };
  const waiting = pending.length + handoffs.length;
  if (waiting === 0) return null;
  return (
    <nav aria-label="Sessions needing attention" data-testid="mobile-terminal-attention"
      style={{ flexShrink: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${colors.lineSoft}`, background: colors.bg1, minWidth: 0, fontFamily: "var(--font-display)" }}>
      <span role="status" className="odk-badge" style={{ fontSize: 11.5 }}>
        {waiting} waiting
      </span>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", minWidth: 0, flex: 1, overscrollBehaviorX: "contain" }}>
        {handoffs.map(browser => {
          const title = browserLabel(browser);
          const reason = browser.handoff?.reason ?? "";
          return (
            <button key={browser.id} type="button" data-testid={`mobile-attention-browser-${browser.id}`}
              aria-label={`Open browser ${title}, the agent needs you: ${reason}`}
              title={`${title} — the agent needs you: ${reason}`}
              onClick={() => onPickBrowser?.(browser.id)}
              style={{ ...chip, padding: "0 10px", color: colors.fg2 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>browser · {title}</span>
              <span data-testid={`mobile-attention-browser-reason-${browser.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", color: colors.fg3, maxWidth: 120 }}>{reason}</span>
            </button>
          );
        })}
        {pending.map(terminal => {
          const title = displayTerminalTitle(terminal);
          const machine = machines.find(m => m.id === terminal.machine_id)?.name;
          const group = groupLabels.get(terminal.id) ?? terminal.cwd.split(/[\\/]/).filter(Boolean).pop();
          const context = [group, machine].filter(Boolean).join(" · ");
          const blocked = !deviceId || !canSend(terminal.machine_id) || sent.has(terminal.id);
          return (
            <div key={terminal.id} style={{ ...chip, padding: "0 3px 0 0" }}>
              <button type="button" data-testid={`mobile-attention-${terminal.id}`}
                aria-label={`Open ${title}, ${context}, confirmation requested`}
                title={`${title} · ${context} — confirmation requested`}
                onClick={() => onPick(terminal.id)}
                style={{ display: "flex", alignItems: "center", alignSelf: "stretch", maxWidth: 170, padding: "0 8px", border: 0, background: "transparent", color: colors.fg0, font: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{title} · {group ?? machine}</span>
              </button>
              <button type="button" data-testid={`mobile-attention-enter-${terminal.id}`}
                aria-label={`Send Enter to ${title}, ${context}`}
                title="Confirm the currently selected option in this terminal"
                disabled={blocked}
                onPointerDown={event => event.preventDefault()}
                onClick={() => void enter(terminal)}
                className="odk-bracketed"
                style={{ minWidth: 52, height: 30, padding: "0 8px", border: 0, borderRadius: 3, background: blocked ? "transparent" : colors.primary, color: blocked ? colors.fg3 : colors.onPrimary, font: "inherit", fontSize: 11, fontWeight: 600, textTransform: "lowercase", cursor: "pointer", opacity: blocked ? 0.7 : 1 }}>
                {sent.has(terminal.id) ? result[terminal.id] === "sent" ? "Sent" : result[terminal.id] === "check" ? "Check" : "…" : "Enter"}
              </button>
            </div>
          );
        })}
      </div>
      {error && <span role="alert" style={{ flexBasis: "100%", color: colors.err, fontSize: 12 }}>{error}</span>}
    </nav>
  );
}

// A chip in the strip: 3px corners, the control edge, 44px tall to tap.
const chip = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexShrink: 0,
  minHeight: 36,
  border: `1px solid ${colors.line}`,
  borderRadius: 3,
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer",
} as const;
