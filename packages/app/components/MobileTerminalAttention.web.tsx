import type { MachineInfo, TerminalInfo } from "@offdesk/shared";
import { CircleAlert, ChevronRight } from "lucide-react";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";

export function MobileTerminalAttention({ terminals, machines, activeTerminalId, groupLabels, onPick }: {
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeTerminalId: string | null;
  groupLabels: Map<string, string>;
  onPick: (id: string) => void;
}) {
  const pending = terminals.filter(t => t.id !== activeTerminalId && t.reachable && t.attention === "confirmation"
    && machines.some(m => m.id === t.machine_id));
  if (pending.length === 0) return null;
  return (
    <nav aria-label="Terminals needing attention" data-testid="mobile-terminal-attention"
      style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderBottom: `1px solid ${colors.lineSoft}`, background: colors.bg1, minWidth: 0 }}>
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
            <button key={terminal.id} type="button" data-testid={`mobile-attention-${terminal.id}`}
              aria-label={`Open ${title}, ${context}, confirmation requested`}
              title={`${title} · ${context} — confirmation requested`}
              onClick={() => onPick(terminal.id)}
              style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, maxWidth: 220, minHeight: 44, padding: "4px 10px", borderRadius: 10, border: `1px solid ${colors.line}`, background: colors.bg0, color: colors.fg0, textAlign: "left", cursor: "pointer" }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{title}</span>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: colors.fg2 }}>{context}</span>
              </span>
              <ChevronRight size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
