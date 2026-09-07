import { WebPreviewDialog } from "./WebPreviewDialog";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  MutableRefObject,
} from "react";
import type {
  TerminalInfo,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
  WorkspaceLayoutNode,
} from "@offdesk/shared";
import { Plus } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { TerminalCard, type TerminalCardRef } from "./TerminalCard.web";
import { colors, colorAlpha, terminalTheme } from "@/lib/colors";
import {
  type WorkspaceGroup,
  type WorkspacePaneFocusDirection,
  type WorkspacePaneNode,
  type WorkspaceSplitIntent,
  type TerminalWorkspace as TerminalWorkspaceState,
  MAX_PANES_PER_TAB,
  appendWorkspacePaneToGroup,
  buildReorderPersistentGroupIds,
  closeWorkspacePane,
  createTerminalWorkspace,
  findAdjacentWorkspacePane,
  flattenWorkspacePanes,
  getActiveWorkspaceGroup,
  isWorkspaceGroupFull,
  mountedWorkspaceGroupIds,
  reconcileTerminalWorkspace,
  rotateWorkspaceLayout,
  selectWorkspaceGroup,
  splitWorkspacePane,
} from "@/lib/terminalWorkspaceLayout";
import { formatPrefixBinding, type PrefixActionId } from "@/lib/prefixKey";
import { usePrefixKey } from "@/lib/prefixKeyContext";
import { useLongPress } from "@/lib/longPress";
import { showWorkspaceToast } from "@/lib/workspaceToast";

interface TerminalWorkspaceProps {
  terminal: TerminalInfo;
  siblings: TerminalInfo[];
  workspaceGroups: WorkspaceGroupInfo[];
  workspaceLayouts: WorkspaceLayoutInfo[];
  isController: boolean;
  canType: boolean;
  eventsReconnecting: boolean;
  deviceId: string;
  isCompact: boolean;
  isTouch: boolean;
  onPick: (id: string) => void;
  onDestroy: (
    terminal: TerminalInfo,
    options?: WorkspaceDestroyOptions,
  ) => Promise<"accepted" | "pending">;
  onSplit: (
    terminal: TerminalInfo,
    direction: WorkspaceSplitIntent,
    workspaceGroupId: string | null,
  ) => Promise<TerminalInfo | null>;
  onCreatePane: (input: {
    machineId: string;
    cwd: string;
    workspaceGroupId: string | null;
  }) => Promise<TerminalInfo | null>;
  onReorderGroups: (
    machineId: string,
    groupIds: string[],
  ) => Promise<WorkspaceGroupInfo[] | null | void>;
  onSaveWorkspaceLayout: (
    machineId: string,
    groupKey: string,
    root: WorkspaceLayoutNode | null,
  ) => Promise<WorkspaceLayoutInfo | null | void>;
  onAssignGroup: (
    terminal: TerminalInfo,
    workspaceGroupId: string | null,
  ) => Promise<void>;
  // Promote a cwd fallback tab to a persistent group (create the
  // workspace_groups row and move the tab's terminals into it).
  onPromoteGroup: (
    machineId: string,
    name: string,
    terminalIds: string[],
  ) => Promise<WorkspaceGroupInfo | null>;
  onRequestControl?: (machineId: string) => void;
  onReleaseControl?: (machineId: string) => void;
  // Command channel for the desktop tab bar / command palette. The
  // workspace fills it with live handlers; the chrome calls them.
  commandsRef?: MutableRefObject<WorkspaceCommandChannel>;
  onActiveGroupChange?: (groupId: string | null) => void;
}

// Handlers the desktop chrome (TabBar, CommandPalette) invokes on the
// workspace. Optional fields stay unset until the workspace mounts.
export interface WorkspaceCommandChannel {
  openWebPreview?: () => void;
  selectGroup?: (groupId: string) => void;
  reorderGroups?: (
    sourceGroupId: string,
    targetGroupId: string,
    placement: GroupDropPlacement,
  ) => void;
  runPrefixAction?: (action: PrefixActionId) => void;
}

export type GroupDropPlacement = "before" | "after";

type PaneMenuEvent = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

// Stable no-op so TerminalCard's memo comparator doesn't see a fresh
// function identity on every parent render (panes never render tab strips).
const NOOP_SELECT_TAB = () => {};

// Prefix actions owned by this component (TerminalCanvas owns the rest).
const WORKSPACE_PREFIX_ACTIONS: PrefixActionId[] = [
  "splitRight",
  "splitDown",
  "rotateLayout",
  "paneLeft",
  "paneRight",
  "paneUp",
  "paneDown",
  "zoomPane",
  "closePane",
  "nextTab",
  "prevTab",
  "selectTab1",
  "selectTab2",
  "selectTab3",
  "selectTab4",
  "selectTab5",
  "selectTab6",
  "selectTab7",
  "selectTab8",
  "selectTab9",
];

export interface WorkspaceFitRequest {
  terminalIds: string[];
  focusTerminalId: string | null;
  nonce: number;
}

interface WorkspaceDestroyOptions {
  keepWorkspaceOpen?: boolean;
  afterAccepted?: () => void;
}

