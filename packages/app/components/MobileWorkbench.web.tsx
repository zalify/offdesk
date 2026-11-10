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
  ChevronsUpDown,
  Keyboard as KeyboardIcon,
  Lock,
  LockOpen,
  Monitor,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  X,
  Bot,
  Ellipsis,
} from "lucide-react";
import { MAX_PANES_PER_TAB } from "@offdesk/shared";
import { colors, colorAlpha } from "@/lib/colors";
import { pickSelectedBrowserId } from "@/lib/agentBrowserOverlay";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription } from "@/lib/terminalOpener";
import { activityAge, groupWaitingCount, sessionState } from "@/lib/sessionList";
import { useLongPress } from "@/lib/longPress";
import {
  buildMobileSessionGroups,
  type MobileSessionPane,
} from "@/lib/mobileSessionSwitcher";
import type { WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { SessionRowEnd } from "./SessionsSidebar.web";
import { anyNodeBehind, copyNodeUpdateCommand, nodeUpdateChip, nodeVersionLabel, NODE_UPDATE_COMMAND, useSheetVersions } from "@/lib/machineVersions";
import { Button, Chip, TextButton, fontDisplay, fontProse } from "./Primitives.web";
import { rem } from "@/lib/rem";

// The title bar's [f] [b] [m]: 40px squares, so five fit beside the
// session title on a 320px phone.
const titleBarButton = { width: 40, height: 40, minWidth: 40, minHeight: 40, fontSize: rem(13) } as const;

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
  const [chipSheet, setChipSheet] = useState<MobileSessionPane | null>(null);
  // A tab's actions, from its header in the session switcher.
  const [groupSheet, setGroupSheet] = useState<WorkspaceGroup | null>(null);
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

  // Ages read "5m" and "working" lasts a minute; refresh both while the
  // switcher shows them.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sessionSwitcherOpen) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [sessionSwitcherOpen]);

  // Holding a switcher row opens its actions (iOS fires no contextmenu); the
  // click that ends the hold must not also pick the row.
  const pendingRowRef = useRef<MobileSessionPane | null>(null);
  const suppressRowClickRef = useRef(false);
  const rowLongPress = useLongPress(() => {
    const pane = pendingRowRef.current;
    if (!pane) return;
    suppressRowClickRef.current = true;
    setChipSheet(pane);
  }, sessionSwitcherOpen);

  const activeMachine =
    machines.find((m) => m.id === activeMachineId) ?? machines[0] ?? null;
  const activeStats = activeMachine ? machineStats[activeMachine.id] : undefined;
  const isController =
    activeMachine !== null &&
    deviceId !== null &&
    controlLeases[activeMachine.id] === deviceId;
  // In control is the usual state and shows nothing; the others are a word
  // on the subtitle line (view only also takes over the key bar).
  const controlNote = !activeMachine || isController ? null : viewOnlyLocked ? "view only" : "watching";

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
          padding: "0 4px 0 8px",
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
          // A picker field (wireframe B, "Phone title bar" canvas): the boxed
          // title and ⇕ say "tap to switch or add a session".
          style={{
            boxSizing: "border-box", minHeight: 36, padding: "3px 8px 3px 10px",
            background: colors.bg2, border: `1px solid ${colors.line}`, borderRadius: 4,
            textAlign: "left", cursor: "pointer",
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            overflow: "hidden",
            whiteSpace: "nowrap",
            color: colors.fg0,
            fontFamily: fontDisplay,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 1, overflow: "hidden" }}>
          {activeChip ? (
            <>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, fontSize: rem(14), fontWeight: 600, lineHeight: 1.1 }}>
                {displayTerminalTitle(activeChip.terminal)}
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  minWidth: 0,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  color: colors.fg3,
                  fontSize: rem(10.5),
                  lineHeight: 1.15,
                }}
              >
                {resumeNotice ?? (<>
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
                  {/* Kept whole: the machine name gives way first. */}
                  {controlNote && <span data-testid="mobile-title-bar-control" style={{ flexShrink: 0, whiteSpace: "pre" }}> · {controlNote}</span>}
                </>)}
              </span>
              {terminalOpenerDescription(activeChip.terminal) && (
                // P04: the agent marker on a line of its own; which agent is
                // in its title.
                <span
                  data-testid="mobile-title-bar-opener"
                  title={terminalOpenerDescription(activeChip.terminal) ?? undefined}
                  style={{ alignSelf: "flex-start", maxWidth: "100%", boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 5px", border: `1px solid ${colors.line}`, borderRadius: 3, fontSize: rem(10), letterSpacing: "-0.02em", color: colors.fg2, whiteSpace: "nowrap" }}
                >
                  <Bot size={11} strokeWidth={2} aria-hidden />
                  agent
                </span>
              )}
            </>
          ) : (
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: colors.fg2, fontSize: rem(14), fontWeight: 600, textTransform: "lowercase" }}>No terminal</span>
              <span style={{ color: colors.fg3, fontSize: rem(10.5) }}>
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
          </span>
          <ChevronsUpDown aria-hidden size={16} style={{ flexShrink: 0, color: colors.fg1 }} />
        </button>


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
                <span data-testid="mobile-title-bar-browser-count" aria-hidden="true" style={{ fontSize: rem(10), color: colors.fg2 }}>
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
              fontSize: rem(14),
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", fontFamily: fontDisplay }}>
              <div style={{ fontSize: rem(13) }}>
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

      {/* Session switcher sheet (wireframe R05): the desktop sidebar's
          one-line rows at touch height. Holding a row (or right-clicking
          it) opens its actions, the title bar's sheet; a tab's header opens
          the tab's. */}
      {sessionSwitcherOpen && (
        <Sheet
          header={
            <div
              data-testid="mobile-session-header"
              style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "0 8px 4px 20px", fontFamily: fontDisplay }}
            >
              <h2 style={{ margin: 0, fontSize: rem(17), fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>sessions</h2>
              <span data-testid="mobile-session-position" style={{ fontSize: rem(11.5), color: colors.fg3 }}>
                {activePosition}/{chips.length}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid="mobile-host-button"
                aria-label={`Open machines (${activeMachine?.name ?? "no machine"})`}
                disabled={!activeMachine}
                onClick={() => {
                  setSessionSwitcherOpen(false);
                  setHostSheetOpen(true);
                }}
                className="odk-text-btn odk-text-btn--strong"
                style={{ minHeight: 44, minWidth: 0, maxWidth: "62%", gap: 8, padding: "0 8px", fontSize: rem(13), fontWeight: 500 }}
              >
                {activeMachine && !machineOnline(activeMachine) && (
                  <span role="img" aria-label="Offline" style={{ color: colors.fg3 }}>○</span>
                )}
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeMachine?.name ?? "no machine"}
                </span>
                <span aria-hidden="true" style={{ color: colors.fg3 }}>▾</span>
                <span data-testid="mobile-session-header-rtt" style={{ fontSize: rem(11.5), fontWeight: 400, color: colors.fg3 }}>
                  {rttMs === null ? "—" : `${Math.round(rttMs)}ms`}
                </span>
              </button>
            </div>
          }
          footer={
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 12px", paddingTop: 10, borderTop: `1px solid ${colors.lineSoft}` }}>
              <span style={{ flex: 1, minWidth: 0, paddingLeft: 8, fontFamily: fontProse, fontSize: rem(12), lineHeight: 1.4, color: colors.fg3 }}>
                Hold a row to move or close it. Tap a tab for its actions.
              </span>
              <Button
                kind="primary"
                testId="mobile-session-switcher-new-terminal"
                ariaLabel="New terminal"
                disabled={!canCreateTerminal}
                onClick={() => {
                  setSessionSwitcherOpen(false);
                  onNewTerminal(activeGroup);
                }}
                style={{ height: 44, flexShrink: 0 }}
              >
                new terminal
              </Button>
            </div>
          }
          testid="mobile-session-switcher"
          scrollRef={sessionSwitcherScrollRef}
          onClose={() => setSessionSwitcherOpen(false)}
        >
          <div className="odk-sessions-touch">
            {sessionGroups.map(({ group, panes }) => {
              const waiting = groupWaitingCount(group, scopedTerminalsById);
              return (
                <section key={group.id} aria-label={group.label} className="odk-sessions-section">
                  <button
                    type="button"
                    data-testid={`mobile-session-group-${group.id}`}
                    aria-haspopup="dialog"
                    title="Tab actions"
                    onClick={() => setGroupSheet(group)}
                    className="odk-sessions-touch-group"
                  >
                    <span className="odk-sessions-touch-group-label">{group.label}</span>
                    <span className="odk-sessions-group-count">{panes.length}</span>
                    <span className="odk-sessions-group-end">
                      {waiting > 0 && <span className="odk-sessions-group-waiting">{waiting} waiting</span>}
                      <Ellipsis size={15} aria-hidden />
                    </span>
                  </button>
                  {panes.map((pane) => {
                    const { terminal } = pane;
                    const state = sessionState(terminal, now);
                    const opener = terminalOpenerDescription(terminal);
                    const current = terminal.id === activeTerminalId;
                    return (
                      <div
                        key={terminal.id}
                        data-state={state}
                        data-current={current ? "true" : undefined}
                        className="odk-sessions-row"
                      >
                        <button
                          type="button"
                          data-testid={`mobile-session-row-${terminal.id}`}
                          aria-current={current ? "true" : undefined}
                          title={terminal.cwd}
                          className="odk-sessions-row-main"
                          onPointerDown={(event) => {
                            pendingRowRef.current = pane;
                            suppressRowClickRef.current = false;
                            rowLongPress.onPointerDown(event);
                          }}
                          onPointerMove={rowLongPress.onPointerMove}
                          onPointerUp={rowLongPress.onPointerUp}
                          onPointerCancel={rowLongPress.onPointerCancel}
                          onContextMenu={(event) => {
                            // Android's long-press, and a mouse's right click.
                            event.preventDefault();
                            setChipSheet(pane);
                          }}
                          onClick={() => {
                            if (suppressRowClickRef.current) {
                              suppressRowClickRef.current = false;
                              return;
                            }
                            onPickTerminal(terminal.id);
                            setSessionSwitcherOpen(false);
                          }}
                        >
                          <span className="odk-sessions-title">
                            {opener && (
                              <span
                                role="img"
                                aria-label={opener}
                                title={opener}
                                data-testid={`mobile-session-opener-${terminal.id}`}
                                className="odk-sessions-bot"
                              >
                                <Bot size={13} strokeWidth={2} aria-hidden style={{ display: "block" }} />
                              </span>
                            )}
                            <span className="odk-sessions-title-text">{displayTerminalTitle(terminal)}</span>
                          </span>
                          <SessionRowEnd state={state} age={activityAge(terminal.last_activity_ms, now)} />
                        </button>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </Sheet>
      )}

      {/* A tab's actions: what the old tab tree sheet did, one tab at a time. */}
      {groupSheet && (() => {
        const index = groups.findIndex((group) => group.id === groupSheet.id);
        const close = () => setGroupSheet(null);
        return (
          <Sheet title={groupSheet.label} testid="mobile-group-sheet" onClose={close}>
            <MenuRow
              label="New terminal here"
              testid="mobile-group-new-terminal"
              disabled={!canCreateTerminal || groupSheet.paneCount >= MAX_PANES_PER_TAB}
              onClick={() => {
                close();
                setSessionSwitcherOpen(false);
                onNewTerminal(groupSheet);
              }}
            />
            <MenuRow
              label="New tab"
              testid="mobile-group-new-tab"
              disabled={!isController}
              onClick={() => {
                close();
                onNewGroup();
              }}
            />
            <MenuRow
              label="Rename tab"
              testid="mobile-group-rename"
              // cwd fallback groups have no persisted row to rename or close.
              disabled={!isController || !groupSheet.persistent}
              onClick={() => {
                close();
                setSessionSwitcherOpen(false);
                onRenameGroup(groupSheet);
              }}
            />
            <MenuRow
              label="Move up"
              testid="mobile-group-up"
              disabled={!isController || index <= 0}
              onClick={() => {
                close();
                onReorderGroups(groupSheet.id, groups[index - 1].id, "before");
              }}
            />
            <MenuRow
              label="Move down"
              testid="mobile-group-down"
              disabled={!isController || index < 0 || index >= groups.length - 1}
              onClick={() => {
                close();
                onReorderGroups(groupSheet.id, groups[index + 1].id, "after");
              }}
            />
            <MenuRow
              label="Close tab"
              danger
              testid="mobile-group-close"
              disabled={!isController || !groupSheet.persistent}
              onClick={() => {
                close();
                setSessionSwitcherOpen(false);
                onDeleteGroup(groupSheet);
              }}
            />
          </Sheet>
        );
      })()}

      {hubPickerOpen && <Sheet title="Hubs & connections" backLabel="Back to Machines" onBack={() => { setHubPickerOpen(false); setHostSheetOpen(true); }} onClose={() => setHubPickerOpen(false)}><HubPickerPanel /></Sheet>}

      {/* Host sheet */}
      {hostSheetOpen && (
        <Sheet
          title="Machines"
          header={sheetVersions && hubName ? (
            <div style={{ flexShrink: 0, padding: "4px 16px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: "1 0 auto", fontSize: rem(20), fontWeight: 600, letterSpacing: "-0.02em", color: colors.fg0 }}>Machines</span>
              <span data-testid="mobile-host-hub-version" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: rem(12.5), fontWeight: 500, color: colors.fg2 }}>
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
                  <span style={{ fontSize: rem(14), fontWeight: isActive ? 600 : 400, color: online ? colors.fg0 : colors.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name}
                  </span>
                  <span style={{ fontSize: rem(12), color: online ? colors.fg2 : colors.fg3 }}>
                    {online ? `${m.os} · ${count} ${count === 1 ? "terminal" : "terminals"}` : "offline"}
                    {nodeLabel && node?.version ? ` · ${nodeLabel}` : null}
                  </span>
                  {nodeLabel && !node?.version ? (
                    <span style={{ fontSize: rem(12), color: colors.fg3 }}>{nodeLabel}</span>
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
                  {isActive && !chip ? <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: rem(11.5), fontWeight: 500, color: colors.accent }}>current</span> : null}
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
                style={{ width: 44, height: 44, fontSize: rem(12) }}
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
              <span style={{ fontSize: rem(13), fontWeight: 600, color: colors.fg0 }}>updates happen on each Mac</span>
              <span style={{ fontFamily: fontProse, fontSize: rem(13), lineHeight: rem(20), color: colors.fg2 }}>
                The phone can't update a Mac. Open Offdesk Dev there, or run the command it shows.
              </span>
              {updateCopy === "failed" ? (
                <code role="alert" style={{ fontFamily: "var(--font-mono)", fontSize: rem(12), color: colors.fg1, overflowWrap: "anywhere" }}>
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
          {groups
            .filter(
              (group) =>
                group.id !== chipSheet.group.id &&
                group.persistent &&
                group.workspaceGroupId !== null &&
                group.paneCount < MAX_PANES_PER_TAB,
            )
            .map((group) => (
              <MenuRow
                key={group.id}
                label={`Move to ${group.label}`}
                disabled={!isController}
                testid={`mobile-chip-move-${group.id}`}
                onClick={() => {
                  const { terminal } = chipSheet;
                  setChipSheet(null);
                  onMoveTerminal(terminal, group);
                }}
              />
            ))}
        </Sheet>
      )}
    </div>
  );
}

export const MobileWorkbench = memo(MobileWorkbenchComponent);

/* ---------- sheets ---------- */

function Sheet({
  title,
  header,
  backLabel,
  onBack,
  testid,
  onClose,
  scrollRef,
  footer,
  children,
}: {
  title?: string;
  header?: React.ReactNode;
  /** Stays below the scrolling list. */
  footer?: React.ReactNode;
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
              fontSize: rem(20),
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: colors.fg0,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {backLabel && <button type="button" aria-label={backLabel} onClick={onBack} style={{ border: 0, background: "none", color: "inherit", width: 44, height: 44, display: "grid", placeItems: "center", cursor: "pointer", font: "inherit", fontSize: rem(15) }}>←</button>}
            {title}
          </div>
        ))}
        <div ref={scrollRef} style={{ overflow: "auto", minHeight: 0, paddingBottom: 4 }}>{children}</div>
        {footer}
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
        fontSize: rem(14),
        textTransform: "lowercase",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
