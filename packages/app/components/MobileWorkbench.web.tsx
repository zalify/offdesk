import { AppearanceSheet } from "./AppearanceSheet.web";
import { HubPickerPanel } from "./HubPickerPanel";
import { isSecureConnection } from "../lib/secureTransport";
import { isTauriMobile } from "../lib/platform";
import { useMobileHubSwitch } from "../lib/useMobileHubSwitch";
import { MobileTerminalAttention, MobileWaitingCard } from "./MobileTerminalAttention.web";
import { AgentBrowserMobileSurface } from "./AgentBrowserMobileSurface.web";
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
  useSyncExternalStore,
  useState,
} from "react";
import type { AgentRunInfo,
  AgentBrowserInfo,
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
  FolderOpen,
  Globe,
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
import { colors, colorAlpha } from "@/lib/colors";
import { pickSelectedBrowserId } from "@/lib/agentBrowserOverlay";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription, terminalOpenerText } from "@/lib/terminalOpener";
import { diskPercent, diskTooltip } from "@/lib/resourceStats";
import {
  buildMobileSessionGroups,
  type MobileSessionPane,
} from "@/lib/mobileSessionSwitcher";
import type { WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { WorkspaceManager } from "./WorkspaceManager.web";
import { anyNodeBehind, copyNodeUpdateCommand, nodeUpdateChip, nodeVersionLabel, NODE_UPDATE_COMMAND, useSheetVersions } from "@/lib/machineVersions";
import { Button, Chip, TextButton, fontDisplay, fontProse } from "./Primitives.web";

// The title bar's [f] [b] [m]: 40px squares, so five fit beside the
// session title on a 320px phone.
const titleBarButton = { width: 40, height: 40, minWidth: 40, minHeight: 40, fontSize: 13 } as const;

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
  // The active machine's agent browsers. They are machine-wide, not sessions:
  // the title bar's Globe button opens a full-screen surface for them.
  browsers: AgentBrowserInfo[];
  /** Agent runs; those waiting on a person show in the attention strip, answerable there. */
  agentRuns?: AgentRunInfo[];
  browserButton?: { count: number; needsPerson: boolean; open: boolean };
  browserSurfaceOpen: boolean;
  /** The tab the person last picked on the active machine; may be gone. */
  selectedBrowserId: string | null;
  onToggleBrowser: () => void;
  onOpenBrowser: (id: string) => void;
  onSelectBrowser: (id: string) => void;
  onCloseBrowserSurface: () => void;
  /** The file browser: a title-bar button and a full-screen surface. */
  filesButton?: { open: boolean };
  onToggleFiles?: () => void;
  filesSurface?: React.ReactNode;
  canCreateTerminal: boolean;
  canSendAttention: (machineId: string) => boolean;
  /** "Picked up where you left off": shown in the subtitle line for a moment. */
  resumeNotice?: React.ReactNode;
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

const TITLE_BAR_FILES_MIN_WIDTH = 360;

function useMinViewportWidth(minWidth: number): boolean {
  const query = `(min-width: ${minWidth}px)`;
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
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
    browsers,
    agentRuns,
    browserButton,
    browserSurfaceOpen,
    selectedBrowserId,
    onToggleBrowser,
    onOpenBrowser,
    onSelectBrowser,
    onCloseBrowserSurface,
    filesButton,
    onToggleFiles,
    filesSurface,
    canCreateTerminal,
    canSendAttention,
    resumeNotice,
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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // P03: node and hub versions, asked when the sheet opens. Null on hubs from
  // before 0.23, and then the sheet looks as it always did.
  const { versions: sheetVersions, hubName } = useSheetVersions(hostSheetOpen);
  const [updateCopy, setUpdateCopy] = useState<"copied" | "failed" | null>(null);
  useEffect(() => { if (!hostSheetOpen) setUpdateCopy(null); }, [hostSheetOpen]);
  // Below 360px the title bar has no room for the Files button; the Machines
  // sheet always offers it instead.
  const wideTitleBar = useMinViewportWidth(TITLE_BAR_FILES_MIN_WIDTH);
  const [hubPickerOpen, setHubPickerOpen] = useState(false);
  const { switchHub, switching: switchingHub, error: switchHubError } = useMobileHubSwitch();
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [chipSheet, setChipSheet] = useState<MobileSessionPane | null>(null);
  const sessionSwitcherScrollRef = useRef<HTMLDivElement | null>(null);

  // Center the active terminal's row when the switcher opens: with a dozen
  // terminals across several tabs the highlighted row is usually off-screen
  // and the user had to scroll hunting for it. Scroll the sheet's own list
  // instead of scrollIntoView: the panel is still translated 16px by its
  // slide-up animation, and centering through the browser also scrolled the
  // overflow-hidden workbench, shifting the whole app.
  useEffect(() => {
    if (!sessionSwitcherOpen) return;
    const container = sessionSwitcherScrollRef.current;
    const row = container?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!container || !row) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    container.scrollTop +=
      rowRect.top -
      containerRect.top -
      (container.clientHeight - rowRect.height) / 2;
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
  const activeGroupIndex = activeGroup ? sessionGroups.findIndex(({ group }) => group.id === activeGroup.id) : -1;
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
          minHeight: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 4px 0 16px",
          background: colors.bg0,
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
          aria-description={[
            `Session ${activePosition} of ${chips.length}`,
            activeChip && terminalOpenerDescription(activeChip.terminal),
          ].filter(Boolean).join(". ")}
          aria-expanded={sessionSwitcherOpen}
          onClick={() => {
            if (suppressTitleBarClickRef.current) { suppressTitleBarClickRef.current = false; return; }
            setSessionSwitcherOpen(true);
          }}
          style={{
            background: "none", border: 0, padding: "5px 0", textAlign: "left", cursor: "pointer", alignSelf: "stretch",
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 2,
            overflow: "hidden",
            whiteSpace: "nowrap",
            color: colors.fg0,
            fontFamily: fontDisplay,
          }}
        >
          {activeChip ? (
            <>
              <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.1 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                  {displayTerminalTitle(activeChip.terminal)}
                </span>
                <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 12 }}>▾</span>
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  minWidth: 0,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  color: colors.fg3,
                  fontSize: 11,
                  lineHeight: 1.15,
                }}
              >
                {resumeNotice ?? (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                    {activeGroupIndex >= 0 ? `${activeGroupIndex}:` : ""}{activeChip.group.label} ·{" "}
                    <span
                      data-testid="mobile-title-bar-dot"
                      role="img"
                      aria-label={activeMachine && machineOnline(activeMachine) ? "Online" : "Offline"}
                      style={{ color: activeMachine && machineOnline(activeMachine) ? colors.ok : colors.fg3 }}
                    >
                      {activeMachine && machineOnline(activeMachine) ? "●" : "○"}
                    </span>{" "}
                    {activeMachine?.name ?? ""}
                  </span>
                )}
              </span>
              {terminalOpenerText(activeChip.terminal) && (
                // P04: the opener chip on a line of its own.
                <span
                  data-testid="mobile-title-bar-opener"
                  title={terminalOpenerDescription(activeChip.terminal) ?? undefined}
                  style={{ alignSelf: "flex-start", maxWidth: "100%", boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 5px", border: `1px solid ${colors.line}`, borderRadius: 3, fontSize: 10, letterSpacing: "-0.02em", color: colors.fg2, whiteSpace: "nowrap" }}
                >
                  <span aria-hidden="true" style={{ color: colors.accent }}>⌁</span>
                  opened by {terminalOpenerText(activeChip.terminal)}
                </span>
              )}
            </>
          ) : (
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: colors.fg2, fontSize: 15, fontWeight: 600, textTransform: "lowercase" }}>No terminal</span>
              <span style={{ color: colors.fg3, fontSize: 11 }}>
                <span
                  data-testid="mobile-title-bar-dot"
                  role="img"
                  aria-label={activeMachine && machineOnline(activeMachine) ? "Online" : "Offline"}
                  style={{ color: activeMachine && machineOnline(activeMachine) ? colors.ok : colors.fg3 }}
                >
                  {activeMachine && machineOnline(activeMachine) ? "●" : "○"}
                </span>{" "}
                {activeMachine?.name ?? ""}
              </span>
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
              height: 24,
              padding: "0 8px",
              borderRadius: 3,
              boxSizing: "border-box",
              ...(deviceId !== null && controlLeases[activeMachine.id] === deviceId && !viewOnlyLocked
                ? { background: colors.primary, color: colors.onPrimary, fontWeight: 600, border: "1px solid transparent" }
                : { background: "transparent", color: colors.fg2, fontWeight: 500, border: `1px solid ${colors.line}` }),
              fontFamily: fontDisplay,
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            {viewOnlyLocked
              ? "view only"
              : deviceId !== null && controlLeases[activeMachine.id] === deviceId
                ? "in control"
                : "watching"}
          </span>
        ) : null}

        {filesButton && onToggleFiles && wideTitleBar && (
          <span
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            style={{ display: "flex", flexShrink: 0 }}
          >
            <TextButton
              square
              testId="mobile-title-bar-files"
              open={filesButton.open}
              label="Files"
              pressed={filesButton.open}
              onClick={onToggleFiles}
              style={titleBarButton}
            >
              [f]
            </TextButton>
          </span>
        )}

        {browserButton && (
          <span
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            style={{ display: "flex", flexShrink: 0 }}
          >
            <button
              type="button"
              className="odk-text-btn odk-text-btn--square"
              data-testid="mobile-title-bar-browser"
              data-open={browserButton.open ? "true" : "false"}
              aria-label="Browser"
              aria-pressed={browserButton.open}
              title={browserButton.needsPerson ? "The agent needs you" : "Browser"}
              onClick={onToggleBrowser}
              style={titleBarButton}
            >
              [b
              {browserButton.count > 0 && (
                <span data-testid="mobile-title-bar-browser-count" aria-hidden="true" style={{ fontSize: 10, color: colors.fg2 }}>
                  {browserButton.count}
                </span>
              )}
              {browserButton.needsPerson && (
                <span
                  role="img"
                  aria-label="The agent needs you"
                  data-testid="mobile-title-bar-browser-attention"
                  style={{ color: colors.err }}
                >
                  !
                </span>
              )}
              ]
            </button>
          </span>
        )}

        <button
          type="button"
          aria-label="Open Machines and Hub menu"
          title="Machines & Hub"
          aria-expanded={hostSheetOpen}
          data-testid="mobile-title-bar-machines"
          data-title-bar-swipe="ignore"
          className="odk-text-btn odk-text-btn--square"
          onClick={(event) => { event.stopPropagation(); setHostSheetOpen(true); }}
          onTouchStart={event => event.stopPropagation()}
          onTouchEnd={event => event.stopPropagation()}
          style={titleBarButton}
        >
          [m]
        </button>
      </div>

      {/* Terminal area (edge swipes switch terminals in strip order) */}
      <MobileTerminalAttention terminals={terminals} machines={machines}
        deviceId={deviceId} canSend={canSendAttention}
        activeTerminalId={activeTerminalId}
        browsers={browsers}
        runs={agentRuns}
        activeBrowserId={
          browserSurfaceOpen
            ? pickSelectedBrowserId(browsers, selectedBrowserId)
            : null
        }
        onPickBrowser={onOpenBrowser}
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
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", fontFamily: fontDisplay }}>
              <div style={{ fontSize: 13 }}>
                <span aria-hidden="true" style={{ color: colors.accent }}>~</span>
                <span aria-hidden="true"> $ </span>
                <span style={{ textTransform: "lowercase" }}>No terminals yet</span>
                <span aria-hidden="true" className="odk-cursor" />
              </div>
              {canCreateTerminal && (
                <Button testId="empty-new-terminal" onClick={() => onNewTerminal(null)} ariaLabel="Start terminal" style={{ height: 44 }}>
                  start terminal
                </Button>
              )}
            </div>
          </div>
        ) : children}
        {activeChip && activeMachine && activeChip.terminal.reachable && activeChip.terminal.attention === "confirmation"
          && !browserSurfaceOpen && !(filesButton?.open) && (
          <MobileWaitingCard
            terminal={activeChip.terminal}
            deviceId={deviceId}
            canSend={canSendAttention(activeChip.terminal.machine_id)}
            isController={deviceId !== null && controlLeases[activeMachine.id] === deviceId}
            onTakeControl={() => onRequestControl(activeMachine.id)}
          />
        )}
        {filesSurface}
        {browserSurfaceOpen && activeMachine && (
          // Over the terminal workspace, which stays mounted underneath so
          // its terminals keep their connections and size.
          <AgentBrowserMobileSurface
            machineId={activeMachine.id}
            browsers={browsers}
            selectedId={selectedBrowserId}
            deviceId={deviceId}
            onSelect={onSelectBrowser}
            onClose={onCloseBrowserSurface}
          />
        )}
      </div>

      {/* Session switcher sheet */}
      {sessionSwitcherOpen && (
        <Sheet
          header={
            <div style={{ flexShrink: 0 }}>
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
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 16px 12px",
                fontFamily: fontDisplay,
              }}>
                <span style={{ flex: 1, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>Sessions</span>
                <span data-testid="mobile-session-position" style={{ fontSize: 11.5, color: colors.fg3 }}>
                  {activePosition}/{chips.length}
                </span>
              </div>
            </div>
          }
          testid="mobile-session-switcher"
          scrollRef={sessionSwitcherScrollRef}
          onClose={() => setSessionSwitcherOpen(false)}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: "0 16px 10px" }}>
            <Button
              kind="primary"
              testId="mobile-session-switcher-new-terminal"
              ariaLabel="New terminal"
              disabled={!canCreateTerminal}
              onClick={() => {
                setSessionSwitcherOpen(false);
                onNewTerminal(activeGroup);
              }}
              style={{ height: 44 }}
            >
              new terminal
            </Button>
            <Button
              kind="secondary"
              testId="mobile-workspace-manager-button"
              ariaLabel="Tabs"
              onClick={() => {
                setSessionSwitcherOpen(false);
                setWorkspaceManagerOpen(true);
              }}
              style={{ height: 44 }}
            >
              tabs
            </Button>
          </div>
          {sessionGroups.map(({ group, panes }, groupIndex) => (
            <section key={group.id} style={{ padding: "0 16px 4px" }}>
              <div
                data-testid={`mobile-session-group-${group.id}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 0,
                  padding: "8px 4px 4px",
                  fontFamily: fontDisplay,
                  color: colors.fg3,
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{groupIndex}:{group.label}</span>
                <span style={{ whiteSpace: "nowrap" }}>
                  {"\u00a0·\u00a0"}
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
                      marginBottom: 2,
                      borderRadius: 4,
                      background: active ? colors.bg3 : "transparent",
                      borderLeft: `2px solid ${active ? colors.accent : "transparent"}`,
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
                        padding: "10px 4px 10px 12px",
                        color: colors.fg1,
                        fontFamily: fontDisplay,
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
                          fontSize: 14,
                          fontWeight: active ? 600 : 400,
                          whiteSpace: "normal",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {displayTerminalTitle(terminal)}
                        {terminal.reachable && terminal.attention === "confirmation" && (
                          <span style={{ display: "block", marginTop: 3, fontFamily: "inherit", color: colors.err, fontSize: 12, fontWeight: 500 }}>? confirmation requested</span>
                        )}
                      </span>
                      <span
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: colors.fg3,
                          fontSize: 11,
                          whiteSpace: "normal",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {terminal.cwd}
                      </span>
                      {terminalOpenerText(terminal) && (
                        <span
                          data-testid={`mobile-session-opener-${terminal.id}`}
                          title={terminalOpenerDescription(terminal) ?? undefined}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            marginTop: 4,
                            padding: "1px 6px",
                            border: `1px solid ${colors.line}`,
                            borderRadius: 3,
                            color: colors.fg2,
                            fontSize: 10.5,
                          }}
                        >
                          <span aria-hidden="true" style={{ color: colors.accent }}>⌁</span>
                          opened by {terminalOpenerText(terminal)}
                        </span>
                      )}
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
                        width: 44,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "transparent",
                        border: "none",
                        color: colors.fg3,
                        fontFamily: fontDisplay,
                        fontSize: 12,
                        cursor: canCreateTerminal ? "pointer" : "not-allowed",
                        opacity: canCreateTerminal ? 1 : 0.4,
                      }}
                    >
                      [x]
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
        <Sheet
          title="Machines"
          header={sheetVersions && hubName ? (
            <div style={{ flexShrink: 0, padding: "4px 16px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: "1 0 auto", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>Machines</span>
              <span data-testid="mobile-host-hub-version" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 500, color: colors.fg2 }}>
                hub {hubName} · {sheetVersions.hub.hub}
              </span>
            </div>
          ) : undefined}
          onClose={() => setHostSheetOpen(false)}
        >
          {(isSecureConnection() || isTauriMobile()) && <MenuRow
            icon={<ChevronRight size={18} />}
            label={isSecureConnection() ? "Hub & connection" : switchingHub ? "Opening setup…" : "Switch Hub"}
            onClick={() => {
              if (isSecureConnection()) { setHostSheetOpen(false); setHubPickerOpen(true); }
              else void switchHub();
            }}
          />}
          {switchHubError && <p role="alert" style={{ color: colors.err, padding: 16 }}>{switchHubError}</p>}
          {/* The machines as one bordered list (wireframe P06): ● name,
              os · terminals, `current` on the one you are on, [x] to remove. */}
          <div style={{ margin: "0 16px 12px", border: `1px solid ${colors.lineSoft}`, borderRadius: 6, overflow: "hidden" }}>
          {machines.map((m, index) => {
            const isActive = m.id === activeMachine?.id;
            const online = machineOnline(m);
            const controlling =
              deviceId !== null && controlLeases[m.id] === deviceId;
            const count = terminals.filter((t) => t.machine_id === m.id).length;
            const node = sheetVersions?.machines[m.id];
            const nodeLabel = online ? nodeVersionLabel(node) : null;
            const chip = online ? nodeUpdateChip(node, sheetVersions?.hub.latest ?? null) : null;
            return (
              <div
                key={m.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  background: isActive ? colors.bg3 : "transparent",
                  borderLeft: `2px solid ${isActive ? colors.accent : "transparent"}`,
                  borderTop: index === 0 ? "none" : `1px solid ${colors.lineSoft}`,
                }}
              >
              <button
                type="button"
                data-testid={`mobile-host-row-${m.id}`}
                aria-current={isActive ? "true" : undefined}
                onClick={() => {
                  onSelectMachine(m.id);
                  setHostSheetOpen(false);
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  width: "100%",
                  minHeight: 56,
                  textAlign: "left",
                  padding: "10px 12px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: colors.fg0,
                  fontFamily: fontDisplay,
                }}
              >
                <span
                  role="img"
                  aria-label={online ? (controlling ? "Online, you are in control" : "Online") : "Offline"}
                  style={{ color: online ? colors.ok : colors.fg3 }}
                >
                  {online ? "●" : "○"}
                </span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: isActive ? 600 : 400, color: online ? colors.fg0 : colors.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name}
                  </span>
                  <span style={{ fontSize: 12, color: online ? colors.fg2 : colors.fg3 }}>
                    {online ? `${m.os} · ${count} ${count === 1 ? "terminal" : "terminals"}` : "offline"}
                    {nodeLabel && node?.version ? ` · ${nodeLabel}` : null}
                  </span>
                  {nodeLabel && !node?.version ? (
                    <span style={{ fontSize: 12, color: colors.fg3 }}>{nodeLabel}</span>
                  ) : null}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {chip ? (
                    <Chip testId={`mobile-host-update-${m.id}`} title={`${sheetVersions?.hub.latest} is out`} style={{ flexShrink: 0, color: colors.accent }}>
                      {chip}
                    </Chip>
                  ) : null}
                  {/* With a chip there is no room for both on a phone; the
                      accent edge and aria-current still mark this one (P03). */}
                  {isActive && !chip ? <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: 11.5, fontWeight: 500, color: colors.accent }}>current</span> : null}
                </span>
              </button>
              <button
                type="button"
                data-testid={`mobile-host-remove-${m.id}`}
                title={`Remove ${m.name}`}
                aria-label={`Remove ${m.name}`}
                className="odk-text-btn"
                onClick={() => {
                  setHostSheetOpen(false);
                  onRemoveHost(m.id);
                }}
                style={{ width: 44, height: 44, fontSize: 12 }}
              >
                [x]
              </button>
              </div>
            );
          })}
          </div>
          {anyNodeBehind(sheetVersions) && (
            <div
              data-testid="mobile-node-update-card"
              style={{ margin: "0 16px 12px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, background: colors.bg1, border: `1px solid ${colors.lineSoft}`, borderRadius: 6 }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: colors.fg0 }}>updates happen on each Mac</span>
              <span style={{ fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>
                The phone can't update a Mac. Open Offdesk DEV there, or run the command it shows.
              </span>
              {updateCopy === "failed" ? (
                <code role="alert" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: colors.fg1, overflowWrap: "anywhere" }}>
                  {NODE_UPDATE_COMMAND}
                </code>
              ) : null}
              <Button
                kind="secondary"
                size="sm"
                testId="mobile-copy-node-update"
                onClick={() => {
                  void copyNodeUpdateCommand()
                    .then(() => setUpdateCopy("copied"))
                    .catch(() => setUpdateCopy("failed"));
                }}
                style={{ alignSelf: "flex-start", flexShrink: 0, whiteSpace: "nowrap" }}
              >
                {updateCopy === "copied" ? "copied" : "copy update command"}
              </Button>
            </div>
          )}
          {filesButton && onToggleFiles && (
            <MenuRow
              icon={<FolderOpen size={17} />}
              label="Browse files"
              testid="mobile-menu-files"
              onClick={() => {
                setHostSheetOpen(false);
                onToggleFiles();
              }}
            />
          )}
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
            label="Appearance"
            testid="mobile-menu-appearance"
            onClick={() => {
              setHostSheetOpen(false);
              setAppearanceOpen(true);
            }}
          />
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

      {appearanceOpen && <AppearanceSheet onClose={() => setAppearanceOpen(false)} />}

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
          borderRadius: 4,
          border: `1px solid ${colors.line}`,
          background: colors.bg1,
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
          <span aria-hidden="true" style={{ flexShrink: 0, color: colors.fg3 }}>›</span>
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
              borderRadius: 4,
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
  scrollRef,
  children,
}: {
  title?: string;
  header?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  testid?: string;
  onClose: () => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
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
        background: "rgb(0 0 0 / 0.6)",
        display: "flex",
        alignItems: "flex-end",
        animation: "offdeskFadeIn 120ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          background: colors.bg2,
          borderTop: `1px solid ${colors.line}`,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          fontFamily: fontDisplay,
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
            padding: "10px 0 6px",
          }}
        >
          <span
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              background: colors.line,
            }}
          />
        </div>
        {header ?? (title && (
          <div
            style={{
              flexShrink: 0,
              padding: "4px 16px 10px",
              fontFamily: fontDisplay,
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: colors.fg0,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {backLabel && <button type="button" aria-label={backLabel} onClick={onBack} style={{ border: 0, background: "none", color: "inherit", width: 44, height: 44, display: "grid", placeItems: "center", cursor: "pointer", font: "inherit", fontSize: 15 }}>←</button>}
            {title}
          </div>
        ))}
        <div ref={scrollRef} style={{ overflow: "auto", minHeight: 0, paddingBottom: 4 }}>{children}</div>
      </div>
    </div>
  );
}

function MenuRow({
  icon: _icon,
  label,
  disabled,
  danger,
  testid,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  testid?: string;
  onClick: () => void;
}) {
  // `› browse files` (wireframe P06): the chevron is drawn by CSS and the
  // label lowercased on screen, so the text stays the action's name.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      aria-label={label}
      className="odk-menu-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "calc(100% - 16px)",
        margin: "0 8px",
        minHeight: 48,
        padding: "0 12px",
        borderRadius: 4,
        color: danger ? colors.err : disabled ? colors.fg3 : colors.fg0,
        textAlign: "left",
        background: "none",
        border: "none",
        fontFamily: fontDisplay,
        fontSize: 14,
        textTransform: "lowercase",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
