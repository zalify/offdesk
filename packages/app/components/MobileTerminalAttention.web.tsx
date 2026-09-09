import { useEffect, useRef, useState } from "react";
import { sendAttentionEnter } from "@/lib/attentionEnter";
import type { MachineInfo, TerminalInfo } from "@offdesk/shared";
import { CircleAlert, ChevronRight } from "lucide-react";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";

export function MobileTerminalAttention({ terminals, machines, activeTerminalId, groupLabels, onPick, deviceId, canSend }: {
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeTerminalId: string | null;
  groupLabels: Map<string, string>;
  onPick: (id: string) => void;
  deviceId: string | null;
  canSend: (machineId: string) => boolean;
}) {
  const pending = terminals.filter(t => t.id !== activeTerminalId && t.reachable && t.attention === "confirmation"
    && machines.some(m => m.id === t.machine_id));
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
  if (pending.length === 0) return null;
  return (
    <nav aria-label="Terminals needing attention" data-testid="mobile-terminal-attention"
      style={{ flexShrink: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "4px 8px", borderBottom: `1px solid ${colors.lineSoft}`, background: colors.bg1, minWidth: 0 }}>
      <span role="status" style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0, color: colors.accent, fontSize: 12 }}>
        <CircleAlert size={16} aria-hidden="true" />
        <span>{pending.length} waiting</span>
      </span>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", minWidth: 0, flex: 1, overscrollBehaviorX: "contain" }}>
        {pending.map(terminal => {
          const title = displayTerminalTitle(terminal);
          const machine = machines.find(m => m.id === terminal.machine_id)?.name;
          const group = groupLabels.get(terminal.id) ?? terminal.cwd.split(/[\\/]/).filter(Boolean).pop();
          const context = [group, machine].filter(Boolean).join(" · ");
          return (
            <div key={terminal.id} style={{ display: "flex", alignItems: "stretch", flexShrink: 0, border: `1px solid ${colors.line}`, borderRadius: 10, overflow: "hidden", background: colors.bg0 }}>
            <button type="button" data-testid={`mobile-attention-${terminal.id}`}
              aria-label={`Open ${title}, ${context}, confirmation requested`}
              title={`${title} · ${context} — confirmation requested`}
              onClick={() => onPick(terminal.id)}
              style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, maxWidth: 180, minHeight: 44, padding: "4px 10px", border: 0, background: colors.bg0, color: colors.fg0, textAlign: "left", cursor: "pointer" }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{title}</span>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: colors.fg2 }}>{context}</span>
              </span>
              <ChevronRight size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
            </button>
            <button type="button" data-testid={`mobile-attention-enter-${terminal.id}`}
              aria-label={`Send Enter to ${title}, ${context}`}
              title="Confirm the currently selected option in this terminal"
              disabled={!deviceId || !canSend(terminal.machine_id) || sent.has(terminal.id)}
              onPointerDown={event => event.preventDefault()}
              onClick={() => void enter(terminal)}
              style={{ minWidth: 52, minHeight: 44, padding: "4px 8px", border: 0, borderLeft: `1px solid ${colors.lineSoft}`, background: "transparent", color: colors.accent, font: "inherit", fontSize: 12, cursor: "pointer", opacity: !deviceId || !canSend(terminal.machine_id) || sent.has(terminal.id) ? 0.45 : 1 }}>
              {sent.has(terminal.id) ? result[terminal.id] === "sent" ? "Sent" : result[terminal.id] === "check" ? "Check" : "…" : "Enter"}
            </button>
            </div>
          );
        })}
      </div>
      {error && <span role="alert" style={{ flexBasis: "100%", color: colors.accent, fontSize: 12 }}>{error}</span>}
    </nav>
  );
}
