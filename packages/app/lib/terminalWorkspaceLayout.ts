import { MAX_PANES_PER_TAB } from "@offdesk/shared";
import type {
  AgentBrowserInfo,
  TerminalInfo,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
  WorkspaceLayoutNode,
} from "@offdesk/shared";

export type WorkspaceSplitDirection = "horizontal" | "vertical";
export type WorkspaceSplitIntent = "right" | "down";
export type WorkspacePaneFocusDirection = "left" | "right" | "up" | "down";

export type WorkspacePaneNode = WorkspaceLayoutNode;

export interface WorkspaceGroup {
  id: string;
  label: string;
  cwd: string;
  workspaceGroupId: string | null;
  persistent: boolean;
  root: WorkspacePaneNode | null;
  paneCount: number;
  /// `updated_at` of the saved layout `root` was last built from, or null
  /// when none was. A newer saved layout replaces the root on reconcile.
  layoutUpdatedAt: number | null;
}

export interface TerminalWorkspace {
  groups: WorkspaceGroup[];
  activeGroupId: string | null;
  activeTerminalId: string | null;
}

export interface MobileWorkspaceTab {
  id: string;
  label: string;
  cwd: string;
  active: boolean;
}

interface RemoveResult {
  root: WorkspacePaneNode | null;
  fallbackTerminalId: string | null;
  removed: boolean;
}

