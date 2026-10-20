import { describe, expect, it } from "vitest";
import {
  pickWorkspaceTerminal,
  type WorkspaceGroup,
} from "./terminalWorkspaceLayout";

const term = (id: string, machine_id: string) => ({ id, machine_id });
const tab = (id: string, terminalId: string): WorkspaceGroup => ({
  id,
  label: id,
  cwd: "/",
  workspaceGroupId: id,
  persistent: true,
  root: { type: "leaf", terminalId } as WorkspaceGroup["root"],
  paneCount: 1,
  layoutUpdatedAt: null,
});

describe("pickWorkspaceTerminal", () => {
  const b = [term("b1", "B"), term("b0", "B")];
  const tabs = [tab("t0", "b0"), tab("t1", "b1")];

  it("opens the first tab when the zoomed terminal is on another machine", () => {
    expect(pickWorkspaceTerminal(term("a1", "A"), "B", tabs, b)?.id).toBe("b0");
  });

  it("keeps the zoomed terminal on the same machine", () => {
    expect(pickWorkspaceTerminal(b[0], "B", tabs, b)?.id).toBe("b1");
  });

  it("falls back to any terminal, then null", () => {
    expect(pickWorkspaceTerminal(null, "B", [], b)?.id).toBe("b1");
    expect(pickWorkspaceTerminal(null, "B", [], [])).toBeNull();
  });
});
