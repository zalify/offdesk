import { HubPickerPanel } from "./HubPickerPanel";
import { isSecureConnection } from "../lib/secureTransport";
import { isTauriMobile } from "../lib/platform";
import { useMobileHubSwitch } from "../lib/useMobileHubSwitch";
import { MobileTerminalAttention } from "./MobileTerminalAttention.web";
// Mobile workbench shell (P1). Rendered when the viewport is below 768px.
// Permanent chrome is exactly two elements: the session title bar on top and
// the extended key bar at the bottom (the key bar renders inside
// TerminalCard); the active terminal fills everything between them. The old
// 3-tab bottom nav (Hosts/Terminals/Stats), the app bar, the FAB and the
// card-list landing are gone — the app opens straight into the last-active
// terminal. Host switching, control toggling, reconnect and settings live
// in the host sheet (reached through the monitor icon); the title opens sessions. Per-session
// actions live in the long-press sheet. See SPEC-PHASE3.md and the design doc §4.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MachineInfo,
  ResourceStats,
  TerminalInfo,
} from "@offdesk/shared";
import {
  ArrowLeft,
  ChevronRight,
  CircuitBoard,
  Eye,
  ExternalLink,
  FolderTree,
  Keyboard as KeyboardIcon,
  Lock,
  LockOpen,
  Monitor,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { diskPercent, diskTooltip } from "@/lib/resourceStats";
import {
  buildMobileSessionGroups,
  type MobileSessionPane,
} from "@/lib/mobileSessionSwitcher";
import type { WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { WorkspaceManager } from "./WorkspaceManager.web";
import { Button, fontDisplay } from "./Warm.web";

interface MobileWorkbenchProps {
  machines: MachineInfo[];
  activeMachineId: string | null;
  controlLeases: Record<string, string>;
  deviceId: string | null;
  machineStats: Record<string, ResourceStats>;
  rttMs: number | null;
  // All terminals across machines (the title bar scopes them to the active
  // machine via `groups`; the host sheet needs the full list for counts).
  terminals: TerminalInfo[];
  // Session order: persistent groups by sort_order, then cwd fallback groups
  // (same grouping the desktop TabBar renders).
  groups: WorkspaceGroup[];
  activeTerminalId: string | null;
  canCreateTerminal: boolean;
  canSendAttention: (machineId: string) => boolean;
  onPickTerminal: (id: string) => void;
  onSelectGroup: (groupId: string) => void;
  // null group = machine home directory (empty state / no active group).
  onNewTerminal: (group: WorkspaceGroup | null) => void;
  onCloseTerminal: (terminal: TerminalInfo) => void;
  onNewGroup: () => void;
  onRenameGroup: (group: WorkspaceGroup) => void;
  onDeleteGroup: (group: WorkspaceGroup) => void;
  onReorderGroups: (
    sourceGroupId: string,
    targetGroupId: string,
    placement: "before" | "after",
  ) => void;
  onMoveTerminal: (terminal: TerminalInfo, targetGroup: WorkspaceGroup) => void;
  onSelectMachine: (id: string) => void;
  onAddMachine: () => void;
  onRemoveHost: (machineId: string) => void;
  onRequestControl: (machineId: string) => void;
  viewOnlyLocked: boolean;
  onEngageViewOnly: (machineId: string) => void;
  onDisengageViewOnly: () => void;
  onOpenSettings: () => void;
  onOpenWebPreview: () => void;
  // The inline TerminalWorkspace (null while the machine has no terminals).
  children: React.ReactNode;
}

function MobileWorkbenchComponent(props: MobileWorkbenchProps) {
  const {
    machines,
    activeMachineId,
    controlLeases,
    deviceId,
    machineStats,
    rttMs,
    terminals,
    groups,
    activeTerminalId,
    canCreateTerminal,
    canSendAttention,
    onPickTerminal,
    onSelectGroup,
    onNewTerminal,
    onCloseTerminal,
    onNewGroup,
    onRenameGroup,
    onDeleteGroup,
    onReorderGroups,
    onMoveTerminal,
    onSelectMachine,
    onAddMachine,
    onRemoveHost,
    onRequestControl,
    viewOnlyLocked,
    onEngageViewOnly,
    onDisengageViewOnly,
    onOpenSettings,
    onOpenWebPreview,
    children,
  } = props;

  const [hostSheetOpen, setHostSheetOpen] = useState(false);
  const [hubPickerOpen, setHubPickerOpen] = useState(false);
  const { switchHub, switching: switchingHub, error: switchHubError } = useMobileHubSwitch();
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [chipSheet, setChipSheet] = useState<MobileSessionPane | null>(null);

  // Center the active terminal's row when the switcher opens: with a dozen
  // terminals across several tabs the highlighted row is usually off-screen
  // and the user had to scroll hunting for it.
  useEffect(() => {
    if (!sessionSwitcherOpen) return;
    document
      .querySelector(
        '[data-testid="mobile-session-switcher"] [aria-current="true"]',
      )
      ?.scrollIntoView({ block: "center" });
  }, [sessionSwitcherOpen]);

  const activeMachine =
    machines.find((m) => m.id === activeMachineId) ?? machines[0] ?? null;
  const activeStats = activeMachine ? machineStats[activeMachine.id] : undefined;
  const isController =
    activeMachine !== null &&
    deviceId !== null &&
    controlLeases[activeMachine.id] === deviceId;

  // Sessions only cover the active machine; the empty state keys off the
  // same scoped list the canvas uses to decide whether to mount the
  // workspace.
  const scopedTerminals = useMemo(() => {
    if (!activeMachine) return [];
    return terminals.filter((t) => t.machine_id === activeMachine.id);
  }, [terminals, activeMachine]);
  const scopedTerminalsById = useMemo(
    () => new Map(scopedTerminals.map((terminal) => [terminal.id, terminal])),
    [scopedTerminals],
  );

  const sessionGroups = useMemo(
    () => buildMobileSessionGroups(groups, terminals),
    [groups, terminals],
  );
  const chips = useMemo(
    () => sessionGroups.flatMap((sessionGroup) => sessionGroup.panes),
    [sessionGroups],
  );

  const activeChip =
    chips.find((chip) => chip.terminal.id === activeTerminalId) ?? null;
  const activeGroup = activeChip?.group ?? null;
  const activePosition = activeChip
    ? chips.findIndex((chip) => chip.terminal.id === activeChip.terminal.id) + 1
    : 0;

  // Prev/next in strip order; no wraparound at either end.
  const switchTerminalByOffset = useCallback(
    (offset: number) => {
      const ids = chips.map((chip) => chip.terminal.id);
      const index = ids.indexOf(activeTerminalId ?? "");
      if (index === -1) return;
      const next = ids[index + offset];
      if (next) onPickTerminal(next);
    },
    [chips, activeTerminalId, onPickTerminal],
  );

  const titleBarTimerRef = useRef<number | null>(null);
  const titleBarTouchRef = useRef<{
    x: number;
    y: number;
    allowSwipe: boolean;
  } | null>(null);
  const suppressTitleBarClickRef = useRef(false);
  const cancelTitleBarTimer = useCallback(() => {
    if (titleBarTimerRef.current !== null) {
      window.clearTimeout(titleBarTimerRef.current);
      titleBarTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelTitleBarTimer, [cancelTitleBarTimer]);

  const handleTitleBarTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0];
      suppressTitleBarClickRef.current = false;
      cancelTitleBarTimer();
      titleBarTouchRef.current = touch
        ? {
            x: touch.clientX,
            y: touch.clientY,
            allowSwipe:
              !(event.target instanceof Element) ||
              !event.target.closest("[data-title-bar-swipe='ignore']"),
          }
        : null;
      if (!activeChip) return;
      titleBarTimerRef.current = window.setTimeout(() => {
        titleBarTimerRef.current = null;
        suppressTitleBarClickRef.current = true;
        setChipSheet(activeChip);
      }, 500);
    },
    [activeChip, cancelTitleBarTimer],
  );

  const handleTitleBarTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const start = titleBarTouchRef.current;
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (
        Math.abs(touch.clientX - start.x) > 10 ||
        Math.abs(touch.clientY - start.y) > 10
      ) {
        cancelTitleBarTimer();
      }
    },
    [cancelTitleBarTimer],
  );

  const handleTitleBarTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      cancelTitleBarTimer();
      const start = titleBarTouchRef.current;
      titleBarTouchRef.current = null;
      const touch = event.changedTouches[0];
      if (!start || !touch || suppressTitleBarClickRef.current) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (
        start.allowSwipe &&
        Math.abs(dx) >= 48 &&
        Math.abs(dx) > Math.abs(dy)
      ) {
        suppressTitleBarClickRef.current = true;
        switchTerminalByOffset(dx < 0 ? 1 : -1);
      }
    },
    [cancelTitleBarTimer, switchTerminalByOffset],
  );

  // Edge swipe: a horizontal swipe that STARTS within 24px of the left/right
  // screen edge switches to the prev/next terminal in strip order. Touches
  // starting anywhere else are ignored entirely — no preventDefault, no
  // capture — so terminal scroll and mouse-tracking apps keep working.
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const edgeSwipeRef = useRef<{
    x: number;
    y: number;
    edge: "left" | "right";
  } | null>(null);
  useEffect(() => {
    const node = terminalAreaRef.current;
    if (!node) return;
    const EDGE_PX = 24;
    const MIN_SWIPE_PX = 48;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        edgeSwipeRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (touch.clientX <= EDGE_PX) {
        edgeSwipeRef.current = { x: touch.clientX, y: touch.clientY, edge: "left" };
      } else if (touch.clientX >= window.innerWidth - EDGE_PX) {
        edgeSwipeRef.current = { x: touch.clientX, y: touch.clientY, edge: "right" };
      } else {
        edgeSwipeRef.current = null;
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      const start = edgeSwipeRef.current;
      edgeSwipeRef.current = null;
      if (!start) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      // Mostly-vertical gestures are terminal scrolls, not pane switches.
      if (Math.abs(dy) >= Math.abs(dx)) return;
      if (start.edge === "left" && dx >= MIN_SWIPE_PX) {
        switchTerminalByOffset(-1);
      } else if (start.edge === "right" && dx <= -MIN_SWIPE_PX) {
        switchTerminalByOffset(1);
      }
    };
    const onTouchCancel = () => {
      edgeSwipeRef.current = null;
    };
    // Capture phase: xterm stops touch propagation inside the terminal, so
    // bubble-phase listeners here would never see edge touches.
    node.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    });
    node.addEventListener("touchend", onTouchEnd, {
      capture: true,
      passive: true,
    });
    node.addEventListener("touchcancel", onTouchCancel, {
      capture: true,
      passive: true,
    });
    return () => {
      node.removeEventListener("touchstart", onTouchStart, true);
      node.removeEventListener("touchend", onTouchEnd, true);
      node.removeEventListener("touchcancel", onTouchCancel, true);
    };
  }, [switchTerminalByOffset]);

  const machineOnline = (machine: MachineInfo) =>
    Boolean(machineStats[machine.id]) ||
    terminals.some((t) => t.machine_id === machine.id && t.reachable);

  return (
    <div
      data-testid="mobile-workbench"
      style={{
        height: "100%",
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: colors.bg0,
        color: colors.fg1,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Mobile V1 session title bar */}
      <div
        data-testid="mobile-title-bar"
        onTouchStart={handleTitleBarTouchStart}
        onTouchMove={handleTitleBarTouchMove}
        onTouchEnd={handleTitleBarTouchEnd}
        onTouchCancel={() => {
          cancelTitleBarTimer();
          titleBarTouchRef.current = null;
        }}
        onContextMenu={(event) => event.preventDefault()}
        style={{
          // 44px, the compact strip's height in DESIGN.md: taller than that and
          // a desktop-sized terminal no longer fits a phone at scale 1.
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 8px 0 12px",
          background: colors.bg1,
          borderBottom: `1px solid ${colors.lineSoft}`,
          cursor: "pointer",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <button
          type="button"
          data-testid="mobile-title-bar-label"
          aria-label="Open terminal switcher"
          aria-description={`Session ${activePosition} of ${chips.length}`}
          aria-expanded={sessionSwitcherOpen}
          onClick={() => {
            if (suppressTitleBarClickRef.current) { suppressTitleBarClickRef.current = false; return; }
            setSessionSwitcherOpen(true);
          }}
          style={{
            background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", height: "100%",
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 1,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {activeChip ? (
            <>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: colors.fg0,
                  fontFamily: fontDisplay,
                  fontSize: 14,
                  fontWeight: 700,
                  lineHeight: 1.1,
                }}
              >
                {displayTerminalTitle(activeChip.terminal)}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: colors.fg3,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1.15,
                }}
              >
                {activeChip.group.label} · {activeMachine?.name ?? ""}
              </span>
            </>
          ) : (
            <span
              style={{ color: colors.fg2, fontFamily: fontDisplay, fontSize: 14, fontWeight: 600, overflow: "hidden" }}
            >
              No terminal
            </span>
          )}
        </button>

        {activeMachine ? (
          <span
            data-testid="mobile-title-bar-control"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 26,
              padding: "0 9px",
              borderRadius: 999,
              background: colors.bg0,
              border: `1px solid ${colors.lineSoft}`,
              color: colors.fg2,
              fontFamily: fontDisplay,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {viewOnlyLocked ? (
              <>
                <Lock size={13} /> View only
              </>
            ) : deviceId !== null && controlLeases[activeMachine.id] === deviceId ? (
              <>
                <KeyboardIcon size={13} /> In control
              </>
            ) : (
              <>
                <Eye size={13} /> Watching
              </>
            )}
          </span>
        ) : null}

        <span
          onClick={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
          style={{ width: 34, height: 34, flexShrink: 0 }}
        >
          <button
            type="button"
            data-testid="mobile-bar-new-terminal"
            disabled={!canCreateTerminal}
            onClick={() => onNewTerminal(activeGroup)}
            title="New terminal"
            aria-label="New terminal"
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              border: `1.5px solid ${colors.line}`,
              background: colors.bg1,
              color: colors.fg0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: canCreateTerminal ? "pointer" : "not-allowed",
              opacity: canCreateTerminal ? 1 : 0.45,
            }}
          >
            <Plus size={16} />
          </button>
        </span>

        <button
          type="button"
          aria-label="Open Machines and Hub menu"
          title="Machines & Hub"
          aria-expanded={hostSheetOpen}
          data-testid="mobile-title-bar-machines"
          data-title-bar-swipe="ignore"
          onClick={(event) => { event.stopPropagation(); setHostSheetOpen(true); }}
          onTouchStart={event => event.stopPropagation()}
          onTouchEnd={event => event.stopPropagation()}
          style={{
            border: 0, cursor: "pointer", height: 34,
            flexShrink: 0,
            width: 37,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            background: colors.bg2,
            color: colors.fg2,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textAlign: "center",
          }}
        >
          <Monitor size={18} aria-hidden="true" />
        </button>
        <span data-testid="mobile-title-bar-dot" style={{ display: "flex" }}>
          <HostDot
            online={activeMachine ? machineOnline(activeMachine) : false}
            isController={false}
          />
        </span>
      </div>

      {/* Terminal area (edge swipes switch terminals in strip order) */}
      <MobileTerminalAttention terminals={terminals} machines={machines}
        deviceId={deviceId} canSend={canSendAttention}
        activeTerminalId={activeTerminalId}
        groupLabels={new Map(chips.map(({ terminal, group }) => [terminal.id, group.label]))}
        onPick={(id) => {
          const terminal = terminals.find(t => t.id === id);
          if (!terminal) return;
          onSelectMachine(terminal.machine_id);
          onPickTerminal(id);
        }} />
      <div
        ref={terminalAreaRef}
        data-testid="mobile-terminal-area"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {scopedTerminals.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: colors.fg3,
              fontSize: 14,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <TerminalIcon size={40} style={{ opacity: 0.35 }} />
              <div style={{ marginTop: 12 }}>No terminals yet</div>
              {canCreateTerminal && (
                <button
                  type="button"
                  data-testid="empty-new-terminal"
                  onClick={() => onNewTerminal(null)}
                  style={{
                    marginTop: 14,
                    background: colors.accent,
                    color: colors.onAccent,
                    border: "none",
                    borderRadius: 999,
                    padding: "8px 14px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Start terminal
                </button>
              )}
            </div>
          </div>
        ) : children}
      </div>

      {/* Session switcher sheet */}
      {sessionSwitcherOpen && (
        <Sheet
          header={
            <SessionSwitcherHeader
              machine={activeMachine}
              machines={machines}
              machineOnline={machineOnline}
              online={activeMachine ? machineOnline(activeMachine) : false}
              stats={activeStats}
              rttMs={rttMs}
              onSelectMachine={(id) => {
                onSelectMachine(id);
              }}
              onOpenHostSheet={() => {
                setSessionSwitcherOpen(false);
                setHostSheetOpen(true);
              }}
            />
          }
          testid="mobile-session-switcher"
          onClose={() => setSessionSwitcherOpen(false)}
        >
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 22px 10px",
            color: colors.fg2,
            fontFamily: fontDisplay,
            fontSize: 13,
          }}>
            <span>Sessions</span>
            <span data-testid="mobile-session-position" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {activePosition}/{chips.length}
            </span>
          </div>
          <div style={{ display: "flex", gap: 10, padding: "4px 16px 10px" }}>
            <Button
              kind="coral"
              testId="mobile-session-switcher-new-terminal"
              disabled={!canCreateTerminal}
              onClick={() => {
                setSessionSwitcherOpen(false);
                onNewTerminal(activeGroup);
              }}
              style={{ flex: 1, height: 44 }}
            >
              <Plus size={16} /> New terminal
            </Button>
            <Button
              kind="sky"
              testId="mobile-workspace-manager-button"
              onClick={() => {
                setSessionSwitcherOpen(false);
                setWorkspaceManagerOpen(true);
              }}
              style={{ height: 44 }}
            >
              <FolderTree size={16} /> Tabs
            </Button>
          </div>
          {sessionGroups.map(({ group, panes }) => (
            <section key={group.id} style={{ padding: "0 16px 6px" }}>
              <div
                data-testid={`mobile-session-group-${group.id}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "12px 6px 6px",
                  fontFamily: fontDisplay,
                  color: colors.fg2,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: colors.fg3, whiteSpace: "nowrap" }}>
                  {" · "}
                  {panes.length} {panes.length === 1 ? "pane" : "panes"}
                </span>
              </div>
              {panes.map(({ terminal }) => {
                const active = terminal.id === activeTerminalId;
                return (
                  // Row = pick button + its own close button. Long-pressing the
                  // title bar closes only the *active* session and nobody finds
                  // it, so every session gets a visible ✕ here.
                  <div
                    key={terminal.id}
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      minHeight: 52,
                      marginBottom: 6,
                      borderRadius: 14,
                      background: active ? colors.bg3 : colors.bg1,
                      border: `1px solid ${active ? colors.line : colors.lineSoft}`,
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      data-testid={`mobile-session-row-${terminal.id}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        onPickTerminal(terminal.id);
                        setSessionSwitcherOpen(false);
                      }}
                      style={{
                        display: "block",
                        flex: 1,
                        minWidth: 0,
                        padding: "10px 8px 10px 14px",
                        color: colors.fg1,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          color: colors.fg0,
                          fontFamily: fontDisplay,
                          fontSize: 15.5,
                          fontWeight: active ? 700 : 600,
                          whiteSpace: "normal",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {displayTerminalTitle(terminal)}
                        {terminal.reachable && terminal.attention === "confirmation" && (
                          <span style={{ display: "block", fontFamily: "inherit", color: colors.accent, fontSize: 11 }}>Confirmation requested</span>
                        )}
                      </span>
                      <span
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: colors.fg3,
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          whiteSpace: "normal",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {terminal.cwd}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`mobile-session-close-${terminal.id}`}
                      disabled={!canCreateTerminal}
                      title="Close terminal"
                      aria-label={`Close ${displayTerminalTitle(terminal)}`}
                      onClick={() => onCloseTerminal(terminal)}
                      style={{
                        flexShrink: 0,
                        width: 48,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "transparent",
                        border: "none",
                        color: colors.fg3,
                        cursor: canCreateTerminal ? "pointer" : "not-allowed",
                        opacity: canCreateTerminal ? 1 : 0.4,
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </Sheet>
      )}

      <WorkspaceManager
        open={workspaceManagerOpen}
        placement="sheet"
        machineName={activeMachine?.name ?? ""}
        groups={groups}
        terminalsById={scopedTerminalsById}
        activeGroupId={activeGroup?.id ?? null}
        activeTerminalId={activeTerminalId}
        canManage={isController}
        onClose={() => setWorkspaceManagerOpen(false)}
        onSelectGroup={onSelectGroup}
        onSelectTerminal={onPickTerminal}
        onNewGroup={onNewGroup}
        onNewTerminal={onNewTerminal}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onReorderGroups={onReorderGroups}
        onMoveTerminal={onMoveTerminal}
        onCloseTerminal={onCloseTerminal}
      />

      {hubPickerOpen && <Sheet title="Hubs & connections" backLabel="Back to Machines" onBack={() => { setHubPickerOpen(false); setHostSheetOpen(true); }} onClose={() => setHubPickerOpen(false)}><HubPickerPanel /></Sheet>}

      {/* Host sheet */}
      {hostSheetOpen && (
        <Sheet title="Machines" onClose={() => setHostSheetOpen(false)}>
          {(isSecureConnection() || isTauriMobile()) && <MenuRow
            icon={<ChevronRight size={18} />}
            label={isSecureConnection() ? "Hub & connection" : switchingHub ? "Opening setup…" : "Switch Hub"}
            onClick={() => {
              if (isSecureConnection()) { setHostSheetOpen(false); setHubPickerOpen(true); }
              else void switchHub();
            }}
          />}
          {switchHubError && <p role="alert" style={{ color: colors.err, padding: 16 }}>{switchHubError}</p>}
          {machines.map((m) => {
            const isActive = m.id === activeMachine?.id;
            const controlling =
              deviceId !== null && controlLeases[m.id] === deviceId;
            return (
              <div
                key={m.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  background: isActive ? colors.bg2 : "transparent",
                  borderLeft: isActive
                    ? `3px solid ${colors.accent}`
                    : "3px solid transparent",
                }}
              >
              <button
                type="button"
                onClick={() => {
                  onSelectMachine(m.id);
                  setHostSheetOpen(false);
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  alignItems: "center",
                  width: "100%",
                  textAlign: "left",
                  padding: "12px 16px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: colors.fg1,
                }}
              >
                <HostDot online={machineOnline(m)} isController={controlling} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: colors.fg0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.name}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: colors.fg3,
                    }}
                  >
                    {m.os}
                  </div>
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: colors.fg3,
                  }}
                >
                  {terminals.filter((t) => t.machine_id === m.id).length} term
                </div>
              </button>
              <button
                type="button"
                data-testid={`mobile-host-remove-${m.id}`}
                title={`Remove ${m.name}`}
                aria-label={`Remove ${m.name}`}
                onClick={() => {
                  setHostSheetOpen(false);
                  onRemoveHost(m.id);
                }}
                style={{
                  width: 48,
                  height: 48,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  color: colors.fg3,
                  cursor: "pointer",
                }}
              >
                <X size={16} />
              </button>
              </div>
            );
          })}
          <MenuRow
            icon={<Plus size={17} />}
            label="Add a machine"
            onClick={() => {
              setHostSheetOpen(false);
              onAddMachine();
            }}
          />
          {activeMachine &&
            (viewOnlyLocked ? (
              <MenuRow
                icon={<LockOpen size={17} />}
                label="Unlock view only"
                testid="mobile-control-toggle"
                onClick={() => {
                  setHostSheetOpen(false);
                  onDisengageViewOnly();
                }}
              />
            ) : isController ? (
              <MenuRow
                icon={<Lock size={17} />}
                label="View only"
                testid="mobile-control-toggle"
                onClick={() => {
                  setHostSheetOpen(false);
                  onEngageViewOnly(activeMachine.id);
                }}
              />
            ) : (
              <MenuRow
                icon={<CircuitBoard size={17} />}
                label="Take control"
                testid="mobile-control-toggle"
                onClick={() => {
                  setHostSheetOpen(false);
                  onRequestControl(activeMachine.id);
                }}
              />
            ))}
          <MenuRow
            icon={<RefreshCw size={17} />}
            label="Reconnect"
            onClick={() => window.location.reload()}
          />
          {activeTerminalId && <MenuRow
            icon={<ExternalLink size={17} />}
            label="Open web preview"
            onClick={() => {
              setHostSheetOpen(false);
              onOpenWebPreview();
            }}
          />}
          <MenuRow
            icon={<SettingsIcon size={17} />}
            label="Settings"
            onClick={() => {
              setHostSheetOpen(false);
              onOpenSettings();
            }}
          />
        </Sheet>
      )}

      {/* Chip long-press sheet */}
      {chipSheet && (
        <Sheet
          title={`${chipSheet.group.label} · ${displayTerminalTitle(chipSheet.terminal)}`}
          onClose={() => setChipSheet(null)}
        >
          <MenuRow
            icon={<X size={17} />}
            label="Close terminal"
            danger
            disabled={!canCreateTerminal}
            testid="mobile-chip-close-terminal"
            onClick={() => {
              const { terminal } = chipSheet;
              setChipSheet(null);
              onCloseTerminal(terminal);
            }}
          />
          <MenuRow
            icon={<Plus size={17} />}
            label="New terminal here"
            disabled={!canCreateTerminal}
            testid="mobile-chip-new-terminal"
            onClick={() => {
              const { group } = chipSheet;
              setChipSheet(null);
              onNewTerminal(group);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

export const MobileWorkbench = memo(MobileWorkbenchComponent);

/* ---------- title bar and sheet status ---------- */

function SessionSwitcherHeader({
  machine,
  machines,
  machineOnline,
  online,
  stats,
  rttMs,
  onOpenHostSheet,
  onSelectMachine,
}: {
  machine: MachineInfo | null;
  machines: MachineInfo[];
  machineOnline: (machine: MachineInfo) => boolean;
  online: boolean;
  stats: ResourceStats | undefined;
  rttMs: number | null;
  onOpenHostSheet: () => void;
  onSelectMachine: (id: string) => void;
}) {
  const cpu = stats ? Math.round(stats.cpu_percent) : null;
  const mem =
    stats && stats.memory_total > 0
      ? Math.round((stats.memory_used / stats.memory_total) * 100)
      : null;
  const disk = diskPercent(stats);
  // A chip per machine, the active one first and open to its sheet; the
  // meters ride on the active chip.
  const others = machines.filter((m) => m.id !== machine?.id);
  return (
    <div
      data-testid="mobile-session-header"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        gap: 8,
        minWidth: 0,
        padding: "2px 16px 6px",
        overflowX: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: colors.fg3,
      }}
    >
      <button
        type="button"
        data-testid="mobile-host-button"
        onClick={onOpenHostSheet}
        disabled={!machine}
        aria-label="Open machines"
        style={{
          flexShrink: 0,
          minWidth: 140,
          maxWidth: "100%",
          height: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "10px 14px",
          borderRadius: 16,
          border: `1px solid ${colors.line}`,
          background: colors.bg0,
          color: colors.fg0,
          cursor: machine ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span data-testid="mobile-session-header-dot" style={{ display: "flex" }}>
            <HostDot online={online} isController={false} />
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: fontDisplay,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {machine?.name ?? "No machine"}
          </span>
          <ChevronRight size={14} style={{ flexShrink: 0, color: colors.fg3 }} />
        </span>
        <span data-testid="mobile-session-header-metrics" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.5 }}>
          <span data-testid="mobile-session-header-rtt" style={{ color: colors.fg1 }}>
            {rttMs === null ? "—" : `${Math.round(rttMs)}ms`}
          </span>
          <HeaderMetric label="cpu" percent={cpu} testid="mobile-session-header-cpu" />
          <HeaderMetric label="mem" percent={mem} testid="mobile-session-header-mem" />
          <HeaderMetric label="disk" percent={disk} title={diskTooltip(stats)} testid="mobile-session-header-disk" />
        </span>
      </button>
      {others.map((m) => {
        const up = machineOnline(m);
        return (
          <button
            key={m.id}
            type="button"
            data-testid={`mobile-session-header-machine-${m.id}`}
            onClick={() => onSelectMachine(m.id)}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 14px",
              borderRadius: 16,
              border: `1px ${up ? "solid" : "dashed"} ${colors.line}`,
              background: "transparent",
              color: up ? colors.fg0 : colors.fg3,
              cursor: "pointer",
              fontFamily: fontDisplay,
              fontSize: 14,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <HostDot online={up} isController={false} />
            {m.name}
          </button>
        );
      })}
    </div>
  );
}

function HeaderMetric({
  label,
  percent,
  testid,
  title,
}: {
  label: string;
  percent: number | null;
  testid: string;
  title?: string;
}) {
  return (
    <span
      data-testid={testid}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        whiteSpace: "nowrap",
        color: colors.fg1,
      }}
    >
      <span>
        {label} {percent === null ? "—" : `${percent}%`}
      </span>
    </span>
  );
}

