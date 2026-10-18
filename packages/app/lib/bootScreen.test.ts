import { describe, expect, it } from "vitest";
import { BOOT_TIPS, drawTwo, pickBootTips } from "./bootScreen";

describe("boot screen tips", () => {
  it("draws two different items across the whole range of random values", () => {
    const items = ["a", "b", "c", "d"];
    for (const r1 of [0, 0.3, 0.6, 0.999]) {
      for (const r2 of [0, 0.5, 0.999]) {
        const values = [r1, r2];
        const [first, second] = drawTwo(items, () => values.shift()!);
        expect(items).toContain(first);
        expect(items).toContain(second);
        expect(second).not.toBe(first);
      }
    }
  });

  it("keeps the same two tips for the whole page load", () => {
    const first = pickBootTips();
    expect(pickBootTips(() => 0.999)).toBe(first);
    expect(BOOT_TIPS).toContain(first[0]);
    expect(BOOT_TIPS).toContain(first[1]);
  });

  it("keeps every tip short enough for the card", () => {
    for (const tip of BOOT_TIPS) expect(tip.length).toBeLessThanOrEqual(90);
  });
});
