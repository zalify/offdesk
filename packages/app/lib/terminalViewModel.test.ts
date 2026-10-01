import { describe, expect, it } from "vitest";

import {
  getTerminalFitResizeDecision,
  isSizedElsewhere,
} from "./terminalViewModel";

describe("getTerminalFitResizeDecision", () => {
  it("suppresses only the remote resize frame when auto-fit dimensions are unchanged", () => {
    expect(
      getTerminalFitResizeDecision({
        currentCols: 52,
        currentRows: 27,
        nextCols: 52,
        nextRows: 27,
        skipIfUnchanged: true,
      }),
    ).toEqual({
      sendResizeFrame: false,
      refreshLocalSurface: true,
    });
  });
});

describe("isSizedElsewhere", () => {
  it("does not flag a narrow-but-correctly-fitted terminal", () => {
    // 26×52 in a ~225px pane is what actually fits there — the 80×24
    // estimate floor must not make this a false positive.
    expect(isSizedElsewhere(26, 52, 225, 884)).toBe(false);
  });

  it("flags a terminal far smaller than the pane", () => {
    expect(isSizedElsewhere(26, 52, 1000, 884)).toBe(true);
  });
});