function HostDot({
  online,
  isController,
}: {
  online: boolean;
  isController: boolean;
}) {
  return (
    <span
      style={{
        position: "relative",
        width: 10,
        height: 10,
        display: "inline-block",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 999,
          background: online ? colors.ok : colors.fg3,
          boxShadow: online ? "0 0 0 3px rgba(99, 209, 143, 0.22)" : "none",
        }}
      />
      {isController && (
        <span
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            width: 5,
            height: 5,
            borderRadius: 999,
            background: colors.accent,
            border: `1.5px solid ${colors.bg1}`,
          }}
        />
      )}
    </span>
  );
}

/* ---------- sheets ---------- */

function Sheet({
  title,
  header,
  backLabel,
  onBack,
  testid,
  onClose,
  children,
}: {
  title?: string;
  header?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  testid?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      data-testid={testid}
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "rgb(43 35 64 / 0.45)",
        display: "flex",
        alignItems: "flex-end",
        animation: "offdeskFadeIn 120ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: colors.bg1,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          maxHeight: "85%",
          display: "flex",
          flexDirection: "column",
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          animation: "offdeskSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            flexShrink: 0,
            padding: "8px 0 4px",
          }}
        >
          <span
            style={{
              width: 36,
              height: 4,
              borderRadius: 999,
              background: colors.line,
            }}
          />
        </div>
        {header ?? (title && (
          <div
            style={{
              flexShrink: 0,
              padding: "4px 20px 10px",
              fontFamily: fontDisplay,
              fontSize: 18,
              fontWeight: 700,
              color: colors.fg0,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {backLabel && <button type="button" aria-label={backLabel} onClick={onBack} style={{ border: 0, background: "none", color: "inherit", width: 44, height: 44, display: "grid", placeItems: "center", cursor: "pointer" }}><ArrowLeft size={20} /></button>}
            {title}
          </div>
        ))}
        <div style={{ overflow: "auto", minHeight: 0, paddingBottom: 4 }}>{children}</div>
      </div>
    </div>
  );
}

function MenuRow({
  icon,
  label,
  disabled,
  danger,
  testid,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  testid?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 52,
        padding: "12px 20px",
        color: danger ? colors.err : disabled ? colors.fg3 : colors.fg0,
        textAlign: "left",
        borderBottom: `1px solid ${colors.lineSoft}`,
        background: "none",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      <span style={{ fontFamily: fontDisplay, fontSize: 15, fontWeight: 600 }}>{label}</span>
      <span style={{ flex: 1 }} />
    </button>
  );
}