interface PaneRect {
  terminalId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createTerminalWorkspace(
  terminals: TerminalInfo[],
  activeTerminalId: string | null,
  workspaceGroups: WorkspaceGroupInfo[] = [],
  workspaceLayouts: WorkspaceLayoutInfo[] = [],
  browsers: AgentBrowserInfo[] = [],
): TerminalWorkspace {
  const groups = createGroups(
    terminals,
    workspaceGroups,
    workspaceLayouts,
    browsers,
  );
  const activeGroup =
    groups.find((group) => groupContainsTerminal(group, activeTerminalId ?? "")) ??
    groups[0] ??
    null;
  const activeTerminal =
    activeTerminalId && paneExists(terminals, browsers, activeTerminalId)
      ? activeTerminalId
      : firstTerminalId(activeGroup?.root ?? null);

  return {
    groups,
    activeGroupId: activeGroup?.id ?? null,
    activeTerminalId: activeTerminal,
  };
}

export function splitWorkspacePane(
  workspace: TerminalWorkspace,
  input: {
    activeTerminalId: string;
    newTerminalId: string;
    direction: WorkspaceSplitIntent;
  },
): TerminalWorkspace {
  const group = workspace.groups.find((candidate) =>
    groupContainsTerminal(candidate, input.activeTerminalId),
  );
  if (!group) return workspace;

  const direction: WorkspaceSplitDirection =
    input.direction === "right" ? "horizontal" : "vertical";
  const sourceRoot = removeNode(group.root, input.newTerminalId) ?? group.root;
  const nextRoot = splitNode(
    sourceRoot,
    input.activeTerminalId,
    {
      type: "leaf",
      terminalId: input.newTerminalId,
    },
    direction,
  );
  const groups = workspace.groups.map((candidate) =>
    candidate.id === group.id
      ? {
          ...candidate,
          root: nextRoot,
          paneCount: collectPaneTerminalIds(nextRoot).length,
        }
      : candidate,
  );

  return {
    groups,
    activeGroupId: group.id,
    activeTerminalId: input.newTerminalId,
  };
}

export function appendWorkspacePaneToGroup(
  workspace: TerminalWorkspace,
  input: {
    groupId: string;
    newTerminalId: string;
  },
): TerminalWorkspace {
  const group = workspace.groups.find((candidate) => candidate.id === input.groupId);
  if (!group) return workspace;

  // The terminal may already have been appended by the reconcile effect
  // while the create request was in flight; never insert it twice.
  if (groupContainsTerminal(group, input.newTerminalId)) return workspace;

  const groups = workspace.groups.map((candidate) => {
    if (candidate.id !== group.id) return candidate;
    const root = appendNode(candidate.root, {
      type: "leaf",
      terminalId: input.newTerminalId,
    });
    return {
      ...candidate,
      root,
      paneCount: collectPaneTerminalIds(root).length,
    };
  });
  return {
    groups,
    activeGroupId: group.id,
    activeTerminalId: input.newTerminalId,
  };
}

export function closeWorkspacePane(
  workspace: TerminalWorkspace,
  terminalId: string,
): TerminalWorkspace {
  let nextActiveTerminalId = workspace.activeTerminalId;
  const groups = workspace.groups
    .map((group) => {
      if (!collectPaneTerminalIds(group.root).includes(terminalId)) {
        return group;
      }
      const result = removeNodeWithFallback(group.root, terminalId);
      const nextRoot = result.root;
      const paneIds = collectPaneTerminalIds(nextRoot);
      if (workspace.activeTerminalId === terminalId) {
        nextActiveTerminalId =
          result.fallbackTerminalId ?? paneIds[0] ?? null;
      }
      return {
        ...group,
        root: nextRoot,
        paneCount: paneIds.length,
      };
    })
    .filter(
      (group) =>
        group.persistent ||
        group.paneCount > 0 ||
        (group.id === workspace.activeGroupId && !isBrowserTabId(group.id)),
    );

  const activeGroup =
    groups.find((group) => groupContainsTerminal(group, nextActiveTerminalId ?? "")) ??
    groups.find((group) => group.id === workspace.activeGroupId) ??
    groups[0] ??
    null;

  return {
    groups,
    activeGroupId: activeGroup?.id ?? null,
    activeTerminalId:
      nextActiveTerminalId ?? firstTerminalId(activeGroup?.root ?? null),
  };
}

export function swapWorkspacePanes(
  workspace: TerminalWorkspace,
  sourceTerminalId: string,
  targetTerminalId: string,
): TerminalWorkspace {
  if (sourceTerminalId === targetTerminalId) return workspace;
  const group = workspace.groups.find((candidate) => {
    const ids = collectPaneTerminalIds(candidate.root);
    return ids.includes(sourceTerminalId) && ids.includes(targetTerminalId);
  });
  if (!group) return workspace;

  if (!group.root) return workspace;
  const root = swapLeafTerminalIds(
    group.root,
    sourceTerminalId,
    targetTerminalId,
  );
  const groups = workspace.groups.map((candidate) =>
    candidate.id === group.id
      ? {
          ...candidate,
          root,
          paneCount: collectPaneTerminalIds(root).length,
        }
      : candidate,
  );

  return {
    groups,
    activeGroupId: group.id,
    activeTerminalId: sourceTerminalId,
  };
}

export function rotateWorkspaceLayout(
  workspace: TerminalWorkspace,
): TerminalWorkspace {
  const group = workspace.groups.find(
    (candidate) => candidate.id === workspace.activeGroupId,
  );
  if (!group || !group.root || group.root.type !== "split") return workspace;

  const root = rotateSplitDirections(group.root);
  const groups = workspace.groups.map((candidate) =>
    candidate.id === group.id
      ? {
          ...candidate,
          root,
          paneCount: collectPaneTerminalIds(root).length,
        }
      : candidate,
  );

  return {
    ...workspace,
    groups,
  };
}

// ⌃B E: re-tile the active group into an even grid (tmux `select-layout
// tiled`) in its current pane order — four panes become quadrants.
export function tileWorkspaceLayout(
  workspace: TerminalWorkspace,
): TerminalWorkspace {
  const group = workspace.groups.find(
    (candidate) => candidate.id === workspace.activeGroupId,
  );
  if (!group || !group.root || group.root.type !== "split") return workspace;

  const root = tileGrid(collectPaneTerminalIds(group.root));
  if (!root || sameLayout(root, group.root)) return workspace;
  const groups = workspace.groups.map((candidate) =>
    candidate.id === group.id
      ? {
          ...candidate,
          root,
          paneCount: collectPaneTerminalIds(root).length,
        }
      : candidate,
  );

  return {
    ...workspace,
    groups,
  };
}

function sameLayout(a: WorkspacePaneNode, b: WorkspacePaneNode): boolean {
  if (a.type === "leaf" || b.type === "leaf") {
    return (
      a.type === "leaf" && b.type === "leaf" && a.terminalId === b.terminalId
    );
  }
  return (
    a.direction === b.direction &&
    Math.abs(a.ratio - b.ratio) < 1e-9 &&
    sameLayout(a.first, b.first) &&
    sameLayout(a.second, b.second)
  );
}

export function reconcileTerminalWorkspace(
  workspace: TerminalWorkspace,
  terminals: TerminalInfo[],
  activeTerminalId: string | null,
  workspaceGroups: WorkspaceGroupInfo[] = [],
  workspaceLayouts: WorkspaceLayoutInfo[] = [],
  // Groups with a local layout save in flight: a saved layout arriving now
  // may predate that save, so adopting it would undo the local change.
  skipLayoutAdoptionGroupIds: ReadonlySet<string> = new Set(),
  browsers: AgentBrowserInfo[] = [],
): TerminalWorkspace {
  const grouped = createGroups(
    terminals,
    workspaceGroups,
    workspaceLayouts,
    browsers,
  );
  let fallbackForRemovedActive: string | null = null;
  let groups = grouped.map((group) => {
    const previous = workspace.groups.find(
      (candidate) => candidate.id === group.id,
    );
    if (!previous) return group;

    // A layout saved after this group's root was built — by another device,
    // or through the API — replaces the local root, so a running client
    // shows it without a restart. Our own save echoes back here too; it
    // matches the local root, which then keeps its identity.
    if (
      group.layoutUpdatedAt !== null &&
      group.layoutUpdatedAt > (previous.layoutUpdatedAt ?? -Infinity) &&
      !skipLayoutAdoptionGroupIds.has(group.id)
    ) {
      const adoptedIds = new Set(collectPaneTerminalIds(group.root));
      for (const id of collectPaneTerminalIds(previous.root)) {
        if (
          !adoptedIds.has(id) &&
          (id === workspace.activeTerminalId || id === activeTerminalId)
        ) {
          fallbackForRemovedActive =
            fallbackForRemovedActive ?? firstTerminalId(group.root);
        }
      }
      const root =
        previous.root && group.root && sameLayout(previous.root, group.root)
          ? previous.root
          : group.root;
      return { ...group, root };
    }

    const groupTerminalIds = new Set(collectPaneTerminalIds(group.root));

    let root = previous.root;
    for (const id of collectPaneTerminalIds(root)) {
      if (!groupTerminalIds.has(id)) {
        const result = removeNodeWithFallback(root, id);
        root = result.root;
        if (id === workspace.activeTerminalId || id === activeTerminalId) {
          fallbackForRemovedActive =
            fallbackForRemovedActive ?? result.fallbackTerminalId;
        }
      }
    }
    const existingIds = new Set(collectPaneTerminalIds(root));
    for (const id of collectPaneTerminalIds(group.root)) {
      if (!existingIds.has(id)) {
        root = appendNode(root, { type: "leaf", terminalId: id });
        existingIds.add(id);
      }
    }
    return {
      ...group,
      root,
      paneCount: collectPaneTerminalIds(root).length,
      layoutUpdatedAt: previous.layoutUpdatedAt,
    };
  });
  groups = preserveActiveEmptyGroup(groups, workspace, terminals, browsers);

  const requestedActive =
    activeTerminalId && paneExists(terminals, browsers, activeTerminalId)
      ? activeTerminalId
      : workspace.activeTerminalId &&
          paneExists(terminals, browsers, workspace.activeTerminalId)
        ? workspace.activeTerminalId
        : fallbackForRemovedActive &&
            paneExists(terminals, browsers, fallbackForRemovedActive)
          ? fallbackForRemovedActive
          : null;
  const activeGroup =
    groups.find((group) => groupContainsTerminal(group, requestedActive ?? "")) ??
    groups.find((group) => group.id === workspace.activeGroupId) ??
    groups[0] ??
    null;

  return {
    groups,
    activeGroupId: activeGroup?.id ?? null,
    activeTerminalId:
      requestedActive ?? firstTerminalId(activeGroup?.root ?? null),
  };
}

function preserveActiveEmptyGroup(
  groups: WorkspaceGroup[],
  workspace: TerminalWorkspace,
  terminals: TerminalInfo[],
  browsers: AgentBrowserInfo[],
): WorkspaceGroup[] {
  if (!workspace.activeGroupId) return groups;
  // A browser's tab goes away with its browser; never keep it empty.
  if (isBrowserTabId(workspace.activeGroupId)) return groups;
  if (groups.some((group) => group.id === workspace.activeGroupId)) return groups;
  const activeGroup = workspace.groups.find(
    (group) => group.id === workspace.activeGroupId,
  );
  if (!activeGroup) return groups;
  const availableIds = new Set([
    ...terminals.map((terminal) => terminal.id),
    ...browsers.map((browser) => browser.id),
  ]);
  const hasRemainingPane = collectPaneTerminalIds(activeGroup.root).some((id) =>
    availableIds.has(id),
  );
  if (hasRemainingPane) return groups;
  return [
    ...groups,
    {
      ...activeGroup,
      root: null,
      paneCount: 0,
      layoutUpdatedAt: null,
    },
  ];
}

export function selectWorkspaceGroup(
  workspace: TerminalWorkspace,
  groupId: string,
): TerminalWorkspace {
  const group = workspace.groups.find((candidate) => candidate.id === groupId);
  if (!group) return workspace;
  return {
    ...workspace,
    activeGroupId: group.id,
    activeTerminalId: firstTerminalId(group.root),
  };
}

export function getActiveWorkspaceGroup(
  workspace: TerminalWorkspace,
): WorkspaceGroup | null {
  return (
    workspace.groups.find((group) => group.id === workspace.activeGroupId) ??
    null
  );
}

// Group ids whose pane trees stay mounted, most-recently-active first.
// At most one inactive group is kept alive (the previously active one —
// covers the dominant A↔B flip): each live pane holds a WebGL context and
// browsers cap contexts at ~8-16, so active(≤4) + one hidden group(≤4)
// stays ≤8 with no gpu-suspend machinery. Touch devices get no keep-alive
// (mobile WebView memory). Ids that no longer exist in the workspace (e.g.
// a deleted group) are filtered out, so deletion paths need no
// special-casing.
export function mountedWorkspaceGroupIds(
  workspace: TerminalWorkspace,
  previousActiveGroupId: string | null,
  isTouch: boolean,
): string[] {
  const cap = isTouch ? 1 : 2;
  const existing = new Set(workspace.groups.map((group) => group.id));
  const ids: string[] = [];
  for (const id of [workspace.activeGroupId, previousActiveGroupId]) {
    if (ids.length >= cap) break;
    if (id === null || !existing.has(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

export function getMobileWorkspaceTabs(
  workspace: TerminalWorkspace,
): MobileWorkspaceTab[] {
  const group = getActiveWorkspaceGroup(workspace);
  if (!group) return [];
  return workspacePaneOrder(group.root).map((id) => ({
    id,
    label: `Terminal ${id}`,
    cwd: group.cwd,
    active: workspace.activeTerminalId === id,
  }));
}

export function workspacePaneOrder(root: WorkspacePaneNode | null): string[] {
  if (!root) return [];
  if (root.type === "leaf") return [root.terminalId];
  return [
    ...workspacePaneOrder(root.first),
    ...workspacePaneOrder(root.second),
  ];
}

export function collectPaneTerminalIds(root: WorkspacePaneNode | null): string[] {
  return workspacePaneOrder(root);
}

export function groupPaneTerminalIds(group: WorkspaceGroup): string[] {
  return workspacePaneOrder(group.root);
}

export { MAX_PANES_PER_TAB };

export function workspaceGroupPaneCount(
  group: WorkspaceGroup | null | undefined,
): number {
  return group ? workspacePaneOrder(group.root).length : 0;
}

// A tab at the cap takes no more panes: splitting is refused there, and
// terminal creation aimed at it overflows into a fresh tab.
export function isWorkspaceGroupFull(
  group: WorkspaceGroup | null | undefined,
): boolean {
  return workspaceGroupPaneCount(group) >= MAX_PANES_PER_TAB;
}

export interface NewTerminalPlacement {
  // The caller must create a tab first, then create the terminal in it.
  needsNewTab: boolean;
  // Group to create the terminal in; null means "no tab in mind" — the hub
  // gives the terminal a fresh tab named after its cwd.
  workspaceGroupId: string | null;
}

// Where a newly created terminal should land. `tabId` is the WorkspaceGroup.id
// the caller aimed at; null means no tab in mind, which the hub answers with a
// brand-new tab at the end of the strip. A full target overflows into a new tab
// instead of failing: mobile has no split view and creating a terminal there
// must never dead-end.
export function planNewTerminalPlacement(
  groups: WorkspaceGroup[],
  input: { tabId: string | null; cwd: string },
): NewTerminalPlacement {
  if (!input.tabId) return { needsNewTab: false, workspaceGroupId: null };
  const target = groups.find((group) => group.id === input.tabId) ?? null;
  if (isWorkspaceGroupFull(target)) {
    return { needsNewTab: true, workspaceGroupId: null };
  }
  return {
    needsNewTab: false,
    workspaceGroupId: target?.workspaceGroupId ?? null,
  };
}

// Flat order across groups (persistent by sort_order, then cwd fallback) —
// the mobile title-bar / edge-swipe session order.
export function collectGroupPaneTerminalIds(groups: WorkspaceGroup[]): string[] {
  return groups.flatMap((group) => groupPaneTerminalIds(group));
}

export type WorkspaceGroupDropPlacement = "before" | "after";

// Build the persistent-group id order sent to the reorder endpoint after a
// tab drag. cwd fallback tabs have no workspace_groups row until the drop
// promotes them — `promotedIds` maps a fallback tab id (`cwd:<path>`) to the
// freshly created group id. Promoted ids join the persistent block in their
// visible fallback order (persistent groups always sort before remaining
// fallback tabs, so a promoted tab jumps left past un-promoted fallback
// tabs — only the relative order of the dragged tabs is guaranteed).
// Returns null when either drag end cannot resolve to a persistent id.
export function buildReorderPersistentGroupIds(
  groups: WorkspaceGroup[],
  sourceGroupId: string,
  targetGroupId: string,
  placement: WorkspaceGroupDropPlacement,
  promotedIds: Readonly<Record<string, string>> = {},
): string[] | null {
  const persistentIds: string[] = [];
  const promotedInFallbackOrder: string[] = [];
  for (const group of groups) {
    if (group.persistent && group.workspaceGroupId) {
      persistentIds.push(group.workspaceGroupId);
      continue;
    }
    const promotedId = promotedIds[group.id];
    if (promotedId) promotedInFallbackOrder.push(promotedId);
  }
  const ids = [...persistentIds, ...promotedInFallbackOrder];
  const sourceId = promotedIds[sourceGroupId] ?? sourceGroupId;
  const targetId = promotedIds[targetGroupId] ?? targetGroupId;
  if (!ids.includes(sourceId) || !ids.includes(targetId)) return null;

  const next = ids.slice();
  next.splice(next.indexOf(sourceId), 1);
  next.splice(
    placement === "after" ? next.indexOf(targetId) + 1 : next.indexOf(targetId),
    0,
    sourceId,
  );
  return next;
}

export function findAdjacentWorkspacePane(
  root: WorkspacePaneNode | null,
  direction: WorkspacePaneFocusDirection,
  activeTerminalId: string | null,
): string | null {
  if (!root || !activeTerminalId) return null;
  const panes = collectPaneRects(root, {
    terminalId: "",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const active = panes.find((pane) => pane.terminalId === activeTerminalId);
  if (!active) return null;

  const activeCenterX = active.x + active.width / 2;
  const activeCenterY = active.y + active.height / 2;
  const candidates = panes
    .filter((pane) => {
      if (pane.terminalId === active.terminalId) return false;
      const centerX = pane.x + pane.width / 2;
      const centerY = pane.y + pane.height / 2;
      if (direction === "left") {
        return centerX < activeCenterX && rangesOverlap(active, pane, "y");
      }
      if (direction === "right") {
        return centerX > activeCenterX && rangesOverlap(active, pane, "y");
      }
      if (direction === "up") {
        return centerY < activeCenterY && rangesOverlap(active, pane, "x");
      }
      return centerY > activeCenterY && rangesOverlap(active, pane, "x");
    })
    .map((pane) => ({
      pane,
      edgeDistance: edgeDistance(active, pane, direction),
      centerDistance: centerDistance(active, pane, direction),
      perpendicularDistance: perpendicularDistance(active, pane, direction),
    }))
    .sort(
      (a, b) =>
        a.edgeDistance - b.edgeDistance ||
        a.centerDistance - b.centerDistance ||
        a.perpendicularDistance - b.perpendicularDistance,
    );

  return candidates[0]?.pane.terminalId ?? null;
}

function groupContainsTerminal(group: WorkspaceGroup, terminalId: string): boolean {
  return collectPaneTerminalIds(group.root).includes(terminalId);
}

// Tabs, in strip order. Every terminal the hub creates belongs to a workspace
// group, so a tab is normally a real row with a sort_order. A terminal can
// still end up without one — its tab was deleted, or its pane was moved out of
// every tab — and those fall back to a tab derived from their cwd, which has no
// sort_order and therefore sorts after the real ones.
function createGroups(
  terminals: TerminalInfo[],
  workspaceGroups: WorkspaceGroupInfo[] = [],
  workspaceLayouts: WorkspaceLayoutInfo[] = [],
  browsers: AgentBrowserInfo[] = [],
): WorkspaceGroup[] {
  const byGroup = new Map<string, CreatedWorkspaceGroup>();
  const layoutsByGroupKey = new Map<
    string,
    {
      root: WorkspaceLayoutNode | null;
      updatedAt: number;
    }
  >(
    workspaceLayouts.map((layout) => [
      layout.group_key,
      {
        root: layout.root,
        updatedAt: layout.updated_at,
      },
    ]),
  );
  const sortedWorkspaceGroups = [...workspaceGroups].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
  for (const group of sortedWorkspaceGroups) {
    byGroup.set(group.id, {
      id: group.id,
      label: group.name,
      cwd: "",
      workspaceGroupId: group.id,
      persistent: true,
      order: group.sort_order,
      panes: [],
    });
  }

  for (const terminal of terminals) {
    const workspaceGroupId = terminal.workspace_group_id;
    const persistedGroup =
      workspaceGroupId && byGroup.get(workspaceGroupId)?.persistent
        ? byGroup.get(workspaceGroupId)
        : null;
    if (persistedGroup) {
      if (!persistedGroup.cwd) persistedGroup.cwd = terminal.cwd;
      persistedGroup.panes.push(terminal);
      continue;
    }

    // Ungrouped leftover: derived tab keyed by cwd, no workspace_groups row.
    const key = `cwd:${terminal.cwd}`;
    const fallbackGroup =
      byGroup.get(key) ??
      {
        id: key,
        label: labelFromCwd(terminal.cwd),
        cwd: terminal.cwd,
        workspaceGroupId: null,
        persistent: false,
        order: sortedWorkspaceGroups.length + byGroup.size,
        panes: [],
      };
    fallbackGroup.panes.push(terminal);
    byGroup.set(key, fallbackGroup);
  }

  // Agent browsers: a pane in the opener terminal's tab while it has room,
  // otherwise a tab of their own. The id rides in the leaf's terminalId slot.
  for (const browser of browsers) {
    const opener = browser.opener_terminal_id;
    const openerGroup = opener
      ? Array.from(byGroup.values()).find((group) =>
          group.panes.some((pane) => pane.id === opener),
        )
      : undefined;
    if (openerGroup && openerGroup.panes.length < MAX_PANES_PER_TAB) {
      openerGroup.panes.push({ id: browser.id, cwd: "" });
      continue;
    }
    const key = `${BROWSER_TAB_PREFIX}${browser.id}`;
    byGroup.set(key, {
      id: key,
      label: browserLabel(browser),
      cwd: "",
      workspaceGroupId: null,
      persistent: false,
      order: sortedWorkspaceGroups.length + byGroup.size,
      panes: [{ id: browser.id, cwd: "" }],
      browserTab: true,
    });
  }

  return Array.from(byGroup.values())
    .sort(compareCreatedGroups)
    .map((group) => {
      const terminalIds = group.panes.map((pane) => pane.id);
      const layoutEntry = layoutsByGroupKey.get(group.id);
      const root = restorePaneLayout(
        terminalIds,
        layoutEntry?.root,
      );
      const cwd =
        group.cwd ||
        group.panes.find((pane) => pane.cwd)?.cwd ||
        "";
      return {
        id: group.id,
        label: group.label,
        cwd,
        workspaceGroupId: group.workspaceGroupId,
        persistent: group.persistent,
        root,
        paneCount: group.panes.length,
        layoutUpdatedAt: layoutEntry?.updatedAt ?? null,
      };
    });
}

interface CreatedWorkspaceGroup {
  id: string;
  label: string;
  cwd: string;
  workspaceGroupId: string | null;
  persistent: boolean;
  order: number;
  /** Terminals, plus agent browsers (cwd ""), by id. */
  panes: { id: string; cwd: string }[];
  /** A tab that exists only to hold one agent browser. */
  browserTab?: boolean;
}

/** Id prefix of the never-persisted tab holding an agent browser alone. */
export const BROWSER_TAB_PREFIX = "browser:";

export function isBrowserTabId(groupId: string): boolean {
  return groupId.startsWith(BROWSER_TAB_PREFIX);
}

export function browserLabel(browser: AgentBrowserInfo): string {
  const title = browser.title.trim();
  if (title) return title;
  try {
    return new URL(browser.url).host || browser.url || "browser";
  } catch {
    return browser.url || "browser";
  }
}

function compareCreatedGroups(
  a: CreatedWorkspaceGroup,
  b: CreatedWorkspaceGroup,
): number {
  if (a.persistent !== b.persistent) return a.persistent ? -1 : 1;
  if (!!a.browserTab !== !!b.browserTab) return a.browserTab ? 1 : -1;
  // Browser tabs keep arrival order: titles change as pages load.
  if (a.browserTab && b.browserTab) return a.order - b.order;
  if (a.persistent) {
    return (
      a.order - b.order ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id)
    );
  }
  return (
    a.label.localeCompare(b.label) ||
    a.cwd.localeCompare(b.cwd) ||
    a.id.localeCompare(b.id)
  );
}

function restorePaneLayout(
  ids: string[],
  savedRoot: WorkspacePaneNode | null | undefined,
): WorkspacePaneNode | null {
  const available = new Set(ids);
  const consumed = new Set<string>();
  let root = savedRoot
    ? sanitizePaneNode(savedRoot, available, consumed, 0)
    : null;
  if (!root) {
    // No usable saved layout: tile evenly. Appending each pane with a
    // nested 50/50 split would shrink every new pane to a sliver.
    return tileGrid(ids);
  }
  for (const id of ids) {
    if (!consumed.has(id)) {
      root = appendNode(root, { type: "leaf", terminalId: id });
      consumed.add(id);
    }
  }
  return root;
}

function sanitizePaneNode(
  node: WorkspacePaneNode,
  available: Set<string>,
  consumed: Set<string>,
  depth: number,
): WorkspacePaneNode | null {
  if (depth > 64) return null;
  if (node.type === "leaf") {
    if (!available.has(node.terminalId) || consumed.has(node.terminalId)) {
      return null;
    }
    consumed.add(node.terminalId);
    return { type: "leaf", terminalId: node.terminalId };
  }

  const first = sanitizePaneNode(node.first, available, consumed, depth + 1);
  const second = sanitizePaneNode(node.second, available, consumed, depth + 1);
  if (first && second) {
    return {
      type: "split",
      direction:
        node.direction === "vertical" || node.direction === "horizontal"
          ? node.direction
          : "horizontal",
      ratio: normalizeSplitRatio(node.ratio),
      first,
      second,
    };
  }
  return first ?? second;
}

function normalizeSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.95, Math.max(0.05, ratio));
}

// Even grid in row-major order, like tmux's tiled layout: ceil(sqrt(n))
// columns, as many rows as needed, rows of equal height and panes of equal
// width within a row. A short last row spans the full width, so three panes
// are two on top and one below; four are quadrants.
export function tileGrid(ids: string[]): WorkspacePaneNode | null {
  if (ids.length === 0) return null;
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: WorkspacePaneNode[] = [];
  for (let start = 0; start < ids.length; start += cols) {
    rows.push(
      evenChain(
        ids.slice(start, start + cols).map((terminalId) => ({
          type: "leaf" as const,
          terminalId,
        })),
        "horizontal",
      ),
    );
  }
  return evenChain(rows, "vertical");
}

// Chain where every node gets 1/n: the outermost split takes 1/n, the next
// 1/(n-1) of what remains, … innermost 1/2.
function evenChain(
  nodes: WorkspacePaneNode[],
  direction: WorkspaceSplitDirection,
): WorkspacePaneNode {
  const [first, ...rest] = nodes;
  if (rest.length === 0) return first;
  return {
    type: "split",
    direction,
    ratio: normalizeSplitRatio(1 / nodes.length),
    first,
    second: evenChain(rest, direction),
  };
}

export interface WorkspacePaneFlatRect {
  terminalId: string;
  /// Fractions of the workspace area, 0..1.
  left: number;
  top: number;
  width: number;
  height: number;
}

/// Flatten the layout tree into absolutely-positionable pane rects. This
/// exists so the workspace can render every pane as a KEYED SIBLING in one
/// relative container instead of a recursive div tree: layout changes
/// (rotate, close, split, zoom) then only move rects around and React never
/// unmounts a pane's xterm instance for a structural reason.
///
/// `stackVertically` mirrors the touch rendering rule: every split renders
/// as a column regardless of its persisted direction (side-by-side panes
/// are unreadably narrow on touch widths).
export function flattenWorkspacePanes(
  root: WorkspacePaneNode | null,
  options: { stackVertically?: boolean } = {},
): WorkspacePaneFlatRect[] {
  if (!root) return [];
  const stack = options.stackVertically === true;
  const collect = (
    node: WorkspacePaneNode,
    rect: { left: number; top: number; width: number; height: number },
  ): WorkspacePaneFlatRect[] => {
    if (node.type === "leaf") {
      return [{ terminalId: node.terminalId, ...rect }];
    }
    if (!stack && node.direction === "horizontal") {
      const firstWidth = rect.width * node.ratio;
      return [
        ...collect(node.first, { ...rect, width: firstWidth }),
        ...collect(node.second, {
          ...rect,
          left: rect.left + firstWidth,
          width: rect.width - firstWidth,
        }),
      ];
    }
    const firstHeight = rect.height * node.ratio;
    return [
      ...collect(node.first, { ...rect, height: firstHeight }),
      ...collect(node.second, {
        ...rect,
        top: rect.top + firstHeight,
        height: rect.height - firstHeight,
      }),
    ];
  };
  return collect(root, { left: 0, top: 0, width: 1, height: 1 });
}

function collectPaneRects(root: WorkspacePaneNode, rect: PaneRect): PaneRect[] {
  if (root.type === "leaf") {
    return [{ ...rect, terminalId: root.terminalId }];
  }
  if (root.direction === "horizontal") {
    const firstWidth = rect.width * root.ratio;
    return [
      ...collectPaneRects(root.first, { ...rect, width: firstWidth }),
      ...collectPaneRects(root.second, {
        ...rect,
        x: rect.x + firstWidth,
        width: rect.width - firstWidth,
      }),
    ];
  }
  const firstHeight = rect.height * root.ratio;
  return [
    ...collectPaneRects(root.first, { ...rect, height: firstHeight }),
    ...collectPaneRects(root.second, {
      ...rect,
      y: rect.y + firstHeight,
      height: rect.height - firstHeight,
    }),
  ];
}

function rangesOverlap(a: PaneRect, b: PaneRect, axis: "x" | "y"): boolean {
  const aStart = axis === "x" ? a.x : a.y;
  const aEnd = aStart + (axis === "x" ? a.width : a.height);
  const bStart = axis === "x" ? b.x : b.y;
  const bEnd = bStart + (axis === "x" ? b.width : b.height);
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0.0001;
}

function edgeDistance(
  active: PaneRect,
  pane: PaneRect,
  direction: WorkspacePaneFocusDirection,
): number {
  switch (direction) {
    case "left":
      return Math.max(0, active.x - (pane.x + pane.width));
    case "right":
      return Math.max(0, pane.x - (active.x + active.width));
    case "up":
      return Math.max(0, active.y - (pane.y + pane.height));
    case "down":
      return Math.max(0, pane.y - (active.y + active.height));
  }
}

function centerDistance(
  active: PaneRect,
  pane: PaneRect,
  direction: WorkspacePaneFocusDirection,
): number {
  if (direction === "left" || direction === "right") {
    return Math.abs(active.x + active.width / 2 - (pane.x + pane.width / 2));
  }
  return Math.abs(active.y + active.height / 2 - (pane.y + pane.height / 2));
}

function perpendicularDistance(
  active: PaneRect,
  pane: PaneRect,
  direction: WorkspacePaneFocusDirection,
): number {
  if (direction === "left" || direction === "right") {
    return Math.abs(active.y + active.height / 2 - (pane.y + pane.height / 2));
  }
  return Math.abs(active.x + active.width / 2 - (pane.x + pane.width / 2));
}

function splitNode(
  root: WorkspacePaneNode | null,
  activeTerminalId: string,
  inserted: WorkspacePaneNode,
  direction: WorkspaceSplitDirection,
): WorkspacePaneNode | null {
  if (!root) return inserted;
  if (root.type === "leaf") {
    if (root.terminalId !== activeTerminalId) return root;
    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: root,
      second: inserted,
    };
  }
  return {
    ...root,
    first:
      splitNode(root.first, activeTerminalId, inserted, direction) ??
      root.first,
    second:
      splitNode(root.second, activeTerminalId, inserted, direction) ??
      root.second,
  };
}

function removeNode(
  root: WorkspacePaneNode | null,
  terminalId: string,
): WorkspacePaneNode | null {
  return removeNodeWithFallback(root, terminalId).root;
}

function swapLeafTerminalIds(
  root: WorkspacePaneNode,
  sourceTerminalId: string,
  targetTerminalId: string,
): WorkspacePaneNode {
  if (root.type === "leaf") {
    if (root.terminalId === sourceTerminalId) {
      return { ...root, terminalId: targetTerminalId };
    }
    if (root.terminalId === targetTerminalId) {
      return { ...root, terminalId: sourceTerminalId };
    }
    return root;
  }
  return {
    ...root,
    first: swapLeafTerminalIds(root.first, sourceTerminalId, targetTerminalId),
    second: swapLeafTerminalIds(root.second, sourceTerminalId, targetTerminalId),
  };
}

function rotateSplitDirections(node: WorkspacePaneNode): WorkspacePaneNode {
  if (node.type === "leaf") return node;
  return {
    ...node,
    direction: node.direction === "horizontal" ? "vertical" : "horizontal",
    first: rotateSplitDirections(node.first),
    second: rotateSplitDirections(node.second),
  };
}

function removeNodeWithFallback(
  root: WorkspacePaneNode | null,
  terminalId: string,
): RemoveResult {
  if (!root) return { root: null, fallbackTerminalId: null, removed: false };
  if (root.type === "leaf") {
    return root.terminalId === terminalId
      ? { root: null, fallbackTerminalId: null, removed: true }
      : { root, fallbackTerminalId: null, removed: false };
  }
  const first = removeNodeWithFallback(root.first, terminalId);
  const second = removeNodeWithFallback(root.second, terminalId);
  if (!first.removed && !second.removed) {
    return { root, fallbackTerminalId: null, removed: false };
  }
  if (!first.root) {
    return {
      root: second.root,
      fallbackTerminalId:
        first.fallbackTerminalId ?? firstTerminalId(second.root),
      removed: true,
    };
  }
  if (!second.root) {
    return {
      root: first.root,
      fallbackTerminalId:
        second.fallbackTerminalId ?? firstTerminalId(first.root),
      removed: true,
    };
  }
  return {
    root: { ...root, first: first.root, second: second.root },
    fallbackTerminalId:
      first.removed ? first.fallbackTerminalId : second.fallbackTerminalId,
    removed: true,
  };
}

function appendNode(
  root: WorkspacePaneNode | null,
  inserted: WorkspacePaneNode,
): WorkspacePaneNode {
  if (!root) return inserted;
  // Re-tile instead of nesting: wrapping the whole root in a 50/50 split
  // shrank every earlier pane to 1/2, 1/4, 1/8…
  return (
    tileGrid([
      ...collectPaneTerminalIds(root),
      ...collectPaneTerminalIds(inserted),
    ]) ?? inserted
  );
}

function firstTerminalId(root: WorkspacePaneNode | null): string | null {
  return collectPaneTerminalIds(root)[0] ?? null;
}

function paneExists(
  terminals: TerminalInfo[],
  browsers: AgentBrowserInfo[],
  id: string,
): boolean {
  return (
    terminals.some((terminal) => terminal.id === id) ||
    browsers.some((browser) => browser.id === id)
  );
}

// A home directory is "~", not the user's login name: a terminal called
// "zourenyuan" in a tab called "zourenyuan" reads as the same thing twice, and nobody thinks of their home directory by that name.
const HOME_DIRECTORY = /^\/(?:Users|home)\/[^/]+\/?$|^\/root\/?$/;

export function labelFromCwd(cwd: string): string {
  const cleaned = cwd.replace(/\/+$/, "");
  if (HOME_DIRECTORY.test(cleaned)) return "~";
  const tail = cleaned.split("/").filter(Boolean).at(-1);
  return tail || cwd || "tab";
}
