// Desktop tab bar — the single permanent chrome row of the workspace, drawn
// like tmux's window list (wireframes Main / B-Desktop). Left: ≡ shows or
// hides the pinned sessions sidebar (or, when the window is too narrow for
// it, opens the list as a drawer), then one `0:name` tab per workspace group (persistent groups
// + cwd fallback groups, same grouping TerminalWorkspace computes) with its
// programs muted after it, then [+]. Right, as plain text: the machine
// switcher (`mac-mini ▾`), cpu/mem/disk, `files`, `browser[n]`, `phone`,
// `settings`. Who has the keyboard and the round trip moved to the status
// line (WorkspaceStatusLine).
//
// The strip takes the free width and fades out under a divider when tabs
// overflow, so `+ new tab` after it never moves. On the right the machine
// switcher carries a three-bar load glyph (cpu, mem, disk), and files,
// browser, phone and settings are unboxed icons named by their tooltips.
//
// The active tab is marked only by a 2px accent rule. Tabs can be reordered
// by dragging anywhere on the tab (the window number is the handle tests
// grab) — same mouse-drag protocol the old workspace toolbar strip used, no
// new DnD library. Dropping a cwd fallback tab promotes it to a
// persistent group at drop time; see TerminalWorkspace handleReorderGroups.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { Folder, Globe, Settings as SettingsIcon, Smartphone } from "lucide-react";
import type {
  MachineInfo,
  ResourceStats,
  TerminalInfo,
} from "@offdesk/shared";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { colors } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription } from "@/lib/terminalOpener";
import { diskPercent, diskTooltip } from "@/lib/resourceStats";
import { collectPaneTerminalIds, type WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { HostSwitcher } from "./HostSwitcher.web";
import { useLongPress } from "@/lib/longPress";
import { WorkspaceManager } from "./WorkspaceManager.web";
import { TextButton } from "./Primitives.web";
import { rem } from "@/lib/rem";

export type TabDropPlacement = "before" | "after";

// Distance (px) a press on the tab body must travel before it becomes a drag.
const TAB_DRAG_THRESHOLD_PX = 4;

interface TabBarProps {
  groups: WorkspaceGroup[];
  activeGroupId: string | null;
  activeTerminalId: string | null;
  terminalsById: Map<string, TerminalInfo>;
  // All terminals across machines (HostSwitcher shows per-machine counts).
  terminals: TerminalInfo[];
  machines: MachineInfo[];
  activeMachineId: string | null;
  controlLeases: Record<string, string>;
  deviceId: string | null;
  machineStats: Record<string, ResourceStats>;
  stats: ResourceStats | undefined;
  isController: boolean;
  isTouch?: boolean;
  onSelectGroup: (groupId: string) => void;
  onSelectTerminal: (terminalId: string) => void;
  onNewGroup: () => void;
  onNewTerminal: (group: WorkspaceGroup) => void;
  onCloseTerminal: (terminal: TerminalInfo) => void;
  onMoveTerminal: (terminal: TerminalInfo, targetGroup: WorkspaceGroup) => void;
  onRenameGroup: (group: WorkspaceGroup) => void;
  onDeleteGroup: (group: WorkspaceGroup) => void;
  onReorderGroups: (
    sourceGroupId: string,
    targetGroupId: string,
    placement: TabDropPlacement,
  ) => void;
  onSelectMachine: (id: string) => void;
  onAddMachine: () => void;
  onOpenPhone?: () => void;
  onOpenSettings: () => void;
  /** The active machine's agent browser tabs; the button shows when set. */
  browserButton?: { count: number; needsPerson: boolean; open: boolean };
  onToggleBrowser?: () => void;
  /** The file browser button; shows when set. */
  filesButton?: { open: boolean };
  onToggleFiles?: () => void;
  onRemoveHost: (machineId: string) => void;
  /** Set when the window fits the pinned sessions sidebar: ≡ then shows or
   *  hides it instead of opening the list as a drawer. */
  sessionsSidebar?: { shown: boolean; onToggle: () => void };
}

function TabBarComponent({
  groups,
  activeGroupId,
  activeTerminalId,
  terminalsById,
  terminals,
  machines,
  activeMachineId,
  controlLeases,
  deviceId,
  machineStats,
  stats,
  isController,
  isTouch = false,
  onSelectGroup,
  onSelectTerminal,
  onNewGroup,
  onNewTerminal,
  onCloseTerminal,
  onMoveTerminal,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
  onSelectMachine,
  onAddMachine,
  onOpenPhone,
  onOpenSettings,
  browserButton,
  onToggleBrowser,
  filesButton,
  onToggleFiles,
  onRemoveHost,
  sessionsSidebar,
}: TabBarProps) {
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  // Widening the window pins the list: the drawer gives way to the sidebar.
  useEffect(() => {
    if (sessionsSidebar) setWorkspaceManagerOpen(false);
  }, [sessionsSidebar]);
  // The strip fades at its end only while tabs are hidden past it.
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripOverflows, setStripOverflows] = useState(false);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const update = () =>
      setStripOverflows(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    for (const child of Array.from(strip.children)) observer.observe(child);
    return () => {
      strip.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [groups]);
  // ---- tab drag-to-reorder ----
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const groupDragRef = useRef<{ sourceGroupId: string } | null>(null);
  const documentGroupDragCleanupRef = useRef<(() => void) | null>(null);
  const groupDragPendingRef = useRef<{
    sourceGroupId: string;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressGroupClickRef = useRef(false);

  const removeDocumentGroupDragEnd = useCallback(() => {
    const cleanup = documentGroupDragCleanupRef.current;
    if (!cleanup) return;
    cleanup();
    documentGroupDragCleanupRef.current = null;
  }, []);

  const resetGroupDrag = useCallback(() => {
    removeDocumentGroupDragEnd();
    groupDragRef.current = null;
    setDraggingGroupId(null);
  }, [removeDocumentGroupDragEnd]);

  const finishGroupDrag = useCallback(
    (clientX: number, clientY: number) => {
      const drag = groupDragRef.current;
      resetGroupDrag();
      if (!drag) return;
      // Swallow the click that fires after this mouseup so ending a drag
      // never (re-)selects a group. The timeout clears the flag when the
      // click lands outside any tab button.
      suppressGroupClickRef.current = true;
      setTimeout(() => {
        suppressGroupClickRef.current = false;
      }, 0);
      const target = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-workspace-group-drop-id]");
      const targetGroupId = target?.dataset.workspaceGroupDropId;
      if (!targetGroupId || targetGroupId === drag.sourceGroupId) return;
      const rect = target.getBoundingClientRect();
      const placement: TabDropPlacement =
        clientX < rect.left + rect.width / 2 ? "before" : "after";
      onReorderGroups(drag.sourceGroupId, targetGroupId, placement);
    },
    [onReorderGroups, resetGroupDrag],
  );

  // Shared drag start: grip handle (immediate) and tab-body threshold
  // promotion both end up here.
  const beginGroupDrag = useCallback(
    (sourceGroupId: string) => {
      removeDocumentGroupDragEnd();
      groupDragRef.current = { sourceGroupId };
      setDraggingGroupId(sourceGroupId);
      const handleMouseUp = (mouseEvent: MouseEvent) => {
        removeDocumentGroupDragEnd();
        finishGroupDrag(mouseEvent.clientX, mouseEvent.clientY);
      };
      const handleWindowBlur = () => resetGroupDrag();
      documentGroupDragCleanupRef.current = () => {
        document.removeEventListener("mouseup", handleMouseUp, true);
        window.removeEventListener("blur", handleWindowBlur);
      };
      document.addEventListener("mouseup", handleMouseUp, true);
      // Non-capture on purpose: element blur events reach a capture-phase
      // window listener, so the terminal textarea losing focus (e.g. the
      // mousedown default action focusing the tab button) would cancel the
      // drag. blur does not bubble, so without capture only a genuine
      // window blur lands here.
      window.addEventListener("blur", handleWindowBlur);
    },
    [finishGroupDrag, removeDocumentGroupDragEnd, resetGroupDrag],
  );

  // Pressing anywhere on a tab arms a drag: moving past a small
  // threshold promotes it to the same drag the grip handle starts, while
  // releasing earlier behaves like a plain click. No preventDefault here so
  // focus/click semantics of the label button stay intact.
  const armGroupTabDrag = useCallback(
    (sourceGroupId: string, event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if (groupDragRef.current) return;
      removeDocumentGroupDragEnd();
      groupDragPendingRef.current = {
        sourceGroupId,
        startX: event.clientX,
        startY: event.clientY,
      };
      const cancelPending = () => {
        groupDragPendingRef.current = null;
        removeDocumentGroupDragEnd();
      };
      const handleMouseMove = (mouseEvent: MouseEvent) => {
        const pending = groupDragPendingRef.current;
        if (!pending) return;
        const dx = mouseEvent.clientX - pending.startX;
        const dy = mouseEvent.clientY - pending.startY;
        if (Math.hypot(dx, dy) < TAB_DRAG_THRESHOLD_PX) return;
        cancelPending();
        beginGroupDrag(pending.sourceGroupId);
      };
      const handleMouseUp = () => cancelPending();
      const handleWindowBlur = () => cancelPending();
      documentGroupDragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove, true);
        document.removeEventListener("mouseup", handleMouseUp, true);
        window.removeEventListener("blur", handleWindowBlur);
      };
      document.addEventListener("mousemove", handleMouseMove, true);
      document.addEventListener("mouseup", handleMouseUp, true);
      // Non-capture, same reason as beginGroupDrag's blur listener.
      window.addEventListener("blur", handleWindowBlur);
    },
    [beginGroupDrag, removeDocumentGroupDragEnd],
  );

  useEffect(
    () => () => {
      removeDocumentGroupDragEnd();
    },
    [removeDocumentGroupDragEnd],
  );

  const [tabMenu, setTabMenu] = useState<{
    group: WorkspaceGroup;
    x: number;
    y: number;
  } | null>(null);

  // Menu content must be referentially stable while open: the bar re-renders
  // every second with fresh stats, and an unstable subtree makes the menu
  // jitter (Playwright "element is not stable" flakes on slow runners).
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const tabMenuItems = useMemo<ContextMenuEntry[]>(
    () =>
      tabMenu
        ? [
            {
              label: "new tab",
              disabled: !isController,
              onClick: onNewGroup,
            },
            {
              label: "rename tab",
              // Same gate as delete: cwd fallback groups have no persisted
              // row to rename, and only the controller may mutate tabs.
              disabled: !tabMenu.group.persistent || !isController,
              onClick: () => onRenameGroup(tabMenu.group),
            },
            { type: "separator" },
            {
              label: `close tab "${tabMenu.group.label}"…`,
              // cwd fallback groups only exist while their panes do — there
              // is nothing to delete; persistent groups are user-owned rows.
              disabled: !tabMenu.group.persistent || !isController,
              onClick: () => onDeleteGroup(tabMenu.group),
            },
          ]
        : [],
    [tabMenu, isController, onNewGroup, onRenameGroup, onDeleteGroup],
  );

  const pendingLongPressGroupRef = useRef<WorkspaceGroup | null>(null);
  const tabLongPress = useLongPress((point) => {
    const group = pendingLongPressGroupRef.current;
    if (!group) return;
    setTabMenu({ group, x: point.x, y: point.y });
  }, isTouch);

  return (
    <div
      data-testid="tab-bar"
      style={{
        // 44px hit targets on touch; the mouse bar is the wireframes' 40px.
        height: isTouch ? 44 : 40,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        gap: 4,
        padding: "0 10px 0 6px",
        background: colors.bg0,
        borderBottom: `1px solid ${colors.lineSoft}`,
        minWidth: 0,
        userSelect: "none",
      }}
    >
      {/* Left: ≡ tabs, the tmux tabs, [+] */}
      <TextButton
        testId="desktop-workspace-manager-button"
        label="Sessions"
        pressed={sessionsSidebar ? sessionsSidebar.shown : workspaceManagerOpen}
        onClick={() =>
          sessionsSidebar ? sessionsSidebar.onToggle() : setWorkspaceManagerOpen(true)
        }
        style={{ alignSelf: "center", fontSize: rem(13) }}
      >
        ≡
      </TextButton>
      <div
        ref={stripRef}
        data-testid="group-tab-strip"
        data-overflows={stripOverflows ? "true" : undefined}
        className="scrollbar-hidden"
        // A vertical wheel scrolls the strip sideways; it has no scrollbar.
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
        style={{
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          overflowY: "hidden",
          minWidth: 0,
          flex: "1 1 auto",
          ...(stripOverflows ? STRIP_FADE : null),
          // Reach over the bar's bottom border, so the active tab's accent
          // rule sits on it, the way tmux marks the current window.
          marginBottom: -1,
        }}
      >
        {groups.map((group, index) => {
          const active = group.id === activeGroupId;
          const annotation = groupAnnotation(group, terminalsById);
          const opener = groupOpenerDescription(group, terminalsById);
          const waiting = groupWaiting(group, terminalsById);
          return (
            <div
              key={group.id}
              data-workspace-group-drop-id={group.id}
              onMouseEnter={() => {
                if (isTouch) return;
                if (
                  group.id !== activeGroupId &&
                  groupDragRef.current === null
                ) {
                  onSelectGroup(group.id);
                }
              }}
              onMouseDown={(event) => armGroupTabDrag(group.id, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ group, x: event.clientX, y: event.clientY });
              }}
              onPointerDown={(event) => {
                pendingLongPressGroupRef.current = group;
                if (isTouch) {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }
                tabLongPress.onPointerDown(event);
              }}
              onPointerMove={tabLongPress.onPointerMove}
              onPointerUp={tabLongPress.onPointerUp}
              onPointerCancel={tabLongPress.onPointerCancel}
              data-testid={`workspace-tab-${group.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "0 0 0 14px",
                // tmux-style: the active tab is only the 2px accent rule.
                borderBottom: `2px solid ${active ? colors.accent : "transparent"}`,
                borderTop: "2px solid transparent",
                boxSizing: "border-box",
                color: active ? colors.fg0 : colors.fg3,
                flexShrink: 0,
                maxWidth: 280,
                opacity: draggingGroupId === group.id ? 0.5 : 1,
                cursor: draggingGroupId ? "grabbing" : undefined,
              }}
            >
              {/* The window number doubles as the drag handle; the whole
                  tab body drags too, past a small threshold. */}
              <span
                data-testid={group.persistent ? `workspace-group-drag-${group.id}` : undefined}
                title={group.persistent ? "Drag to reorder" : undefined}
                aria-hidden="true"
                onClick={() => {
                  if (suppressGroupClickRef.current) {
                    suppressGroupClickRef.current = false;
                    return;
                  }
                  onSelectGroup(group.id);
                }}
                style={{ fontSize: rem(12.5), cursor: group.persistent ? "grab" : "pointer", touchAction: "none" }}
              >
                {index}:
              </span>
              <button
                type="button"
                onClick={() => {
                  // Click trailing a completed drag — already handled as a
                  // drop, not a selection.
                  if (suppressGroupClickRef.current) {
                    suppressGroupClickRef.current = false;
                    return;
                  }
                  onSelectGroup(group.id);
                }}
                data-testid={`workspace-group-${group.id}`}
                aria-current={active ? "page" : undefined}
                title={group.label}
                style={tabButtonStyle}
              >
                <span style={truncateStyle}>{group.label}</span>
                {annotation && (
                  <span style={{ color: colors.fg3, ...truncateStyle }}>{annotation}</span>
                )}
                {opener && (
                  <span
                    data-testid={`workspace-group-opener-${group.id}`}
                    role="img"
                    aria-label={opener}
                    title={opener}
                    style={{ color: colors.accent, flexShrink: 0 }}
                  >
                    ⌁
                  </span>
                )}
                {waiting && (
                  <span
                    data-testid={`workspace-tab-attention-${group.id}`}
                    role="img"
                    aria-label="Waiting for you"
                    title="A terminal here is waiting for you"
                    style={{ color: colors.err, flexShrink: 0 }}
                  >
                    !
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
      <span aria-hidden="true" style={dividerStyle} />
      <button
        type="button"
        data-testid="tab-bar-new-group"
        onClick={onNewGroup}
        disabled={!isController}
        title={isController ? "New tab" : "Take control to create a terminal"}
        className="odk-btn odk-btn--secondary"
        style={newTabStyle}
      >
        <span aria-hidden="true" style={{ fontSize: rem(14), lineHeight: 1 }}>+</span>
        new tab
      </button>
      <div style={{ width: 20, flexShrink: 0 }} />

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          onClose={closeTabMenu}
        />
      )}

      <WorkspaceManager
        open={workspaceManagerOpen}
        placement="drawer"
        machineName={
          machines.find((machine) => machine.id === activeMachineId)?.name ?? ""
        }
        groups={groups}
        terminalsById={terminalsById}
        activeGroupId={activeGroupId}
        activeTerminalId={activeTerminalId}
        canManage={isController}
        onClose={() => setWorkspaceManagerOpen(false)}
        onSelectGroup={onSelectGroup}
        onSelectTerminal={onSelectTerminal}
        onNewGroup={onNewGroup}
        onNewTerminal={onNewTerminal}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onReorderGroups={onReorderGroups}
        onMoveTerminal={onMoveTerminal}
        onCloseTerminal={onCloseTerminal}
      />

      {/* Right: machine and its load, then the places you can open. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          flexShrink: 0,
        }}
      >
        <HostSwitcher
          compact
          machines={machines}
          activeMachineId={activeMachineId}
          controlLeases={controlLeases}
          deviceId={deviceId}
          machineStats={machineStats}
          terminals={terminals}
          onSelectMachine={onSelectMachine}
          onAddMachine={onAddMachine}
          onRemoveHost={onRemoveHost}
          trailing={<LoadGlyph stats={stats} />}
          trailingLabel={loadLabel(stats)}
        />
        <span style={{ width: 6, flexShrink: 0 }} />
        {filesButton && onToggleFiles && (
          <TextButton
            testId="tab-bar-files"
            label="Files"
            pressed={filesButton.open}
            open={filesButton.open}
            onClick={onToggleFiles}
            style={panelButtonStyle(filesButton.open)}
          >
            <Folder size={15} aria-hidden />
          </TextButton>
        )}
        {browserButton && onToggleBrowser && (
          <TextButton
              testId="tab-bar-browser"
              label="Browser"
              title={browserButton.needsPerson ? "The agent needs you" : "Browser"}
              pressed={browserButton.open}
              open={browserButton.open}
              onClick={onToggleBrowser}
              style={panelButtonStyle(browserButton.open)}
              alert={
                browserButton.needsPerson
                  ? { label: "The agent needs you", testId: "tab-bar-browser-attention" }
                  : undefined
              }
            >
              <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 1 }}>
                <Globe size={15} aria-hidden />
                {browserButton.count > 0 && (
                  <span data-testid="tab-bar-browser-count" style={browserCountStyle}>
                    {browserButton.count > 99 ? "99+" : browserButton.count}
                  </span>
                )}
              </span>
            </TextButton>
        )}
        {onOpenPhone && (
          <TextButton
            testId="tab-bar-phone"
            label="Open this hub on your phone"
            onClick={onOpenPhone}
            style={panelButtonStyle(false)}
          >
            <Smartphone size={15} aria-hidden />
          </TextButton>
        )}
        <TextButton testId="tab-bar-settings" label="Settings" onClick={onOpenSettings} style={panelButtonStyle(false)}>
          <SettingsIcon size={15} aria-hidden />
        </TextButton>
      </div>
    </div>
  );
}

export const TabBar = memo(TabBarComponent);

/* ---------- tab attention ---------- */

// A pane in this tab is stopped at a confirmation prompt.
function groupWaiting(
  group: WorkspaceGroup,
  terminalsById: Map<string, TerminalInfo>,
): boolean {
  return collectPaneTerminalIds(group.root).some((id) => {
    const terminal = terminalsById.get(id);
    return Boolean(terminal?.reachable && terminal.attention === "confirmation");
  });
}

/* ---------- tab annotation ---------- */

// Distinct pane titles joined with · (deduped, max 2 shown then +N).
// Hidden when the group has a single pane whose title equals the label.
function groupAnnotation(
  group: WorkspaceGroup,
  terminalsById: Map<string, TerminalInfo>,
): string | null {
  const paneIds = collectPaneTerminalIds(group.root);
  const titles: string[] = [];
  for (const id of paneIds) {
    const terminal = terminalsById.get(id);
    if (!terminal) continue;
    const title = displayTerminalTitle(terminal);
    if (!titles.includes(title)) titles.push(title);
  }
  if (titles.length === 0) return null;
  if (paneIds.length === 1 && titles.length === 1 && titles[0] === group.label) {
    return null;
  }
  const shown = titles.slice(0, 2).join(" · ");
  return titles.length > 2 ? `${shown} +${titles.length - 2}` : shown;
}

// Spelled-out opener of the first pane an agent opened (through the CLI),
// so a tab it opened says so; null when people opened every pane.
function groupOpenerDescription(
  group: WorkspaceGroup,
  terminalsById: Map<string, TerminalInfo>,
): string | null {
  for (const id of collectPaneTerminalIds(group.root)) {
    const terminal = terminalsById.get(id);
    const description = terminal && terminalOpenerDescription(terminal);
    if (description) return description;
  }
  return null;
}

/* ---------- cpu/mem/disk as text ---------- */

// Over this share a resource reads as busy: its bar goes full strength.
// Not red: the warn colour stays for a terminal waiting on you.
const BUSY_PERCENT = 85;

function loadPercents(stats: ResourceStats | undefined) {
  return [
    { label: "cpu", name: "cpu", percent: stats ? Math.round(stats.cpu_percent) : null },
    {
      label: "mem",
      name: "memory",
      percent: stats && stats.memory_total > 0
        ? Math.round((stats.memory_used / stats.memory_total) * 100)
        : null,
    },
    { label: "disk", name: "disk", percent: diskPercent(stats) },
  ];
}

function loadLabel(stats: ResourceStats | undefined): string {
  return loadPercents(stats)
    .map(({ name, percent }) => `${name} ${percent === null ? "unknown" : `${percent}%`}`)
    .join(", ");
}

/** cpu, mem and disk as three 3px bars, 12px tall: the machine's load at a
 *  glance. Exact values are in the switcher's title and its menu. */
function LoadGlyph({ stats }: { stats: ResourceStats | undefined }) {
  return (
    <span
      data-testid="tab-bar-meters"
      aria-hidden="true"
      title={diskTooltip(stats)}
      style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12, flexShrink: 0 }}
    >
      {loadPercents(stats).map(({ label, percent }) => (
        <span
          key={label}
          data-testid={`tab-bar-meter-${label}`}
          data-percent={percent ?? undefined}
          style={{
            width: 3,
            height: `${Math.max(percent ?? 0, 8)}%`,
            background: percent !== null && percent > BUSY_PERCENT ? colors.fg0 : colors.fg3,
            opacity: percent === null ? 0.4 : 1,
          }}
        />
      ))}
    </span>
  );
}

/* ---------- styles ---------- */

const STRIP_FADE: CSSProperties = {
  WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 40px), transparent)",
  maskImage: "linear-gradient(to right, #000 calc(100% - 40px), transparent)",
};

const dividerStyle: CSSProperties = {
  width: 1,
  margin: "10px 2px",
  background: colors.lineSoft,
  flexShrink: 0,
};

// The secondary button, at chrome height: a box, unlike the text around it.
const newTabStyle: CSSProperties = {
  alignSelf: "center",
  flexShrink: 0,
  height: 26,
  minHeight: 26,
  gap: 6,
  padding: "0 9px",
  fontSize: rem(12),
};

// Unboxed icons; an open panel gets the hover fill, so it reads as pressed.
function panelButtonStyle(open: boolean): CSSProperties {
  return {
    alignSelf: "center",
    minWidth: 30,
    padding: "0 7px",
    ...(open ? { background: colors.bg3, color: colors.fg0 } : null),
  };
}

const browserCountStyle: CSSProperties = {
  fontSize: rem(9.5),
  lineHeight: 1,
  marginTop: -2,
  color: colors.fg1,
};

const tabButtonStyle: CSSProperties = {
  minWidth: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "none",
  background: "transparent",
  color: "inherit",
  padding: "0 14px 0 0",
  height: "100%",
  font: "inherit",
  fontFamily: "var(--font-display)",
  fontSize: rem(12.5),
  cursor: "pointer",
};

const truncateStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
