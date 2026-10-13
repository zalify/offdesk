import { memo, useEffect, useRef, useState } from "react";
import type {
  MachineInfo,
  ResourceStats,
  TerminalInfo,
} from "@offdesk/shared";
import { Button, fontDisplay } from "./Primitives.web";
import { colors } from "@/lib/colors";
import { diskPercent } from "@/lib/resourceStats";

// The machine switcher in the tab bar: `mac-mini ▾` as text, opening a
// list of machines (● online, name, os, load, terminals), `[x]` to remove
// one, and `add a machine`.

interface HostSwitcherProps {
  machines: MachineInfo[];
  activeMachineId: string | null;
  controlLeases: Record<string, string>;
  deviceId: string | null;
  machineStats: Record<string, ResourceStats>;
  terminals: TerminalInfo[];
  onSelectMachine: (id: string) => void;
  onAddMachine?: () => void;
  onRemoveHost?: (machineId: string) => void;
  // Chromeless text trigger for the tab bar.
  compact?: boolean;
}

function HostSwitcherComponent({
  machines,
  activeMachineId,
  controlLeases,
  deviceId,
  machineStats,
  terminals,
  onSelectMachine,
  onAddMachine,
  onRemoveHost,
  compact = false,
}: HostSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const active =
    machines.find((m) => m.id === activeMachineId) ?? machines[0] ?? null;

  if (!active) {
    return (
      <span style={{ fontFamily: fontDisplay, fontSize: 12.5, color: colors.fg3 }}>
        no machine
      </span>
    );
  }

  const termCountFor = (id: string) =>
    terminals.filter((t) => t.machine_id === id).length;
  const onlineFor = (id: string) =>
    Boolean(machineStats[id]) ||
    terminals.some((t) => t.machine_id === id && t.reachable);
  const controllingActive =
    deviceId !== null && controlLeases[active.id] === deviceId;

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="host-switcher-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${active.name}${onlineFor(active.id) ? "" : " (offline)"}${controllingActive ? " · you are in control" : ""}`}
        className="odk-text-btn odk-text-btn--strong"
        style={compact ? { maxWidth: 200 } : { width: "100%", justifyContent: "space-between" }}
      >
        {!onlineFor(active.id) && (
          <span style={{ color: colors.fg3 }} role="img" aria-label="Offline">○</span>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active.name}
        </span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          className="odk-float"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            ...(compact ? { right: 0 } : { left: 0 }),
            minWidth: 340,
            zIndex: 20,
            padding: 8,
            maxHeight: 360,
            overflow: "auto",
          }}
        >
          <div
            style={{
              padding: "4px 12px 6px",
              fontSize: 11.5,
              fontWeight: 500,
              color: colors.fg3,
            }}
          >
            machines · {machines.length}
          </div>
          {machines.map((m) => {
            const isActive = m.id === active.id;
            const online = onlineFor(m.id);
            const controlling =
              deviceId !== null && controlLeases[m.id] === deviceId;
            return (
              <div
                key={m.id}
                data-testid={`host-switcher-row-${m.id}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "stretch",
                  borderRadius: 3,
                  background: isActive ? colors.bg3 : "transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectMachine(m.id);
                    setOpen(false);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto minmax(0, 1fr) auto",
                    gap: 10,
                    alignItems: "center",
                    width: "100%",
                    minHeight: 40,
                    textAlign: "left",
                    padding: "6px 12px",
                    borderRadius: 3,
                    background: "transparent",
                    color: colors.fg0,
                    cursor: "pointer",
                    border: "none",
                    fontFamily: fontDisplay,
                    fontSize: 13,
                  }}
                >
                  <span
                    role="img"
                    aria-label={online ? (controlling ? "Online, you are in control" : "Online") : "Offline"}
                    style={{ color: online ? colors.ok : colors.fg3 }}
                  >
                    {online ? "●" : "○"}
                  </span>
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                        {m.name}
                      </span>
                      <span style={{ fontSize: 11, color: colors.fg3 }}>{m.os}</span>
                    </span>
                    <span style={{ fontSize: 11, color: colors.fg3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.home_dir}
                    </span>
                  </span>
                  <span style={{ textAlign: "right", fontSize: 11, color: colors.fg3, lineHeight: 1.5 }}>
                    <span style={{ display: "block" }}>
                      {online ? machineRowStatus(machineStats[m.id]) : "offline"}
                    </span>
                    <span style={{ display: "block" }}>{termCountFor(m.id)} term</span>
                  </span>
                </button>
                {onRemoveHost && (
                  <button
                    type="button"
                    data-testid={`host-switcher-remove-${m.id}`}
                    title={`Remove ${m.name}`}
                    aria-label={`Remove ${m.name}`}
                    className="odk-text-btn"
                    onClick={() => {
                      setOpen(false);
                      onRemoveHost(m.id);
                    }}
                    style={{ alignSelf: "center", marginRight: 4 }}
                  >
                    [x]
                  </button>
                )}
              </div>
            );
          })}
          {onAddMachine && (
            <div style={{ padding: "8px 4px 2px" }}>
              <Button
                kind="secondary"
                size="sm"
                testId="host-switcher-add-machine"
                style={{ width: "100%" }}
                onClick={() => {
                  setOpen(false);
                  onAddMachine();
                }}
              >
                add a machine
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const HostSwitcher = memo(HostSwitcherComponent);

function machineRowStatus(stats: ResourceStats | undefined): string {
  if (!stats) return "online";
  const disk = diskPercent(stats);
  const cpu = `${Math.round(stats.cpu_percent)}% cpu`;
  return disk === null ? cpu : `${cpu} · ${disk}% disk`;
}
