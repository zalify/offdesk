// Desktop tab bar — the single permanent chrome row of the D1 shell.
// Left: one tab per workspace group (persistent groups + cwd fallback
// groups, same grouping TerminalWorkspace computes) plus a ＋ button for a
// new terminal. Right: host meta — online dot + machine name (HostSwitcher
// dropdown), real cpu/mem micro-meters, and a "viewing" pill that only
// appears while the user is not the controller.
//
// The active tab is filled with the terminal background so it visually
// merges into the terminal below, like a terminal-emulator tab. Tabs can be
// reordered by dragging anywhere on the tab (persistent tabs also have a
// grip handle) — same mouse-drag protocol the old workspace toolbar strip
// used, no new DnD library. Dropping a cwd fallback tab promotes it to a
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
import type {
  MachineInfo,
  ResourceStats,
  TerminalInfo,
} from "@offdesk/shared";
import { FolderTree, Lock, Plus, Settings, Smartphone } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { colors, colorAlpha, terminalTheme } from "@/lib/colors";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { diskPercent, diskTooltip } from "@/lib/resourceStats";
import { collectPaneTerminalIds, type WorkspaceGroup } from "@/lib/terminalWorkspaceLayout";
import { HostSwitcher } from "./HostSwitcher.web";
import { useLongPress } from "@/lib/longPress";
import { WorkspaceManager } from "./WorkspaceManager.web";

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
  rttMs: number | null;
  isController: boolean;
  isTouch?: boolean;
  viewOnlyLocked: boolean;
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
  onRemoveHost: (machineId: string) => void;
  onRequestControl: () => void;
  onEngageViewOnly: () => void;
  onDisengageViewOnly: () => void;
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
  rttMs,
  isController,
  isTouch = false,
  viewOnlyLocked,
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
  onRemoveHost,
  onRequestControl,
  onEngageViewOnly,
  onDisengageViewOnly,
}: TabBarProps) {
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
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

  const startGroupMouseDrag = useCallback(
    (sourceGroupId: string, event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginGroupDrag(sourceGroupId);
    },
    [beginGroupDrag],
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

  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
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
              label: "New tab",
              disabled: !isController,
              onClick: onNewGroup,
            },
            {
              label: "Rename tab",
              // Same gate as delete: cwd fallback groups have no persisted
              // row to rename, and only the controller may mutate tabs.
              disabled: !tabMenu.group.persistent || !isController,
              onClick: () => onRenameGroup(tabMenu.group),
            },
            { type: "separator" },
            {
              label: `Close tab "${tabMenu.group.label}"…`,
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
        // 40px minimum hit target on touch; desktop stays the compact 34px row.
        height: isTouch ? 40 : 34,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        background: colors.bg0,
        borderBottom: `1px solid ${colors.lineSoft}`,
        minWidth: 0,
        userSelect: "none",
      }}
    >
      {/* Left: group tabs + new-group button */}
      <button
        type="button"
        data-testid="desktop-workspace-manager-button"
        aria-label="Tabs"
        title="Tabs"
        onClick={() => setWorkspaceManagerOpen(true)}
        style={{
          alignSelf: "center",
          width: isTouch ? 40 : 30,
          height: isTouch ? 40 : 30,
          marginLeft: 4,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: workspaceManagerOpen ? colors.bg2 : "transparent",
          color: colors.fg2,
          cursor: "pointer",
        }}
      >
        <FolderTree size={15} />
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 2,
          paddingLeft: 6,
          overflowX: "auto",
          minWidth: 0,
          flex: 1,
        }}
      >
        {groups.map((group) => {
          const active = group.id === activeGroupId;
          const annotation = groupAnnotation(group, terminalsById);
          return (
            <div
              key={group.id}
              data-workspace-group-drop-id={group.id}
              onMouseEnter={() => {
                setHoveredGroupId(group.id);
                if (isTouch) return;
                if (
                  group.id !== activeGroupId &&
                  groupDragRef.current === null
                ) {
                  onSelectGroup(group.id);
                }
              }}
              onMouseLeave={() =>
                setHoveredGroupId((current) =>
                  current === group.id ? null : current,
                )
              }
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
                gap: 0,
                padding: "0 2px",
                marginTop: 4,
                // The active tab reaches 1px past the bar's bottom border so
                // its terminal-background fill merges into the terminal below.
                marginBottom: active ? -1 : 0,
                position: "relative",
                borderRadius: "7px 7px 0 0",
                background: active
                  ? terminalTheme.background
                  : hoveredGroupId === group.id
                    ? colors.bg2
                    : "transparent",
                border: active
                  ? `1px solid ${colors.lineSoft}`
                  : "1px solid transparent",
                borderBottom: active ? "none" : "1px solid transparent",
                flexShrink: 0,
                maxWidth: 220,
                opacity: draggingGroupId === group.id ? 0.5 : 1,
              }}
            >
              {group.persistent && (
                <span
                  role="button"
                  tabIndex={-1}
                  data-testid={`workspace-group-drag-${group.id}`}
                  title="Drag group"
                  aria-label={`Drag group ${group.label}`}
                  onMouseDown={(event) => startGroupMouseDrag(group.id, event)}
                  style={dragHandleStyle}
                >
                  <span style={dragGripStyle} />
                </span>
              )}
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
                title={group.label}
                style={{
                  ...tabButtonStyle,
                  color: active ? terminalTheme.foreground : colors.fg2,
                }}
              >
                <span style={truncateStyle}>{group.label}</span>
                {annotation && (
                  <span
                    style={{
                      color: active ? terminalTheme.white : colors.fg3,
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      ...truncateStyle,
                    }}
                  >
                    {annotation}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
        <button
          type="button"
          data-testid="tab-bar-new-group"
          onClick={onNewGroup}
          disabled={!isController}
          title="New tab"
          aria-label="New tab"
          style={{
            alignSelf: "center",
            width: isTouch ? 40 : 26,
            height: isTouch ? 40 : 26,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            color: colors.fg2,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            flexShrink: 0,
            cursor: isController ? "pointer" : "not-allowed",
            opacity: isController ? 1 : 0.45,
          }}
        >
          <Plus size={14} />
        </button>

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

      {/* Right: host meta */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 10px",
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
        />
        <MicroMeters stats={stats} />
        <button
          type="button"
          data-testid="tab-bar-settings"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          style={{
            width: isTouch ? 40 : 30,
            height: isTouch ? 40 : 30,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            border: `1px solid ${colors.line}`,
            borderRadius: 6,
            background: "transparent",
            color: colors.fg2,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Settings size={15} />
        </button>
        {onOpenPhone && (
        <button
          type="button"
          data-testid="tab-bar-phone"
          onClick={onOpenPhone}
          title="Open this hub on your phone"
          aria-label="Open this hub on your phone"
          style={{
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "0 8px",
            borderRadius: 6,
            background: "transparent",
            border: `1px solid ${colors.line}`,
            color: colors.fg2,
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          <Smartphone size={13} />
          Phone
        </button>
        )}
        <span
          data-testid="tab-bar-rtt"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: colors.fg1,
            minWidth: 34,
            textAlign: "right",
          }}
        >
          {rttMs === null ? "—" : `${Math.round(rttMs)}ms`}
        </span>
        {viewOnlyLocked ? (
          <button
            type="button"
            data-testid="workbench-request-control"
            onClick={onDisengageViewOnly}
            title="Unlock input claims"
            style={controlPillStyle}
          >
            🔒 view only
          </button>
        ) : !isController ? (
          <button
            type="button"
            data-testid="workbench-request-control"
            onClick={onRequestControl}
            title="Take control"
            style={controlPillStyle}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: colors.fg2,
              }}
            />
            viewing
          </button>
        ) : (
          <button
            type="button"
            data-testid="workbench-view-only-lock"
            onClick={onEngageViewOnly}
            title="Lock to view only"
            aria-label="Lock to view only"
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              borderRadius: 6,
              background: "transparent",
              border: `1px solid ${colors.line}`,
              color: colors.fg2,
              cursor: "pointer",
            }}
          >
            <Lock size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

export const TabBar = memo(TabBarComponent);

const controlPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 9px",
  borderRadius: 999,
  background: colorAlpha.mutedLight,
  border: `1px solid ${colors.line}`,
  color: colors.fg2,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

/* ---------- tab annotation ---------- */

// Distinct pane titles joined with ▏ (deduped, max 2 shown then +N).
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
  const shown = titles.slice(0, 2).join(" ▏");
  return titles.length > 2 ? `${shown} +${titles.length - 2}` : shown;
}

/* ---------- cpu/mem/disk micro-meters ---------- */

function MicroMeters({ stats }: { stats: ResourceStats | undefined }) {
  const cpu = stats ? Math.round(stats.cpu_percent) : null;
  const mem =
    stats && stats.memory_total > 0
      ? Math.round((stats.memory_used / stats.memory_total) * 100)
      : null;
  const disk = diskPercent(stats);
  return (
    <div
      data-testid="tab-bar-meters"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: colors.fg3,
      }}
    >
      <Meter label="cpu" percent={cpu} />
      <Meter label="mem" percent={mem} />
      <Meter label="disk" percent={disk} title={diskTooltip(stats)} />
    </div>
  );
}

function Meter({
  label,
  percent,
  title,
}: {
  label: string;
  percent: number | null;
  title?: string;
}) {
  return (
    <span
      data-testid={`tab-bar-meter-${label}`}
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      <span>{label}</span>
      <span
        style={{
          width: 30,
          height: 4,
          borderRadius: 2,
          background: colors.bg2,
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${percent ?? 0}%`,
            background: percent === null ? "transparent" : colors.fg2,
            borderRadius: 2,
          }}
        />
      </span>
      <span style={{ color: colors.fg1, minWidth: 32, textAlign: "right" }}>
        {percent === null ? "—" : `${percent}%`}
      </span>
    </span>
  );
}

/* ---------- styles ---------- */

const tabButtonStyle: CSSProperties = {
  minWidth: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  border: "none",
  background: "transparent",
  padding: "0 8px",
  height: "100%",
  fontSize: 12,
  cursor: "pointer",
};

const dragHandleStyle: CSSProperties = {
  width: 10,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "grab",
  flexShrink: 0,
  touchAction: "none",
  userSelect: "none",
};

// Two vertical dotted columns, like a window-manager drag grip.
const dragGripStyle: CSSProperties = {
  width: 6,
  height: 10,
  backgroundImage: `radial-gradient(${colors.fg3} 1px, transparent 1px)`,
  backgroundSize: "3px 3px",
  opacity: 0.8,
};

const truncateStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
