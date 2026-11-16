import type { TerminalInfo } from "@offdesk/shared";

import {
  workspacePaneOrder,
  type WorkspaceGroup,
} from "./terminalWorkspaceLayout";

export interface MobileSessionPane {
  terminal: TerminalInfo;
  group: WorkspaceGroup;
}

export interface MobileSessionGroup {
  group: WorkspaceGroup;
  panes: MobileSessionPane[];
}

export function buildMobileSessionGroups(
  groups: WorkspaceGroup[],
  terminals: TerminalInfo[],
): MobileSessionGroup[] {
  const terminalsById = new Map(
    terminals.map((terminal) => [terminal.id, terminal]),
  );

  return groups.flatMap((group) => {
    const panes = workspacePaneOrder(group.root)
      .flatMap((terminalId) => {
        const terminal = terminalsById.get(terminalId);
        return terminal ? [terminal] : [];
      })
      .map((terminal) => ({ terminal, group }));
    return panes.length > 0 ? [{ group, panes }] : [];
  });
}

/**
 * Every pane of the sheet as one flat list, the latest output first (the
 * desktop sidebar's "recent" order). Terminals whose node hasn't reported
 * activity go last, still in tab order.
 */
export function recentMobileSessionPanes(
  sessionGroups: MobileSessionGroup[],
): MobileSessionPane[] {
  const at = (pane: MobileSessionPane) =>
    pane.terminal.last_activity_ms ?? -Infinity;
  // Array.prototype.sort is stable, so ties keep the tab order.
  return sessionGroups
    .flatMap((sessionGroup) => sessionGroup.panes)
    .sort((a, b) => at(b) - at(a));
}
