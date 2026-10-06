import type { AgentBrowserInfo, TerminalInfo } from "@offdesk/shared";

import {
  workspacePaneOrder,
  type WorkspaceGroup,
} from "./terminalWorkspaceLayout";

/** One row of the mobile session switcher: a terminal or an agent browser. */
export type MobileSessionPane =
  | { kind: "terminal"; id: string; terminal: TerminalInfo; group: WorkspaceGroup }
  | { kind: "browser"; id: string; browser: AgentBrowserInfo; group: WorkspaceGroup };

export interface MobileSessionGroup {
  group: WorkspaceGroup;
  panes: MobileSessionPane[];
}

/**
 * Sessions per tab, in workspace order. `groups` is the same tab derivation
 * the desktop uses (`createTerminalWorkspace`), so an agent browser sits in
 * its opener terminal's tab, or alone in a tab of its own.
 */
export function buildMobileSessionGroups(
  groups: WorkspaceGroup[],
  terminals: TerminalInfo[],
  browsers: AgentBrowserInfo[] = [],
): MobileSessionGroup[] {
  const terminalsById = new Map(
    terminals.map((terminal) => [terminal.id, terminal]),
  );
  const browsersById = new Map(browsers.map((browser) => [browser.id, browser]));

  return groups.flatMap((group) => {
    const panes = workspacePaneOrder(group.root).flatMap(
      (id): MobileSessionPane[] => {
        const terminal = terminalsById.get(id);
        if (terminal) return [{ kind: "terminal", id, terminal, group }];
        const browser = browsersById.get(id);
        if (browser) return [{ kind: "browser", id, browser, group }];
        return [];
      },
    );
    return panes.length > 0 ? [{ group, panes }] : [];
  });
}
