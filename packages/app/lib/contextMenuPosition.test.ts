import { describe, expect, it } from "vitest";
import { computeSubmenuPosition } from "./contextMenuPosition";

describe("computeSubmenuPosition", () => {
  const viewport = { width: 1000, height: 600 };

  it("opens to the right and aligned to anchor top when there is plenty of room", () => {
    const pos = computeSubmenuPosition(
      { left: 200, right: 380, top: 100, bottom: 132 },
      { width: 180, height: 120 },
      viewport,
    );
    expect(pos).toEqual({ left: 376, top: 96, maxHeight: 584 });
  });

  it("flips to the left when opening right would overflow the viewport", () => {
    const pos = computeSubmenuPosition(
      { left: 760, right: 940, top: 100, bottom: 132 },
      { width: 180, height: 120 },
      viewport,
    );
    expect(pos.left).toBe(584);
    expect(pos.top).toBe(96);
  });

  it("shifts upward so a bottom-edge submenu stays completely inside the viewport", () => {
    const pos = computeSubmenuPosition(
      { left: 200, right: 380, top: 520, bottom: 552 },
      { width: 180, height: 240 },
      viewport,
    );
    expect(pos.left).toBe(376);
    expect(pos.top).toBe(352); // 600 - 240 - 8
    expect(pos.top + 240).toBeLessThanOrEqual(viewport.height - 8);
  });

  it("caps maxHeight and pins to top margin when submenu is taller than viewport", () => {
    const pos = computeSubmenuPosition(
      { left: 200, right: 380, top: 400, bottom: 432 },
      { width: 180, height: 900 },
      viewport,
    );
    expect(pos.top).toBe(8);
    expect(pos.maxHeight).toBe(584);
  });

  it("clamps horizontally inside narrow viewports where neither side fits completely", () => {
    // More space on left (80px) than right (60px) -> clamps to left margin.
    const leftSide = computeSubmenuPosition(
      { left: 80, right: 240, top: 100, bottom: 132 },
      { width: 220, height: 100 },
      { width: 300, height: 600 },
    );
    expect(leftSide.left).toBe(8);

    // More space on right (100px) than left (40px) -> clamps to right margin.
    const rightSide = computeSubmenuPosition(
      { left: 40, right: 200, top: 100, bottom: 132 },
      { width: 220, height: 100 },
      { width: 300, height: 600 },
    );
    expect(rightSide.left).toBe(72); // 300 - 220 - 8
  });
});