function TerminalWorkspaceComponent({
  terminal,
  siblings,
  workspaceGroups,
  workspaceLayouts,
  isController,
  canType,
  eventsReconnecting,
  deviceId,
  isCompact,
  isTouch,
  onPick,
  onDestroy,
  onSplit,
  onCreatePane,
  onReorderGroups,
  onSaveWorkspaceLayout,
  onAssignGroup,
  onPromoteGroup,
  onRequestControl,
  onReleaseControl,
  commandsRef,
  onActiveGroupChange,
}: TerminalWorkspaceProps) {
  const [workspace, setWorkspace] = useState(() =>
    createTerminalWorkspace(
      siblings,
      terminal.id,
      workspaceGroups,
      workspaceLayouts,
    ),
  );
  const workspaceRef = useRef(workspace);
  const commitWorkspace = useCallback((next: TerminalWorkspaceState) => {
    workspaceRef.current = next;
    setWorkspace(next);
    return next;
  }, []);
  const updateWorkspace = useCallback(
    (producer: (current: TerminalWorkspaceState) => TerminalWorkspaceState) =>
      commitWorkspace(producer(workspaceRef.current)),
    [commitWorkspace],
  );
  const activeCardRef = useRef<TerminalCardRef | null>(null);
  const pendingGroupSelectionRef = useRef<string | null>(null);
  const fitRequestCounterRef = useRef(0);
  const [fitRequest, setFitRequest] = useState<WorkspaceFitRequest | null>(
    null,
  );
  const [maximizedTerminalId, setMaximizedTerminalId] = useState<string | null>(
    null,
  );
  // Render-time mirror so callbacks can see the current zoom without
  // depending on the state value (which would churn their identities).
  const maximizedTerminalIdRef = useRef<string | null>(null);
  maximizedTerminalIdRef.current = maximizedTerminalId;
  const [webPreviewTerminal, setWebPreviewTerminal] = useState<TerminalInfo | null>(null);
  const [paneMenu, setPaneMenu] = useState<{
    terminalId: string;
    x: number;
    y: number;
  } | null>(null);
  const terminalsById = useMemo(() => {
    const map = new Map<string, TerminalInfo>();
    for (const sibling of siblings) map.set(sibling.id, sibling);
    return map;
  }, [siblings]);

  const previousTerminalIdRef = useRef(terminal.id);
  useEffect(() => {
    const externalTerminalChanged = previousTerminalIdRef.current !== terminal.id;
    previousTerminalIdRef.current = terminal.id;
    setWorkspace((prev) => {
      let next = reconcileTerminalWorkspace(
        prev,
        siblings,
        externalTerminalChanged ? terminal.id : prev.activeTerminalId,
        workspaceGroups,
        workspaceLayouts,
      );
      // Retry a pending selection: selectGroup may be issued from the
      // create-group HTTP response before the workspace_group_created
      // event lands here and reconciles the new group into local state.
      const pendingGroupId = pendingGroupSelectionRef.current;
      if (pendingGroupId) {
        const selected = selectWorkspaceGroup(next, pendingGroupId);
        if (selected !== next) {
          next = selected;
          pendingGroupSelectionRef.current = null;
        }
      }
      workspaceRef.current = next;
      return next;
    });
  }, [siblings, terminal.id, workspaceGroups, workspaceLayouts]);

  const activeGroup = getActiveWorkspaceGroup(workspace);
  // Keep-alive LRU (size 2): the group active on the previous render stays
  // mounted-but-hidden so flipping back is instant (no xterm/WS/tmux
  // rebuild). Refs update during render — same pattern as
  // maximizedTerminalIdRef — because the switched-away group must already
  // appear in THIS render's mounted list; an effect would run too late and
  // unmount it first.
  const renderedActiveGroupIdRef = useRef<string | null>(
    workspace.activeGroupId,
  );
  const previousActiveGroupIdRef = useRef<string | null>(null);
  if (workspace.activeGroupId !== renderedActiveGroupIdRef.current) {
    previousActiveGroupIdRef.current = renderedActiveGroupIdRef.current;
    renderedActiveGroupIdRef.current = workspace.activeGroupId;
  }
  const mountedGroups = mountedWorkspaceGroupIds(
    workspace,
    previousActiveGroupIdRef.current,
    isTouch,
  )
    .map((id) => workspace.groups.find((group) => group.id === id))
    .filter((group): group is WorkspaceGroup => Boolean(group));
  // A terminal mid-move (optimistic split/assign racing reconcile) can
  // transiently sit in BOTH the active and the kept-alive group's tree.
  // Rendering both would mount two xterm + WS instances for one terminal, so
  // hidden trees skip every pane the active tree claims; the next reconcile
  // cleans the state up.
  const activePaneIds = new Set(collectIds(activeGroup?.root ?? null));
  const activeTerminal = workspace.activeTerminalId
    ? terminalsById.get(workspace.activeTerminalId) ?? null
    : null;
  const commandMachineId = activeTerminal?.machine_id ?? terminal.machine_id;
  // Panes in the active group — a group with a single pane renders no
  // focused-pane accent border (a lone pane needs no focus indicator).
  const activeGroupPaneCount = activeGroup
    ? collectIds(activeGroup.root).length
    : 0;
  // Past MAX_PANES_PER_TAB the split grid is unusable, so a full tab refuses
  // further splits. Creating a terminal is not blocked the same way — that
  // path (TerminalCanvas) overflows into a new tab instead.
  const activeGroupFull = isWorkspaceGroupFull(activeGroup);
  const layoutSaveQueuesRef = useRef(new Map<string, Promise<void>>());

  const persistGroupLayout = useCallback(
    async (
      nextWorkspace: TerminalWorkspaceState,
      groupId: string | null,
      persistenceGroupId = groupId,
    ) => {
      if (!groupId || !persistenceGroupId) return;
      const group = nextWorkspace.groups.find(
        (candidate) => candidate.id === groupId,
      );
      if (!group) return;
      const queueKey = `${commandMachineId}\u0000${persistenceGroupId}`;
      const previous =
        layoutSaveQueuesRef.current.get(queueKey) ?? Promise.resolve();
      const save = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            await onSaveWorkspaceLayout(
              commandMachineId,
              persistenceGroupId,
              group.root,
            );
          } catch (error) {
            console.error("Failed to save workspace pane layout", error);
          }
        });
      layoutSaveQueuesRef.current.set(queueKey, save);
      void save.finally(() => {
        if (layoutSaveQueuesRef.current.get(queueKey) === save) {
          layoutSaveQueuesRef.current.delete(queueKey);
        }
      });
      await save;
    },
    [commandMachineId, onSaveWorkspaceLayout],
  );

  const requestPaneFit = useCallback(
    (
      terminalIds: string | string[] | null,
      options: { focusTerminalId?: string | null } = {},
    ) => {
      const ids = Array.isArray(terminalIds)
        ? terminalIds
        : terminalIds
          ? [terminalIds]
          : [];
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return;
      fitRequestCounterRef.current += 1;
      setFitRequest({
        terminalIds: uniqueIds,
        focusTerminalId: options.focusTerminalId ?? uniqueIds[0] ?? null,
        nonce: fitRequestCounterRef.current,
      });
    },
    [],
  );
  const handleFitRequestHandled = useCallback(
    (nonce: number, terminalId: string) => {
      setFitRequest((current) => {
        if (current?.nonce !== nonce) return current;
        const terminalIds = current.terminalIds.filter(
          (id) => id !== terminalId,
        );
        return terminalIds.length === 0
          ? null
          : {
              ...current,
              terminalIds,
            };
      });
    },
    [],
  );

  const activateTerminal = useCallback(
    (terminalId: string) => {
      const changedTerminal = terminalId !== workspaceRef.current.activeTerminalId;
      if (changedTerminal) setMaximizedTerminalId(null);
      updateWorkspace((prev) => {
        const group =
          prev.groups.find((candidate) =>
            containsTerminal(candidate.root, terminalId),
          ) ?? null;
        return {
          ...prev,
          activeGroupId: group?.id ?? prev.activeGroupId,
          activeTerminalId: terminalId,
        };
      });
      onPick(terminalId);
      if (!isCompact && isController && changedTerminal) {
        // Switching focus dropped any zoom overlay above; the previously
        // zoomed pane shrank back to its rect and needs a refit too (panes
        // no longer remount on zoom changes).
        const previouslyZoomed = maximizedTerminalIdRef.current;
        requestPaneFit(
          previouslyZoomed && previouslyZoomed !== terminalId
            ? [terminalId, previouslyZoomed]
            : terminalId,
          { focusTerminalId: terminalId },
        );
      }
    },
    [
      isController,
      isCompact,
      onPick,
      requestPaneFit,
      updateWorkspace,
    ],
  );

  const activateGroup = useCallback(
    (groupId: string) => {
      setMaximizedTerminalId(null);
      const next = updateWorkspace((current) =>
        selectWorkspaceGroup(current, groupId),
      );
      // If the group is not in local state yet (e.g. selectGroup issued from
      // the create-group HTTP response before the workspace_group_created
      // event arrives), remember it and retry from the reconcile effect.
      if (next.activeGroupId !== groupId) {
        pendingGroupSelectionRef.current = groupId;
        return;
      }
      pendingGroupSelectionRef.current = null;
      if (next.activeTerminalId) onPick(next.activeTerminalId);
      if (!isCompact && isController) {
        requestPaneFit(collectIds(getActiveWorkspaceGroup(next)?.root ?? null), {
          focusTerminalId: next.activeTerminalId,
        });
      }
    },
    [isController, isCompact, onPick, requestPaneFit, updateWorkspace],
  );

  const handleSplit = useCallback(
    async (direction: WorkspaceSplitIntent) => {
      if (!isController) return;
      if (isWorkspaceGroupFull(activeGroup)) {
        // Reached from the shortcut too, where the menu's disabled state
        // isn't visible — say why nothing happened.
        showWorkspaceToast(
          `This tab is full (${MAX_PANES_PER_TAB} panes max). Open a new tab for more.`,
        );
        return;
      }
      if (!activeTerminal) {
        if (!activeGroup) return;
        const created = await onCreatePane({
          machineId: commandMachineId,
          cwd: activeGroup.cwd || terminal.cwd,
          workspaceGroupId: activeGroup.workspaceGroupId,
        });
        if (!created) return;
        setMaximizedTerminalId(null);
        const groupId = activeGroup.id;
        const nextWorkspace = updateWorkspace((current) =>
          appendWorkspacePaneToGroup(current, {
            groupId,
            newTerminalId: created.id,
          }),
        );
        onPick(created.id);
        requestPaneFit(collectIds(getActiveWorkspaceGroup(nextWorkspace)?.root ?? null), {
          focusTerminalId: created.id,
        });
        await persistGroupLayout(nextWorkspace, groupId);
        return;
      }
      const sourceTerminal = activeTerminal;
      const sourceGroupId = activeGroup?.id ?? workspaceRef.current.activeGroupId;
      let targetWorkspaceGroupId =
        activeGroup?.workspaceGroupId ?? activeTerminal.workspace_group_id ?? null;
      let promotedWorkspaceGroupId: string | null = null;
      if (activeGroup && !activeGroup.persistent) {
        const terminalIds = collectIds(activeGroup.root);
        const promoted = await onPromoteGroup(
          sourceTerminal.machine_id,
          activeGroup.label,
          terminalIds,
        ).catch((error) => {
          console.error("Failed to promote workspace group for split", error);
          return null;
        });
        if (!promoted) {
          showWorkspaceToast("Couldn't split this pane. Please try again.");
          return;
        }
        targetWorkspaceGroupId = promoted.id;
        promotedWorkspaceGroupId = promoted.id;
      }
      const created = await onSplit(
        activeTerminal,
        direction,
        targetWorkspaceGroupId,
      );
      if (!created) return;
      setMaximizedTerminalId(null);
      let savedGroupId: string | null = null;
      const nextWorkspace = updateWorkspace((current) => {
        let next = splitWorkspacePane(current, {
          activeTerminalId: sourceTerminal.id,
          newTerminalId: created.id,
          direction,
        });
        if (!next.groups.some((group) => containsTerminal(group.root, created.id))) {
          const fallbackGroupId =
            sourceGroupId && next.groups.some((group) => group.id === sourceGroupId)
              ? sourceGroupId
              : next.activeGroupId;
          if (fallbackGroupId) {
            next = appendWorkspacePaneToGroup(next, {
              groupId: fallbackGroupId,
              newTerminalId: created.id,
            });
          }
        }
        savedGroupId =
          next.groups.find((group) => containsTerminal(group.root, created.id))
            ?.id ?? next.activeGroupId;
        return next;
      });
      onPick(created.id);
      requestPaneFit(
        collectIds(getActiveWorkspaceGroup(nextWorkspace)?.root ?? null),
        { focusTerminalId: created.id },
      );
      await persistGroupLayout(
        nextWorkspace,
        savedGroupId,
        promotedWorkspaceGroupId ?? savedGroupId,
      );
    },
    [
      activeGroup,
      activeTerminal,
      commandMachineId,
      isController,
      onCreatePane,
      onPick,
      onPromoteGroup,
      onSplit,
      persistGroupLayout,
      requestPaneFit,
      terminal.cwd,
      updateWorkspace,
    ],
  );

  const handleFit = useCallback(() => {
    activeCardRef.current?.fitToContainer();
  }, []);

  // ⌃B r: flip every split direction in the active group's layout tree
  // (stacked ↔ side-by-side) without touching pane order or ratios.
  const handleRotateLayout = useCallback(() => {
    if (!isController) return;
    const group = getActiveWorkspaceGroup(workspaceRef.current);
    if (!group || collectIds(group.root).length < 2) return;
    const groupId = group.id;
    const nextWorkspace = updateWorkspace((current) =>
      rotateWorkspaceLayout(current),
    );
    requestPaneFit(collectIds(getActiveWorkspaceGroup(nextWorkspace)?.root ?? null), {
      focusTerminalId: nextWorkspace.activeTerminalId,
    });
    void persistGroupLayout(nextWorkspace, groupId);
  }, [isController, persistGroupLayout, requestPaneFit, updateWorkspace]);

  const handleReorderGroups = useCallback(
    async (
      sourceGroupId: string,
      targetGroupId: string,
      placement: GroupDropPlacement,
    ) => {
      if (sourceGroupId === targetGroupId) return;
      // cwd fallback tabs have no workspace_groups row, so a drop involving
      // one promotes it to a persistent group first. Promotion happens at
      // drop, never at drag start — the tab's id changes during promotion
      // and must stay stable while a drag is in flight.
      const promotedIds: Record<string, string> = {};
      for (const endGroupId of [targetGroupId, sourceGroupId]) {
        // Look the group up fresh each step: the terminal assignments fire
        // terminal_updated events whose reconcile rebuilds the groups
        // (fallback tab out, persistent twin in) while we await.
        const fallbackGroup = workspaceRef.current.groups.find(
          (candidate) => candidate.id === endGroupId && !candidate.persistent,
        );
        if (!fallbackGroup) continue;
        const terminalIds = collectIds(fallbackGroup.root);
        const machineId =
          terminalIds
            .map((id) => terminalsById.get(id)?.machine_id)
            .find((id): id is string => Boolean(id)) ?? commandMachineId;
        const created = await onPromoteGroup(
          machineId,
          fallbackGroup.label,
          terminalIds,
        ).catch((error) => {
          console.error("Failed to promote workspace group", error);
          return null;
        });
        // Promotion failed — abort the reorder, leave everything as-is.
        if (!created) return;
        promotedIds[endGroupId] = created.id;
        // Re-save the pane layout under the new group key only after the
        // terminal assignments: the hub validates layout terminal ids
        // against the group's members. A single-pane tab has a trivial
        // layout; still saved for correctness.
        try {
          await onSaveWorkspaceLayout(machineId, created.id, fallbackGroup.root);
        } catch (error) {
          console.error("Failed to save workspace pane layout", error);
        }
        if (workspaceRef.current.activeGroupId === endGroupId) {
          updateWorkspace((prev) => ({ ...prev, activeGroupId: created.id }));
        }
      }
      const nextIds = buildReorderPersistentGroupIds(
        workspaceRef.current.groups,
        sourceGroupId,
        targetGroupId,
        placement,
        promotedIds,
      );
      if (!nextIds) return;
      updateWorkspace((prev) => ({
        ...prev,
        groups: reorderWorkspaceGroupsForDisplay(
          prev.groups,
          sourceGroupId,
          targetGroupId,
          placement,
        ),
      }));
      const groups = await onReorderGroups(commandMachineId, nextIds);
      if (!groups) return;
      updateWorkspace((prev) =>
        reconcileTerminalWorkspace(
          prev,
          siblings,
          prev.activeTerminalId,
          groups,
          workspaceLayouts,
        ),
      );
    },
    [
      commandMachineId,
      onPromoteGroup,
      onReorderGroups,
      onSaveWorkspaceLayout,
      siblings,
      terminalsById,
      updateWorkspace,
      workspaceLayouts,
    ],
  );

  const focusPaneByDirection = useCallback(
    (direction: WorkspacePaneFocusDirection) => {
      if (maximizedTerminalId) return;
      const root = getActiveWorkspaceGroup(workspace)?.root ?? null;
      const nextTerminalId = findAdjacentWorkspacePane(
        root,
        direction,
        workspace.activeTerminalId,
      );
      if (nextTerminalId) activateTerminal(nextTerminalId);
    },
    [activateTerminal, maximizedTerminalId, workspace],
  );

  const switchGroupByOffset = useCallback(
    (offset: number) => {
      const groups = workspace.groups;
      if (groups.length === 0) return;
      const currentIndex = Math.max(
        0,
        groups.findIndex((group) => group.id === workspace.activeGroupId),
      );
      const nextIndex = (currentIndex + offset + groups.length) % groups.length;
      const nextGroup = groups[nextIndex];
      if (nextGroup && nextGroup.id !== workspace.activeGroupId) {
        activateGroup(nextGroup.id);
      }
    },
    [activateGroup, workspace.activeGroupId, workspace.groups],
  );

  const switchGroupByIndex = useCallback(
    (index: number) => {
      const group = workspace.groups[index];
      if (group && group.id !== workspace.activeGroupId) activateGroup(group.id);
    },
    [activateGroup, workspace.activeGroupId, workspace.groups],
  );

  const handleDestroy = useCallback(
    (target: TerminalInfo) => {
      if (!isController) return;
      const currentWorkspace = workspaceRef.current;
      const targetGroupId =
        currentWorkspace.groups.find((group) =>
          containsTerminal(group.root, target.id),
        )?.id ?? null;
      const previewWorkspace = closeWorkspacePane(currentWorkspace, target.id);
      const applyClosedWorkspace = () => {
        const before = workspaceRef.current;
        const nextWorkspace = updateWorkspace((current) =>
          closeWorkspacePane(current, target.id),
        );
        if (
          before.activeTerminalId === target.id &&
          nextWorkspace.activeTerminalId &&
          nextWorkspace.activeTerminalId !== target.id
        ) {
          onPick(nextWorkspace.activeTerminalId);
        }
        if (maximizedTerminalId === target.id) setMaximizedTerminalId(null);
        void persistGroupLayout(nextWorkspace, targetGroupId);
      };
      void (async () => {
        const result = await onDestroy(target, {
          keepWorkspaceOpen:
            currentWorkspace.activeTerminalId === target.id &&
            !previewWorkspace.activeTerminalId &&
            Boolean(previewWorkspace.activeGroupId),
          afterAccepted: applyClosedWorkspace,
        });
        if (result !== "accepted") return;
        applyClosedWorkspace();
      })().catch((error) => {
        console.error("Failed to close workspace pane", error);
      });
    },
    [
      isController,
      maximizedTerminalId,
      onDestroy,
      onPick,
      persistGroupLayout,
      updateWorkspace,
    ],
  );

  // ---- prefix-key engine wiring (⌃B) ----
  // Workspace-owned prefix actions register into the shared dispatcher (the
  // window keydown listener lives in TerminalCanvas). Handlers sit in a ref
  // so the registration effect stays stable while calling the latest
  // closures.
  const prefixKey = usePrefixKey();
  const workspacePrefixActionsRef = useRef<
    Partial<Record<PrefixActionId, () => void>>
  >({});

  const toggleMaximizeActivePane = useCallback(() => {
    if (!activeTerminal) return;
    setMaximizedTerminalId((value) =>
      value === activeTerminal.id ? null : activeTerminal.id,
    );
    // Zoom no longer remounts the pane (it's a z-index overlay), so the
    // size change needs an explicit refit — mount-time fit doesn't happen.
    requestPaneFit(activeTerminal.id, { focusTerminalId: activeTerminal.id });
  }, [activeTerminal, requestPaneFit]);

  workspacePrefixActionsRef.current = {
    splitRight: () => void handleSplit("right"),
    splitDown: () => void handleSplit("down"),
    rotateLayout: handleRotateLayout,
    paneLeft: () => focusPaneByDirection("left"),
    paneRight: () => focusPaneByDirection("right"),
    paneUp: () => focusPaneByDirection("up"),
    paneDown: () => focusPaneByDirection("down"),
    zoomPane: toggleMaximizeActivePane,
    closePane: () => {
      if (activeTerminal) handleDestroy(activeTerminal);
    },
    nextTab: () => switchGroupByOffset(1),
    prevTab: () => switchGroupByOffset(-1),
    selectTab1: () => switchGroupByIndex(0),
    selectTab2: () => switchGroupByIndex(1),
    selectTab3: () => switchGroupByIndex(2),
    selectTab4: () => switchGroupByIndex(3),
    selectTab5: () => switchGroupByIndex(4),
    selectTab6: () => switchGroupByIndex(5),
    selectTab7: () => switchGroupByIndex(6),
    selectTab8: () => switchGroupByIndex(7),
    selectTab9: () => switchGroupByIndex(8),
  };

  useEffect(() => {
    for (const action of WORKSPACE_PREFIX_ACTIONS) {
      prefixKey.setActionHandler(action, () =>
        workspacePrefixActionsRef.current[action]?.(),
      );
    }
    // ⌃B ⌃B sends a literal Ctrl+B byte (0x02) to the focused terminal.
    prefixKey.setLiteralHandler(() => {
      activeCardRef.current?.sendInput("\x02");
    });
    return () => {
      for (const action of WORKSPACE_PREFIX_ACTIONS) {
        prefixKey.clearActionHandler(action);
      }
      prefixKey.setLiteralHandler(null);
    };
  }, [prefixKey]);

  // ---- desktop chrome command channel (TabBar / command palette) ----
  // Handlers change identity every render, so the ref is refilled on every
  // commit rather than memoized.
  useEffect(() => {
    if (!commandsRef) return;
    commandsRef.current = {
      openWebPreview: () => {
        if (activeTerminal) setWebPreviewTerminal(activeTerminal);
      },
      selectGroup: (groupId) => activateGroup(groupId),
      reorderGroups: (sourceGroupId, targetGroupId, placement) =>
        void handleReorderGroups(sourceGroupId, targetGroupId, placement),
      runPrefixAction: (action) =>
        workspacePrefixActionsRef.current[action]?.(),
    };
  });

  useEffect(
    () => () => {
      if (commandsRef) commandsRef.current = {};
    },
    [commandsRef],
  );

  useEffect(() => {
    onActiveGroupChange?.(workspace.activeGroupId);
  }, [onActiveGroupChange, workspace.activeGroupId]);

  // Right-clicking a desktop pane also focuses it (the leaf's onMouseDown),
  // so by the time a menu item is clicked the split/zoom handlers below see
  // that pane as the active one. Touch uses the same menu via long-press.
  const handlePaneContextMenu = useCallback(
    (terminalId: string, event: PaneMenuEvent) => {
      if (isCompact) return;
      event.preventDefault();
      setPaneMenu({ terminalId, x: event.clientX, y: event.clientY });
    },
    [isCompact],
  );

  // Fold/unfold and inner-screen rotation fire window.resize. Compact chrome
  // refits on mount via the leaf effect; the large workspace must request a
  // fit here because ResizeObserver only remeasures, it does not emit resize
  // frames. Desktop mouse is left alone so existing fit-stability contracts
  // stay intact — only touch workspaces subscribe.
  useEffect(() => {
    if (!isTouch || isCompact || !isController) return;
    const fitVisible = () => {
      const group = getActiveWorkspaceGroup(workspaceRef.current);
      requestPaneFit(collectIds(group?.root ?? null), {
        focusTerminalId: workspaceRef.current.activeTerminalId,
      });
    };
    fitVisible();
    window.addEventListener("resize", fitVisible);
    return () => window.removeEventListener("resize", fitVisible);
  }, [isCompact, isController, isTouch, requestPaneFit]);

  if (isCompact) {
    // Compact P1 shell: the workspace renders chromeless inside
    // MobileWorkbench — the session title bar above and the key bar below (the
    // key bar lives inside TerminalCard) are the only permanent chrome.
    return (
      <div
        data-testid="expanded-terminal"
        style={{
          flex: 1,
          minHeight: 0,
          background: terminalTheme.background,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {activeTerminal ? (
            <WorkspacePaneLeaf
              terminal={activeTerminal}
              isActive
              isController={isController}
              canType={canType}
              eventsReconnecting={eventsReconnecting}
              deviceId={deviceId}
              isCompact
              isTouch={isTouch}
              focusRing={activeGroupPaneCount > 1}
              fitRequestNonce={
                fitRequest?.terminalIds.includes(activeTerminal.id)
                  ? fitRequest.nonce
                  : null
              }
              fitRequestShouldFocus={
                fitRequest?.focusTerminalId === activeTerminal.id
              }
              onActiveRef={(ref) => {
                activeCardRef.current = ref;
              }}
              onFitRequestHandled={handleFitRequestHandled}
              onFocus={activateTerminal}
              onDestroy={handleDestroy}
              onRequestControl={onRequestControl}
              onReleaseControl={onReleaseControl}
            />
          ) : (
            <EmptyWorkspaceGroup
              group={activeGroup}
              isController={isController}
              onNewPane={() => void handleSplit("right")}
            />
          )}
        </div>
        {webPreviewTerminal && <WebPreviewDialog machineId={webPreviewTerminal.machine_id} terminalId={webPreviewTerminal.id} onClose={() => setWebPreviewTerminal(null)} />}
      </div>
    );
  }

  const paneMenuTerminal = paneMenu
    ? terminalsById.get(paneMenu.terminalId) ?? null
    : null;
  const paneMenuItems: ContextMenuEntry[] = paneMenuTerminal
    ? [
        { label: "Open web preview", onClick: () => setWebPreviewTerminal(paneMenuTerminal) },
        {
          label: "Split right",
          shortcut: formatPrefixBinding("splitRight"),
          disabled: !isController || activeGroupFull,
          onClick: () => void handleSplit("right"),
        },
        {
          label: "Split down",
          shortcut: formatPrefixBinding("splitDown"),
          disabled: !isController || activeGroupFull,
          onClick: () => void handleSplit("down"),
        },
        {
          label: "Rotate layout",
          shortcut: formatPrefixBinding("rotateLayout"),
          disabled: !isController || activeGroupPaneCount < 2,
          onClick: handleRotateLayout,
        },
        {
          label: "Zoom",
          shortcut: formatPrefixBinding("zoomPane"),
          onClick: toggleMaximizeActivePane,
        },
        {
          label: "Fit to window",
          disabled: !isController,
          // Same behaviour as the deleted toolbar Fit button: the pane is
          // already active (right-click focused it), and the fit always
          // emits a resize frame — e2e fit-stability contracts rely on it.
          onClick: handleFit,
        },
        { type: "separator" },
        {
          label: "Move pane to tab",
          disabled: !isController,
          onClick: () => {},
          children: [
            (() => {
              // Ungrouping drops the pane into the cwd fallback tab, which
              // is capped the same way.
              const cwdTab =
                workspace.groups.find(
                  (group) =>
                    !group.persistent && group.cwd === paneMenuTerminal.cwd,
                ) ?? null;
              const full =
                isWorkspaceGroupFull(cwdTab) &&
                !containsTerminal(cwdTab?.root ?? null, paneMenuTerminal.id);
              return {
                label: full ? "cwd (full)" : "cwd",
                disabled: full,
                onClick: () => void onAssignGroup(paneMenuTerminal, null),
              };
            })(),
            ...workspace.groups
              .filter((group) => group.persistent && group.workspaceGroupId)
              .map((group) => {
                // A tab already at the cap cannot take the pane — the hub
                // rejects the assignment too.
                const full =
                  isWorkspaceGroupFull(group) &&
                  !containsTerminal(group.root, paneMenuTerminal.id);
                return {
                  label: full
                    ? `${group.label} (full)`
                    : group.label,
                  disabled: full,
                  onClick: () =>
                    void onAssignGroup(
                      paneMenuTerminal,
                      group.workspaceGroupId ?? null,
                    ),
                };
              }),
          ],
        },
        { type: "separator" },
        {
          label: "Close pane",
          shortcut: formatPrefixBinding("closePane"),
          disabled: !isController,
          onClick: () => handleDestroy(paneMenuTerminal),
        },
      ]
    : [];

  return (
    <div
      data-testid="expanded-terminal"
      style={{
        flex: 1,
        minHeight: 0,
        background: terminalTheme.background,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: 8,
          background: terminalTheme.background,
        }}
      >
        {activeGroup?.root ? (
          // Every mounted group's tree renders stacked in one relative
          // container; the wrapper key keeps the tree (xterm + WS + tmux
          // attach) alive across group switches. The hidden group uses
          // visibility, NOT display:none — layout must keep running so
          // ResizeObserver/fit stay correct while hidden. Zoom renders
          // INSIDE the pane tree as a z-index overlay so the other panes
          // (and the zoomed pane itself) keep their xterm instances
          // mounted — see WorkspacePaneTree.
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {mountedGroups.map((group) => {
              const isActiveGroup = group.id === activeGroup.id;
              return (
                <div
                  key={group.id}
                  style={{
                    position: "absolute",
                    inset: 0,
                    visibility: isActiveGroup ? "visible" : "hidden",
                    pointerEvents: isActiveGroup ? "auto" : "none",
                    zIndex: isActiveGroup ? 1 : 0,
                  }}
                >
                  {group.root ? (
                    <WorkspacePaneTree
                      node={group.root}
                      // A hidden group's tree gets no active leaf (two
                      // active leaves race focus/onActiveRef — see the
                      // zoom comment in WorkspacePaneTree) and no zoom or
                      // fit requests; those are re-issued on switch-back.
                      maximizedTerminalId={
                        isActiveGroup ? maximizedTerminalId : null
                      }
                      terminalsById={
                        isActiveGroup
                          ? terminalsById
                          : new Map(
                              [...terminalsById].filter(
                                ([id]) => !activePaneIds.has(id),
                              ),
                            )
                      }
                      activeTerminalId={
                        isActiveGroup ? activeTerminal?.id ?? null : null
                      }
                      isController={isController}
                      canType={canType}
                      eventsReconnecting={eventsReconnecting}
                      deviceId={deviceId}
                      isTouch={isTouch}
                      focusRing={collectIds(group.root).length > 1}
                      fitRequest={isActiveGroup ? fitRequest : null}
                      onActiveRef={(ref) => {
                        activeCardRef.current = ref;
                      }}
                      onFitRequestHandled={handleFitRequestHandled}
                      onFocus={activateTerminal}
                      onDestroy={handleDestroy}
                      onPaneContextMenu={handlePaneContextMenu}
                      onRequestControl={onRequestControl}
                      onReleaseControl={onReleaseControl}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : maximizedTerminalId ? (
          // Defensive: a zoom without a layout tree (shouldn't happen in
          // practice) still renders the terminal full-size.
          <WorkspacePaneLeaf
            terminal={
              terminalsById.get(maximizedTerminalId) ??
              activeTerminal ??
              terminal
            }
            isActive
            isController={isController}
            canType={canType}
            eventsReconnecting={eventsReconnecting}
            deviceId={deviceId}
            isCompact={false}
            isTouch={isTouch}
            focusRing={activeGroupPaneCount > 1}
            fitRequestNonce={
              fitRequest?.terminalIds.includes(maximizedTerminalId)
                ? fitRequest.nonce
                : null
            }
            fitRequestShouldFocus={
              fitRequest?.focusTerminalId === maximizedTerminalId
            }
            onActiveRef={(ref) => {
              activeCardRef.current = ref;
            }}
            onFitRequestHandled={handleFitRequestHandled}
            onFocus={activateTerminal}
            onDestroy={handleDestroy}
            onPaneContextMenu={handlePaneContextMenu}
            onRequestControl={onRequestControl}
            onReleaseControl={onReleaseControl}
          />
        ) : (
          <EmptyWorkspaceGroup
            group={activeGroup}
            isController={isController}
            onNewPane={() => void handleSplit("right")}
          />
        )}
      </div>
      {webPreviewTerminal && <WebPreviewDialog machineId={webPreviewTerminal.machine_id} terminalId={webPreviewTerminal.id} onClose={() => setWebPreviewTerminal(null)} />}
      {paneMenu && paneMenuTerminal && (
        <ContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          items={paneMenuItems}
          onClose={() => setPaneMenu(null)}
        />
      )}
    </div>
  );
}

export const TerminalWorkspace = memo(TerminalWorkspaceComponent);

// Renders the layout tree as a FLAT list of absolutely positioned panes
// keyed by terminal id inside one relative container. Compared to the old
// recursive div tree this means layout changes (rotate, close, split, drag
// ratios, zoom) only move rects around: React reconciles by key and never
// unmounts a surviving pane, so its xterm instance, WebSocket, and the
// machine-side tmux attach all stay alive. Zoom is a z-index overlay — the
// covered panes keep their real size, so no spurious refits reach tmux.
//
// Touch workspaces (Fold inner screen, ~760-840 CSS px wide) render every
// split stacked as a single column: side-by-side terminals get ~40 cols
// each, too narrow to read. Only the rendering is overridden — the split
// direction persisted on the hub is untouched, so the same group keeps its
// saved side-by-side arrangement on desktop clients.
function WorkspacePaneTree({
  node,
  maximizedTerminalId,
  terminalsById,
  activeTerminalId,
  isController,
  canType,
  eventsReconnecting,
  deviceId,
  isTouch,
  focusRing = true,
  fitRequest,
  onActiveRef,
  onFitRequestHandled,
  onFocus,
  onDestroy,
  onPaneContextMenu,
  onRequestControl,
  onReleaseControl,
}: {
  node: WorkspacePaneNode;
  maximizedTerminalId: string | null;
  terminalsById: Map<string, TerminalInfo>;
  activeTerminalId: string | null;
  isController: boolean;
  canType: boolean;
  eventsReconnecting: boolean;
  deviceId: string;
  isTouch: boolean;
  focusRing?: boolean;
  fitRequest: WorkspaceFitRequest | null;
  onActiveRef: (ref: TerminalCardRef | null) => void;
  onFitRequestHandled: (nonce: number, terminalId: string) => void;
  onFocus: (id: string) => void;
  onDestroy: (terminal: TerminalInfo) => void;
  onPaneContextMenu: (
    terminalId: string,
    event: PaneMenuEvent,
  ) => void;
  onRequestControl?: (machineId: string) => void;
  onReleaseControl?: (machineId: string) => void;
}) {
  const panes = flattenWorkspacePanes(node, { stackVertically: isTouch });
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {panes.map((pane) => {
        const terminal = terminalsById.get(pane.terminalId);
        if (!terminal) return null;
        const isMaximized = pane.terminalId === maximizedTerminalId;
        return (
          <div
            key={pane.terminalId}
            style={
              isMaximized
                ? {
                    position: "absolute",
                    inset: 0,
                    zIndex: 1,
                    background: terminalTheme.background,
                  }
                : {
                    position: "absolute",
                    left: `${pane.left * 100}%`,
                    top: `${pane.top * 100}%`,
                    width: `${pane.width * 100}%`,
                    height: `${pane.height * 100}%`,
                  }
            }
          >
            <WorkspacePaneLeaf
              terminal={terminal}
              // While a zoom overlay is up, the zoomed pane is the ONLY
              // active one — even if activeTerminalId points elsewhere
              // (external switches don't clear the zoom). Two mounted
              // panes must never both be active: their focus effects and
              // onActiveRef would race, sending keystrokes to the covered
              // pane. This matches the pre-flat behavior, where zoom
              // rendered a single hardcoded-active leaf.
              isActive={
                maximizedTerminalId !== null
                  ? isMaximized
                  : terminal.id === activeTerminalId
              }
              isController={isController}
              canType={canType}
              eventsReconnecting={eventsReconnecting}
              deviceId={deviceId}
              isCompact={false}
              isTouch={isTouch}
              focusRing={focusRing}
              fitRequestNonce={
                fitRequest?.terminalIds.includes(terminal.id)
                  ? fitRequest.nonce
                  : null
              }
              fitRequestShouldFocus={
                fitRequest?.focusTerminalId === terminal.id
              }
              onActiveRef={onActiveRef}
              onFitRequestHandled={onFitRequestHandled}
              onFocus={onFocus}
              onDestroy={onDestroy}
              onPaneContextMenu={onPaneContextMenu}
              onRequestControl={onRequestControl}
              onReleaseControl={onReleaseControl}
            />
          </div>
        );
      })}
    </div>
  );
}

export function WorkspacePaneLeaf({
  terminal,
  isActive,
  isController,
  canType,
  eventsReconnecting,
  deviceId,
  isCompact,
  isTouch,
  focusRing = true,
  fitRequestNonce,
  fitRequestShouldFocus,
  onActiveRef,
  onFitRequestHandled,
  onFocus,
  onDestroy,
  onPaneContextMenu,
  onRequestControl,
  onReleaseControl,
}: {
  terminal: TerminalInfo;
  isActive: boolean;
  isController: boolean;
  canType: boolean;
  eventsReconnecting: boolean;
  deviceId: string;
  isCompact: boolean;
  isTouch: boolean;
  // False when the group has a single pane — a lone pane renders the plain
  // line border instead of the focused-pane accent ring.
  focusRing?: boolean;
  fitRequestNonce: number | null;
  fitRequestShouldFocus: boolean;
  onActiveRef: (ref: TerminalCardRef | null) => void;
  onFitRequestHandled: (nonce: number, terminalId: string) => void;
  onFocus: (id: string) => void;
  onDestroy: (terminal: TerminalInfo) => void;
  onPaneContextMenu?: (
    terminalId: string,
    event: PaneMenuEvent,
  ) => void;
  onRequestControl?: (machineId: string) => void;
  onReleaseControl?: (machineId: string) => void;
}) {
  const cardRef = useRef<TerminalCardRef>(null);
  const longPress = useLongPress((point) => {
    onFocus(terminal.id);
    onPaneContextMenu?.(terminal.id, {
      clientX: point.x,
      clientY: point.y,
      preventDefault: () => {},
    });
  }, Boolean(isTouch && onPaneContextMenu));

  useEffect(() => {
    if (!isActive) return;
    const frame = requestAnimationFrame(() => {
      if (isCompact && isController) {
        cardRef.current?.fitToContainer({ skipIfUnchanged: true });
      } else if (canType && !isTouch) {
        cardRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [canType, isActive, isCompact, isController, isTouch, terminal.id]);

  useEffect(() => {
    if (!isController || fitRequestNonce === null) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const card = cardRef.current;
        if (!card) return;
        card.fitToContainer({
          skipIfUnchanged: true,
          focusAfterFit: fitRequestShouldFocus,
        });
        onFitRequestHandled(fitRequestNonce, terminal.id);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    fitRequestNonce,
    fitRequestShouldFocus,
    isController,
    onFitRequestHandled,
    terminal.id,
  ]);

  useEffect(() => {
    if (!isActive) return;
    onActiveRef(cardRef.current);
    return () => onActiveRef(null);
  }, [isActive, onActiveRef]);

  return (
    <div
      data-testid={`workspace-pane-${terminal.id}`}
      onMouseDown={() => onFocus(terminal.id)}
      onMouseMove={(event) => {
        if (isTouch || isActive) return;
        const target = event.target;
        if (target instanceof Element && target.closest("button")) return;
        onFocus(terminal.id);
      }}
      onContextMenu={(event) => onPaneContextMenu?.(terminal.id, event)}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="terminal-select-overlay"]')
        ) {
          return;
        }
        longPress.onPointerDown(event);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: colors.bg0,
        // Focused pane: subtle 1px accent inner border; unfocused (or lone
        // pane in a single-pane group): plain line.
        border: `1px solid ${
          isActive && focusRing ? colorAlpha.accentLine : colors.line
        }`,
        boxShadow:
          isActive && focusRing
            ? `0 0 0 1px ${colorAlpha.accentLine}`
            : "none",
        overflow: "hidden",
      }}
    >
      <TerminalCard
        ref={cardRef}
        terminal={terminal}
        displayMode="tab"
        isCompact={isCompact}
        isTouch={isTouch}
        isActive={isActive}
        isController={isController}
        canType={canType}
        eventsReconnecting={eventsReconnecting}
        reconnectIndicatorActive={isActive}
        deviceId={deviceId}
        onSelectTab={NOOP_SELECT_TAB}
        onDestroy={onDestroy}
        onRequestControl={onRequestControl}
        onReleaseControl={onReleaseControl}
      />
    </div>
  );
}

function EmptyWorkspaceGroup({
  group,
  isController,
  onNewPane,
}: {
  group: WorkspaceGroup | null;
  isController: boolean;
  onNewPane: () => void;
}) {
  return (
    <div
      data-testid="workspace-empty-group"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: colors.bg0,
        border: `1px solid ${colors.lineSoft}`,
      }}
    >
      <button
        type="button"
        disabled={!isController || !group}
        onClick={onNewPane}
        style={{
          ...drawerNewButtonStyle,
          opacity: isController && group ? 1 : 0.5,
          cursor: isController && group ? "pointer" : "not-allowed",
        }}
      >
        <Plus size={14} />
        New pane
      </button>
    </div>
  );
}

const drawerNewButtonStyle: CSSProperties = {
  width: "100%",
  height: 38,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  borderRadius: 7,
  border: `1px solid ${colors.lineSoft}`,
  background: colors.bg2,
  color: colors.fg1,
  fontSize: 13,
  fontWeight: 700,
};

function collectIds(root: WorkspacePaneNode | null): string[] {
  if (!root) return [];
  if (root.type === "leaf") return [root.terminalId];
  return [...collectIds(root.first), ...collectIds(root.second)];
}

function reorderWorkspaceGroupsForDisplay(
  groups: WorkspaceGroup[],
  sourceGroupId: string,
  targetGroupId: string,
  placement: GroupDropPlacement,
): WorkspaceGroup[] {
  return moveRelative(
    groups,
    sourceGroupId,
    targetGroupId,
    placement,
    (group) => group.id,
  );
}

function moveRelative<T>(
  items: T[],
  sourceGroupId: string,
  targetGroupId: string,
  placement: GroupDropPlacement,
  getId: (item: T) => string,
): T[] {
  const next = items.slice();
  const sourceIndex = next.findIndex((item) => getId(item) === sourceGroupId);
  if (sourceIndex === -1) return items;
  const [source] = next.splice(sourceIndex, 1);
  const targetIndex = next.findIndex((item) => getId(item) === targetGroupId);
  if (targetIndex === -1) return items;
  next.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, source);
  return next;
}

function containsTerminal(root: WorkspacePaneNode | null, terminalId: string) {
  return collectIds(root).includes(terminalId);
}
