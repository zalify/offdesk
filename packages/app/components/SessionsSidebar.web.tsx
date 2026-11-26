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
import { Bot, Ellipsis, Folder, FolderGit2, Globe, History, PanelLeft, Pencil, Plus, Settings as SettingsIcon, Smartphone, X } from "lucide-react";
import type { MachineInfo, ResourceStats, SpaceInfo, TerminalInfo } from "@offdesk/shared";
import { MAX_PANES_PER_TAB } from "@offdesk/shared";

import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription } from "@/lib/terminalOpener";
import { collectPaneTerminalIds, type WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { countWaitingBySpace, DEFAULT_SPACE_COLOR, filterGroupsBySpace } from "@/lib/spaces";
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
  onOpenChat?: () => void;
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
  onRenameTerminal?: (terminal: TerminalInfo, title: string) => void;
  shelvedTerminalIds?: Set<string>;
  onShelfTerminal?: (terminal: TerminalInfo) => void;
  spaces?: SpaceInfo[];
  activeSpaceId?: string | null;
  onSelectSpace?: (spaceId: string | null) => void;
  onOpenSpaceModal?: (space?: SpaceInfo | null) => void;
  onMoveGroupToSpace?: (group: WorkspaceGroup, spaceId: string | null) => void;
}

type Drag = { kind: "group"; groupId: string } | { kind: "row"; terminalId: string; groupId: string };
type DropTarget = { groupId: string; placement: SessionsDropPlacement | "into" };
type SessionFilter = "all" | "waiting" | "working";

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
  onRenameTerminal,
  shelvedTerminalIds,
  onShelfTerminal,
  spaces = [],
  activeSpaceId = null,
  onSelectSpace,
  onOpenSpaceModal,
  onMoveGroupToSpace,
}: SessionsSidebarProps) {
  const [renamingTerminalId, setRenamingTerminalId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const startRenameTerminal = (terminal: TerminalInfo) => {
    setRenamingTerminalId(terminal.id);
    setRenameDraft(terminal.custom_title?.trim() || displayTerminalTitle(terminal));
  };
  const commitRenameTerminal = (terminal: TerminalInfo) => {
    setRenamingTerminalId(null);
    onRenameTerminal?.(terminal, renameDraft.trim());
  };
  const isDrawer = placement === "drawer";

  const [order, setOrder] = useState<SessionOrder>(readSessionOrder);
  const [projectMode, setProjectMode] = useState(false);
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

  const [filter, setFilter] = useState<SessionFilter>("all");

  // Track terminals that finished working while in the background (working ->
  // quiet/waiting) so the user can spot completed agents at a glance.
  const prevStatesRef = useRef<Map<string, SessionState>>(new Map());
  const [unreadIds, setUnreadIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const prev = prevStatesRef.current;
    const next = new Map<string, SessionState>();
    const newlyDone: string[] = [];
    for (const [id, terminal] of terminalsById) {
      const state = sessionState(terminal, now);
      next.set(id, state);
      const before = prev.get(id);
      if (
        before === "working" &&
        (state === "quiet" || state === "waiting") &&
        id !== activeTerminalId
      ) {
        newlyDone.push(id);
      }
    }
    prevStatesRef.current = next;
    if (newlyDone.length > 0) {
      setUnreadIds((current) => {
        const updated = new Set(current);
        for (const id of newlyDone) updated.add(id);
        return updated;
      });
    }
  }, [terminalsById, now, activeTerminalId]);

  useEffect(() => {
    if (!activeTerminalId) return;
    setUnreadIds((current) => {
      if (!current.has(activeTerminalId)) return current;
      const updated = new Set(current);
      updated.delete(activeTerminalId);
      return updated;
    });
  }, [activeTerminalId]);

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
    ...(onMoveGroupToSpace && spaces.length > 0
      ? [
          {
            label: "move to space",
            disabled: !canManage || !group.persistent,
            onClick: () => {},
            children: [
              ...spaces.map((space) => ({
                label: `${group.spaceId === space.id ? "✓ " : ""}${space.icon ? `${space.icon} ` : ""}${space.name}`,
                disabled: group.spaceId === space.id,
                onClick: () => onMoveGroupToSpace(group, space.id),
              })),
              ...(group.spaceId
                ? [
                    {
                      label: "Default",
                      onClick: () => onMoveGroupToSpace(group, null),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
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
      ...(onRenameTerminal
        ? [
            {
              label: "rename",
              onClick: () => startRenameTerminal(terminal),
            },
          ]
        : []),
      ...(onShelfTerminal
        ? [
            {
              label: "minimize to shelf (—)",
              onClick: () => onShelfTerminal(terminal),
            },
          ]
        : []),
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
    const unread = !current && unreadIds.has(terminal.id);
    return (
      <div
        key={terminal.id}
        data-testid={`sessions-row-${terminal.id}`}
        data-state={state}
        data-current={current ? "true" : undefined}
        data-unread={unread ? "true" : undefined}
        className="odk-sessions-row"
        onContextMenu={(event) => openMenuAt(event, rowMenuItems(terminal, group))}
        onMouseDown={(event) => {
          if (renamingTerminalId === terminal.id) return;
          armDrag({ kind: "row", terminalId: terminal.id, groupId: group.id }, event);
        }}
      >
        {renamingTerminalId === terminal.id ? (
          <div
            className="odk-sessions-row-main"
            style={{ padding: "2px 6px", cursor: "text" }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              autoFocus
              aria-label={`Rename ${title}`}
              placeholder="Empty resets to auto title"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => commitRenameTerminal(terminal)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229) {
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRenameTerminal(terminal);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenamingTerminalId(null);
                }
              }}
              style={{
                width: "100%",
                background: "rgb(var(--color-bg-0))",
                color: "rgb(var(--color-fg-0))",
                border: "1px solid rgb(var(--color-accent))",
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: "0.75rem",
                fontFamily: "inherit",
                outline: "none",
              }}
            />
          </div>
        ) : (
        <button
          type="button"
          aria-current={current ? "true" : undefined}
          title={terminal.cwd}
          onClick={() => selectTerminal(terminal.id)}
          onDoubleClick={(event) => {
            if (!onRenameTerminal) return;
            event.preventDefault();
            startRenameTerminal(terminal);
          }}
          className="odk-sessions-row-main"
        >
          <span className="odk-sessions-title">
            {unread && (
              <span
                aria-label="Finished while inactive"
                title="Finished while inactive"
                className="odk-sessions-unread"
              />
            )}
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
        )}
        {canManage && renamingTerminalId !== terminal.id && (
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

  const activeSpace = useMemo(
    () => (activeSpaceId ? spaces.find((s) => s.id === activeSpaceId) ?? null : null),
    [activeSpaceId, spaces],
  );
  const scopedGroups = useMemo(
    () => filterGroupsBySpace(groups, activeSpaceId),
    [groups, activeSpaceId],
  );
  const waitingBySpace = useMemo(
    () => countWaitingBySpace(groups, terminalsById),
    [groups, terminalsById],
  );
  const defaultSpaceWaiting = waitingBySpace.bySpace.get(null) ?? 0;

  const recentRows = useMemo(
    () => (order === "recent" ? sessionRows(scopedGroups, terminalsById, "recent") : []),
    [order, scopedGroups, terminalsById],
  );
  const allMachineTerminals = useMemo(() => {
    const result: TerminalInfo[] = [];
    for (const group of scopedGroups) {
      for (const id of collectPaneTerminalIds(group.root)) {
        const terminal = terminalsById.get(id);
        if (terminal) result.push(terminal);
      }
    }
    return result;
  }, [scopedGroups, terminalsById]);
  const hasTerminals = allMachineTerminals.length > 0;
  const waitingTotal = useMemo(
    () => allMachineTerminals.filter((t) => sessionState(t, now) === "waiting").length,
    [allMachineTerminals, now],
  );
  const workingTotal = useMemo(
    () => allMachineTerminals.filter((t) => sessionState(t, now) === "working").length,
    [allMachineTerminals, now],
  );
  const matchesFilter = useCallback(
    (terminal: TerminalInfo) => {
      if (filter === "all") return true;
      return sessionState(terminal, now) === filter;
    },
    [filter, now],
  );

  const filteredRecentRows = useMemo(
    () => (filter === "all" ? recentRows : recentRows.filter(({ terminal }) => matchesFilter(terminal))),
    [filter, matchesFilter, recentRows],
  );

  const visibleGroups = useMemo(() => {
    return scopedGroups
      .map((group) => {
        const all = collectPaneTerminalIds(group.root)
          .map((id) => terminalsById.get(id))
          .filter(
            (terminal): terminal is TerminalInfo =>
              terminal != null && !shelvedTerminalIds?.has(terminal.id),
          );
        const terminals = filter === "all" ? all : all.filter(matchesFilter);
        return { group, terminals, totalCount: all.length };
      })
      .filter(({ terminals }) => filter === "all" || terminals.length > 0);
  }, [filter, scopedGroups, matchesFilter, terminalsById, shelvedTerminalIds]);

  const projectGroups = useMemo(() => {
    if (!projectMode) return [];
    const byProject = new Map<string, { terminal: TerminalInfo; group: WorkspaceGroup }[]>();
    for (const group of scopedGroups) {
      for (const id of collectPaneTerminalIds(group.root)) {
        const terminal = terminalsById.get(id);
        if (!terminal || shelvedTerminalIds?.has(terminal.id)) continue;
        if (filter !== "all" && !matchesFilter(terminal)) continue;
        const raw = (terminal.cwd || "~").replace(/\/+$/, "");
        const segs = raw.split("/").filter(Boolean);
        let proj = segs[segs.length - 1] || "~";
        const pIdx = segs.findIndex((s) =>
          ["projects", "repos", "code", "work", "workspaces"].includes(s.toLowerCase()),
        );
        if (pIdx >= 0 && segs[pIdx + 1]) proj = segs[pIdx + 1];
        const arr = byProject.get(proj) ?? [];
        arr.push({ terminal, group });
        byProject.set(proj, arr);
      }
    }
    return Array.from(byProject.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projectMode, scopedGroups, terminalsById, shelvedTerminalIds, filter, matchesFilter]);

  const list = !hasTerminals && scopedGroups.length === 0 ? (
    <div data-testid="sessions-empty" className="odk-sessions-empty">
      <span>
        {activeSpace
          ? `No terminals in ${activeSpace.name} yet.`
          : `No terminals on ${machineName || "this machine"} yet.`}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {canManage && (
          <Button kind="primary" size="xs" onClick={onNewGroup}>
            new tab
          </Button>
        )}
        {activeSpace && onSelectSpace && (
          <Button kind="secondary" size="xs" onClick={() => onSelectSpace(null)}>
            all spaces
          </Button>
        )}
      </div>
    </div>
  ) : filter !== "all" &&
    ((order === "recent" && filteredRecentRows.length === 0) ||
      (order !== "recent" && visibleGroups.length === 0)) ? (
    <div data-testid="sessions-filter-empty" className="odk-sessions-empty">
      <span>No {filter} terminals right now.</span>
      <Button kind="secondary" size="xs" onClick={() => setFilter("all")}>
        show all
      </Button>
    </div>
  ) : order === "recent" ? (
    <div data-testid="sessions-recent" className="odk-sessions-section">
      {filteredRecentRows
        .filter(({ terminal }) => !shelvedTerminalIds?.has(terminal.id))
        .map(({ terminal, group }) => renderRow(terminal, group, true))}
    </div>
  ) : projectMode ? (
    projectGroups.map(([projName, items]) => (
      <section key={projName} className="odk-sessions-section" aria-label={projName}>
        <div className="odk-sessions-group">
          <span className="odk-sessions-group-name">
            <span>{projName}</span>
          </span>
          <span className="odk-sessions-group-count">{items.length}</span>
        </div>
        <div className="odk-sessions-rows">
          {items.map(({ terminal, group }) => renderRow(terminal, group, false))}
        </div>
      </section>
    ))
  ) : (
    visibleGroups.map(({ group, terminals }) => {
      const waiting = groupWaitingCount(group, terminalsById);
      const isFolded = folded.has(group.id);
      const isEmpty = terminals.length === 0;
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
            className={`odk-sessions-group${isEmpty ? " odk-sessions-group--empty" : ""}`}
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
          data-testid="sessions-sidebar-project-mode"
          aria-label="Group by project"
          title={projectMode ? "Grouped by project (click for tabs)" : "Group by project (collapse worktrees)"}
          aria-pressed={projectMode}
          onClick={() => setProjectMode((v) => !v)}
          className="odk-sessions-icon"
        >
          <FolderGit2 size={15} aria-hidden />
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

      {(onSelectSpace || onOpenSpaceModal) && (
        <div
          className="odk-sessions-spaces"
          role="tablist"
          aria-label="Spaces"
          data-testid="sessions-spaces-bar"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeSpaceId === null}
            data-testid="sessions-space-all"
            className="odk-sessions-space-pill"
            onClick={() => onSelectSpace?.(null)}
          >
            <span>Default</span>
            {defaultSpaceWaiting > 0 && activeSpaceId !== null && (
              <span
                data-testid="sessions-space-all-waiting"
                className="odk-sessions-space-waiting"
                title={`${defaultSpaceWaiting} waiting in Default`}
              >
                {defaultSpaceWaiting}
              </span>
            )}
          </button>
          {spaces.map((space) => {
            const selected = activeSpaceId === space.id;
            const waiting = waitingBySpace.bySpace.get(space.id) ?? 0;
            return (
              <button
                key={space.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`sessions-space-${space.id}`}
                title={
                  space.default_cwd
                    ? `${space.name} (${space.default_cwd}) · Right-click to edit`
                    : `${space.name} · Right-click to edit`
                }
                className="odk-sessions-space-pill"
                onClick={() => onSelectSpace?.(space.id)}
                onDoubleClick={() => onOpenSpaceModal?.(space)}
                onContextMenu={(event) => {
                  if (!onOpenSpaceModal) return;
                  event.preventDefault();
                  onOpenSpaceModal(space);
                }}
              >
                <span
                  aria-hidden="true"
                  className="odk-sessions-space-dot"
                  style={{ background: space.color || DEFAULT_SPACE_COLOR }}
                />
                {space.icon && (
                  <span aria-hidden="true" className="odk-sessions-space-icon">
                    {space.icon}
                  </span>
                )}
                <span className="odk-sessions-space-name">{space.name}</span>
                {waiting > 0 && (
                  <span
                    data-testid={`sessions-space-waiting-${space.id}`}
                    className="odk-sessions-space-waiting"
                    title={`${waiting} waiting`}
                  >
                    {waiting}
                  </span>
                )}
              </button>
            );
          })}
          {activeSpace && onOpenSpaceModal && (
            <button
              type="button"
              data-testid="sessions-space-edit"
              aria-label={`Edit space ${activeSpace.name}`}
              title={`Edit ${activeSpace.name}`}
              onClick={() => onOpenSpaceModal(activeSpace)}
              className="odk-sessions-space-btn"
            >
              <Pencil size={11} aria-hidden />
            </button>
          )}
          {onOpenSpaceModal && (
            <button
              type="button"
              data-testid="sessions-space-add"
              aria-label="New space"
              title="New space"
              onClick={() => onOpenSpaceModal(null)}
              className="odk-sessions-space-btn"
            >
              <Plus size={12} aria-hidden />
            </button>
          )}
        </div>
      )}

      {panels?.onOpenChat && (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "4px 10px 6px",
          }}
        >
          <span
            style={{
              flex: 1,
              textAlign: "center",
              padding: "4px 6px",
              borderRadius: 6,
              fontSize: 11.5,
              fontWeight: 600,
              background: "rgb(var(--color-accent) / 0.14)",
              color: "rgb(var(--color-fg-0))",
            }}
          >
            Terminals
          </span>
          <button
            type="button"
            data-testid="sessions-sidebar-bots"
            onClick={panels.onOpenChat}
            style={{
              flex: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              padding: "4px 6px",
              borderRadius: 6,
              border: "1px solid rgb(var(--color-border))",
              background: "transparent",
              color: "rgb(var(--color-fg-2))",
              fontSize: 11.5,
              cursor: "pointer",
            }}
          >
            <Bot size={12} aria-hidden />
            <span>Bots &amp; Chat</span>
          </button>
        </div>
      )}

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

      {hasTerminals && (
        <div
          className="odk-sessions-filters"
          role="tablist"
          aria-label="Filter terminals"
          data-testid="sessions-filter-bar"
        >
          {(
            [
              { id: "all", label: "All", count: allMachineTerminals.length },
              { id: "waiting", label: "Waiting", count: waitingTotal },
              { id: "working", label: "Working", count: workingTotal },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              data-testid={`sessions-filter-${item.id}`}
              data-alert={item.id === "waiting" && item.count > 0 ? "true" : undefined}
              className="odk-sessions-filter-pill"
              onClick={() => setFilter(item.id)}
            >
              <span>{item.label}</span>
              {item.count > 0 && item.id !== "all" && (
                <span className="odk-sessions-filter-count">{item.count}</span>
              )}
            </button>
          ))}
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
