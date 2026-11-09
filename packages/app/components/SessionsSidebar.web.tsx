// The desktop sessions sidebar (wireframes R01/R02, "Sidebar restyle" page of
// the Offdesk DEV design canvas; docs/plans/2026-11-10-sidebar-restyle.md).
//
// Pinned at the window's left edge, full height, in place of the tab bar:
// the top row (hide, latest-output order, new tab), the machine switcher with
// its load and round trip, then every terminal of the machine as a one-line
// row under its tab — title, age or `waiting`, one state mark — and the panel
// icons at the foot, as tall as the status line beside it. Rename, close and
// "move to" live on hover, the tab's ⋯ and right-click; tabs reorder and
// terminals move by dragging. A window too narrow to pin it opens the same
// list as a drawer over the panes (from the tab bar's ≡), without the machine
// row and the foot, which the tab bar already has.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Bot, Ellipsis, Folder, Globe, History, PanelLeft, Plus, Settings as SettingsIcon, Smartphone, X } from "lucide-react";
import type { MachineInfo, ResourceStats, TerminalInfo } from "@offdesk/shared";
import { MAX_PANES_PER_TAB } from "@offdesk/shared";

import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription } from "@/lib/terminalOpener";
import { collectPaneTerminalIds, type WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import {
  activityAge,
  groupWaitingCount,
  readSessionOrder,
  sessionRows,
  sessionState,
  writeSessionOrder,
  type SessionOrder,
  type SessionState,
} from "@/lib/sessionList";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { HostSwitcher } from "./HostSwitcher.web";
import { LoadGlyph, loadLabel } from "./MachineLoad.web";
import { Button } from "./Primitives.web";
import "./SessionsSidebar.css";

export type SessionsDropPlacement = "before" | "after";

// Distance (px) a press must travel before it becomes a drag.
const DRAG_THRESHOLD_PX = 4;

/** The machine row: the switcher, its load and the round trip. */
export interface SessionsSidebarMachine {
  machines: MachineInfo[];
  activeMachineId: string | null;
  controlLeases: Record<string, string>;
  deviceId: string | null;
  machineStats: Record<string, ResourceStats>;
  terminals: TerminalInfo[];
  stats: ResourceStats | undefined;
  rttMs: number | null;
  onSelectMachine: (id: string) => void;
  onAddMachine: () => void;
  onRemoveHost: (machineId: string) => void;
}

/** The foot: the places that open over the panes. */
export interface SessionsSidebarPanels {
  filesButton?: { open: boolean };
  onToggleFiles?: () => void;
  browserButton?: { count: number; needsPerson: boolean; open: boolean };
  onToggleBrowser?: () => void;
  onOpenPhone?: () => void;
  onOpenSettings: () => void;
}

interface SessionsSidebarProps {
  placement: "sidebar" | "drawer";
  machineName: string;
  groups: WorkspaceGroup[];
  terminalsById: Map<string, TerminalInfo>;
  activeTerminalId: string | null;
  canManage: boolean;
  /** Sidebar only; the drawer leaves both to the tab bar. */
  machine?: SessionsSidebarMachine;
  panels?: SessionsSidebarPanels;
  /** Hides the sidebar, or closes the drawer. */
  onHide: () => void;
  onSelectTerminal: (terminalId: string) => void;
  onNewGroup: () => void;
  onNewTerminal: (group: WorkspaceGroup) => void;
  onRenameGroup: (group: WorkspaceGroup) => void;
  onDeleteGroup: (group: WorkspaceGroup) => void;
  onReorderGroups: (
    sourceGroupId: string,
    targetGroupId: string,
    placement: SessionsDropPlacement,
  ) => void;
  onMoveTerminal: (terminal: TerminalInfo, targetGroup: WorkspaceGroup) => void;
  onCloseTerminal: (terminal: TerminalInfo) => void;
}

type Drag = { kind: "group"; groupId: string } | { kind: "row"; terminalId: string; groupId: string };
type DropTarget = { groupId: string; placement: SessionsDropPlacement | "into" };

function SessionsSidebarComponent({
  placement,
  machineName,
  groups,
  terminalsById,
  activeTerminalId,
  canManage,
  machine,
  panels,
  onHide,
  onSelectTerminal,
  onNewGroup,
  onNewTerminal,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
  onMoveTerminal,
  onCloseTerminal,
}: SessionsSidebarProps) {
  const isDrawer = placement === "drawer";

  const [order, setOrder] = useState<SessionOrder>(readSessionOrder);
  const toggleOrder = () => {
    const next = order === "recent" ? "tabs" : "recent";
    setOrder(next);
    writeSessionOrder(next);
  };

  // Ages read "5m" and "working" lasts a minute; refresh both.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFolded = (groupId: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  // The drawer is a dialog: Escape closes it. The pinned sidebar stays out of
  // the terminal's way and takes no keys.
  useEffect(() => {
    if (!isDrawer) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onHide();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDrawer, onHide]);

  const selectTerminal = (terminalId: string) => {
    if (suppressClickRef.current) return;
    onSelectTerminal(terminalId);
    if (isDrawer) onHide();
  };

  // Where a terminal can move: another tab with a row of its own and room.
  const moveTargets = useCallback(
    (fromGroupId: string) =>
      groups.filter(
        (group) =>
          group.id !== fromGroupId &&
          group.persistent &&
          group.workspaceGroupId !== null &&
          group.paneCount < MAX_PANES_PER_TAB,
      ),
    [groups],
  );

  /* ---------- menus ---------- */

  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const groupMenuItems = (group: WorkspaceGroup): ContextMenuEntry[] => [
    {
      label: "new terminal here",
      disabled: !canManage || group.paneCount >= MAX_PANES_PER_TAB,
      onClick: () => onNewTerminal(group),
    },
    { label: "new tab", disabled: !canManage, onClick: onNewGroup },
    {
      label: "rename tab",
      // cwd fallback groups have no persisted row to rename or delete.
      disabled: !canManage || !group.persistent,
      onClick: () => onRenameGroup(group),
    },
    { type: "separator" },
    {
      label: `close tab "${group.label}"…`,
      disabled: !canManage || !group.persistent,
      onClick: () => onDeleteGroup(group),
    },
  ];

  const rowMenuItems = (terminal: TerminalInfo, group: WorkspaceGroup): ContextMenuEntry[] => {
    const targets = moveTargets(group.id);
    return [
      ...(targets.length > 0
        ? [
            {
              label: "move to",
              disabled: !canManage,
              onClick: () => {},
              children: targets.map((target) => ({
                label: target.label,
                onClick: () => onMoveTerminal(terminal, target),
              })),
            },
            { type: "separator" as const },
          ]
        : []),
      { label: "close terminal", disabled: !canManage, onClick: () => onCloseTerminal(terminal) },
    ];
  };

  const openMenuAt = (event: ReactMouseEvent, items: ContextMenuEntry[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openMenuUnder = (event: ReactMouseEvent<HTMLElement>, items: ContextMenuEntry[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  };

  /* ---------- drag: reorder tabs, move terminals ---------- */

  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const targetAt = useCallback(
    (source: Drag, x: number, y: number): DropTarget | null => {
      const section = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-sessions-group-id]");
      const groupId = section?.dataset.sessionsGroupId;
      if (!section || !groupId || groupId === source.groupId) return null;
      if (source.kind === "group") {
        const rect = section.getBoundingClientRect();
        return { groupId, placement: y < rect.top + rect.height / 2 ? "before" : "after" };
      }
      return moveTargets(source.groupId).some((group) => group.id === groupId)
        ? { groupId, placement: "into" }
        : null;
    },
    [moveTargets],
  );

  // Pressing a tab's header or a row arms a drag; past a few pixels it
  // becomes one, and releasing earlier is a plain click. Mouse events on the
  // document, the way the tab bar drags tabs: no DnD library, and native
  // HTML drag and drop is unreliable inside the desktop app's webview.
  const armDrag = (source: Drag, event: ReactMouseEvent) => {
    if (event.button !== 0 || !canManage) return;
    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    const finish = () => {
      dragCleanupRef.current?.();
      setDrag(null);
      setDropTarget(null);
    };
    const handleMove = (moveEvent: MouseEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        active = true;
        setDrag(source);
      }
      setDropTarget(targetAt(source, moveEvent.clientX, moveEvent.clientY));
    };
    const handleUp = (upEvent: MouseEvent) => {
      finish();
      if (!active) return;
      // Swallow the click that follows this mouseup.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const target = targetAt(source, upEvent.clientX, upEvent.clientY);
      if (!target) return;
      if (source.kind === "group" && target.placement !== "into") {
        onReorderGroups(source.groupId, target.groupId, target.placement);
      } else if (source.kind === "row") {
        const terminal = terminalsById.get(source.terminalId);
        const group = groups.find((candidate) => candidate.id === target.groupId);
        if (terminal && group) onMoveTerminal(terminal, group);
      }
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", handleMove, true);
      document.removeEventListener("mouseup", handleUp, true);
      window.removeEventListener("blur", finish);
      dragCleanupRef.current = null;
    };
    document.addEventListener("mousemove", handleMove, true);
    document.addEventListener("mouseup", handleUp, true);
    window.addEventListener("blur", finish);
  };

  /* ---------- rows ---------- */

  const renderRow = (terminal: TerminalInfo, group: WorkspaceGroup, showTab: boolean) => {
    const state = sessionState(terminal, now);
    const title = displayTerminalTitle(terminal);
    const opener = terminalOpenerDescription(terminal);
    const age = activityAge(terminal.last_activity_ms, now);
    const current = terminal.id === activeTerminalId;
    return (
      <div
        key={terminal.id}
        data-testid={`sessions-row-${terminal.id}`}
        data-state={state}
        data-current={current ? "true" : undefined}
        className="odk-sessions-row"
        onContextMenu={(event) => openMenuAt(event, rowMenuItems(terminal, group))}
        onMouseDown={(event) =>
          armDrag({ kind: "row", terminalId: terminal.id, groupId: group.id }, event)
        }
      >
        <button
          type="button"
          aria-current={current ? "true" : undefined}
          title={terminal.cwd}
          onClick={() => selectTerminal(terminal.id)}
          className="odk-sessions-row-main"
        >
          <span className="odk-sessions-title">
            {opener && (
              <span
                role="img"
                aria-label={opener}
                title={opener}
                className="odk-sessions-bot"
                data-testid={`sessions-row-opener-${terminal.id}`}
              >
                <Bot size={12} strokeWidth={2} aria-hidden style={{ display: "block" }} />
              </span>
            )}
            <span className="odk-sessions-title-text">{title}</span>
            {showTab && <span className="odk-sessions-tab">{group.label}</span>}
          </span>
          <SessionRowEnd state={state} age={age} />
        </button>
        {canManage && (
          <button
            type="button"
            data-testid={`sessions-row-close-${terminal.id}`}
            aria-label={`Close ${title}`}
            title="Close"
            onClick={() => onCloseTerminal(terminal)}
            className="odk-sessions-mini odk-sessions-close"
          >
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        )}
      </div>
    );
  };

  const recentRows = useMemo(
    () => (order === "recent" ? sessionRows(groups, terminalsById, "recent") : []),
    [order, groups, terminalsById],
  );
  const hasTerminals = groups.some((group) =>
    collectPaneTerminalIds(group.root).some((id) => terminalsById.has(id)),
  );

  const list = !hasTerminals && groups.length === 0 ? (
    <div data-testid="sessions-empty" className="odk-sessions-empty">
      <span>No terminals on {machineName || "this machine"} yet.</span>
      {canManage && (
        <Button kind="primary" size="xs" onClick={onNewGroup}>
          new tab
        </Button>
      )}
    </div>
  ) : order === "recent" ? (
    <div data-testid="sessions-recent" className="odk-sessions-section">
      {recentRows.map(({ terminal, group }) => renderRow(terminal, group, true))}
    </div>
  ) : (
    groups.map((group) => {
      const terminals = collectPaneTerminalIds(group.root)
        .map((id) => terminalsById.get(id))
        .filter((terminal): terminal is TerminalInfo => Boolean(terminal));
      const waiting = groupWaitingCount(group, terminalsById);
      const isFolded = folded.has(group.id);
      return (
        <section
          key={group.id}
          data-testid={`sessions-group-${group.id}`}
          data-sessions-group-id={group.id}
          data-drop={dropTarget?.groupId === group.id ? dropTarget.placement : undefined}
          data-dragging={drag?.kind === "group" && drag.groupId === group.id ? "true" : undefined}
          aria-label={group.label}
          className="odk-sessions-section"
        >
          <div
            className="odk-sessions-group"
            onContextMenu={(event) => openMenuAt(event, groupMenuItems(group))}
            onMouseDown={(event) => armDrag({ kind: "group", groupId: group.id }, event)}
          >
            <button
              type="button"
              data-testid={`sessions-group-name-${group.id}`}
              aria-expanded={!isFolded}
              title={isFolded ? "Show its terminals" : "Fold"}
              onClick={() => {
                if (!suppressClickRef.current) toggleFolded(group.id);
              }}
              className="odk-sessions-group-name"
            >
              {isFolded && <span aria-hidden="true">▸</span>}
              <span>{group.label}</span>
            </button>
            <span className="odk-sessions-group-count" aria-label={`${terminals.length} terminals`}>
              {terminals.length}
            </span>
            <span className="odk-sessions-group-end">
              {waiting > 0 && (
                <span data-testid={`sessions-group-waiting-${group.id}`} className="odk-sessions-group-waiting">
                  {waiting} waiting
                </span>
              )}
              <span className="odk-sessions-group-actions">
                <button
                  type="button"
                  data-testid={`sessions-group-new-${group.id}`}
                  aria-label={`New terminal in ${group.label}`}
                  title="New terminal here"
                  disabled={!canManage || group.paneCount >= MAX_PANES_PER_TAB}
                  onClick={() => onNewTerminal(group)}
                  className="odk-sessions-mini"
                >
                  <Plus size={13} strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  data-testid={`sessions-group-menu-${group.id}`}
                  aria-label={`${group.label} menu`}
                  aria-haspopup="menu"
                  title="Rename, close"
                  onClick={(event) => openMenuUnder(event, groupMenuItems(group))}
                  className="odk-sessions-mini"
                >
                  <Ellipsis size={13} strokeWidth={2} aria-hidden />
                </button>
              </span>
            </span>
          </div>
          {!isFolded && terminals.map((terminal) => renderRow(terminal, group, false))}
        </section>
      );
    })
  );

  const panel = (
    <nav
      data-testid="sessions-sidebar"
      data-placement={placement}
      aria-label="Sessions"
      className={`odk-sessions${isDrawer ? " odk-sessions--drawer" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="odk-sessions-top">
        <span className="odk-sessions-top-label">{isDrawer ? machineName : null}</span>
        <button
          type="button"
          data-testid="sessions-sidebar-hide"
          aria-label={isDrawer ? "Close the sessions list" : "Hide the sidebar"}
          title={isDrawer ? "Close" : "Hide the sidebar"}
          onClick={onHide}
          className="odk-sessions-icon"
        >
          {isDrawer ? <X size={15} aria-hidden /> : <PanelLeft size={15} aria-hidden />}
        </button>
        <button
          type="button"
          data-testid="sessions-sidebar-order"
          aria-label="Latest output first"
          title={order === "recent" ? "Latest output first (on)" : "Latest output first"}
          aria-pressed={order === "recent"}
          onClick={toggleOrder}
          className="odk-sessions-icon"
        >
          <History size={15} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="sessions-sidebar-new"
          aria-label="New tab"
          title={canManage ? "New tab" : "Take control to create a terminal"}
          disabled={!canManage}
          onClick={onNewGroup}
          className="odk-sessions-icon"
        >
          <Plus size={15} aria-hidden />
        </button>
      </div>

      {machine && (
        <div className="odk-sessions-machine">
          <HostSwitcher
            compact
            machines={machine.machines}
            activeMachineId={machine.activeMachineId}
            controlLeases={machine.controlLeases}
            deviceId={machine.deviceId}
            machineStats={machine.machineStats}
            terminals={machine.terminals}
            onSelectMachine={machine.onSelectMachine}
            onAddMachine={machine.onAddMachine}
            onRemoveHost={machine.onRemoveHost}
            trailing={<LoadGlyph stats={machine.stats} />}
            trailingLabel={loadLabel(machine.stats)}
            menuAlign="left"
          />
          <span data-testid="sessions-sidebar-rtt" className="odk-sessions-rtt" title="Round trip to the hub">
            {machine.rttMs === null ? "—" : `${Math.round(machine.rttMs)}ms`}
          </span>
        </div>
      )}

      <div className="odk-sessions-list">{list}</div>

      {panels && (
        <div className="odk-sessions-foot">
          {panels.filesButton && panels.onToggleFiles && (
            <button
              type="button"
              data-testid="sessions-sidebar-files"
              aria-label="Files"
              title="Files"
              aria-pressed={panels.filesButton.open}
              data-open={panels.filesButton.open ? "true" : "false"}
              onClick={panels.onToggleFiles}
              className="odk-sessions-icon"
            >
              <Folder size={15} aria-hidden />
            </button>
          )}
          {panels.browserButton && panels.onToggleBrowser && (
            <button
              type="button"
              data-testid="sessions-sidebar-browser"
              aria-label={panels.browserButton.needsPerson ? "Browser, the agent needs you" : "Browser"}
              title={panels.browserButton.needsPerson ? "The agent needs you" : "Browser"}
              aria-pressed={panels.browserButton.open}
              data-open={panels.browserButton.open ? "true" : "false"}
              onClick={panels.onToggleBrowser}
              className="odk-sessions-icon"
            >
              <Globe size={15} aria-hidden />
              {panels.browserButton.count > 0 && (
                <span aria-hidden="true">
                  {panels.browserButton.count > 99 ? "99+" : panels.browserButton.count}
                </span>
              )}
              {panels.browserButton.needsPerson && (
                <span aria-hidden="true" className="odk-sessions-alert">!</span>
              )}
            </button>
          )}
          {panels.onOpenPhone && (
            <button
              type="button"
              data-testid="sessions-sidebar-phone"
              aria-label="Open this hub on your phone"
              title="Phone"
              onClick={panels.onOpenPhone}
              className="odk-sessions-icon"
            >
              <Smartphone size={15} aria-hidden />
            </button>
          )}
          <span className="odk-sessions-foot-fill" />
          <button
            type="button"
            data-testid="sessions-sidebar-settings"
            aria-label="Settings"
            title="Settings"
            onClick={panels.onOpenSettings}
            className="odk-sessions-icon"
          >
            <SettingsIcon size={15} aria-hidden />
          </button>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </nav>
  );

  if (!isDrawer) return panel;
  return (
    <div data-testid="sessions-drawer" className="odk-sessions-scrim" onClick={onHide}>
      {panel}
    </div>
  );
}

export const SessionsSidebar = memo(SessionsSidebarComponent);

/** A row's right end: `waiting`, `offline` or the age, then its mark. The
 *  phone's sessions sheet (MobileWorkbench) draws its rows with it too. */
export function SessionRowEnd({ state, age }: { state: SessionState; age: string | null }) {
  return (
    <span className="odk-sessions-end">
      {state === "waiting" ? (
        <span className="odk-sessions-meta odk-sessions-meta--waiting">waiting</span>
      ) : state === "offline" ? (
        <span className="odk-sessions-meta">offline</span>
      ) : age ? (
        <span className="odk-sessions-meta" title="Last output">{age}</span>
      ) : null}
      <StateMark state={state} />
    </span>
  );
}

/** One 12px mark: the working arc turns, waiting is a filled ring. */
function StateMark({ state }: { state: SessionState }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    "aria-hidden": true,
    className: `odk-sessions-mark odk-sessions-mark--${state}`,
  } as const;
  switch (state) {
    case "waiting":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="rgb(var(--color-err))" strokeWidth="1.5" />
          <circle cx="6" cy="6" r="2" fill="rgb(var(--color-err))" />
        </svg>
      );
    case "working":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="rgb(var(--color-line))" strokeWidth="1.5" />
          <path d="M6 1.75A4.25 4.25 0 0 1 10.25 6" fill="none" stroke="rgb(var(--color-accent))" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "offline":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="rgb(var(--color-fg-3))" strokeWidth="1.5" strokeDasharray="2 2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="rgb(var(--color-fg-3))" strokeWidth="1.5" />
        </svg>
      );
  }
}
