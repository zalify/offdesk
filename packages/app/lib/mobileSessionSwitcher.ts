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
