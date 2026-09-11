import { describe, expect, it } from "vitest";
import { shiftKeyTransform } from "./shiftKey";

describe("terminal Shift encoding", () => {
  it("sends reverse Tab and modified cursor sequences", () => {
    expect(shiftKeyTransform("\t")).toBe("\x1b[Z");
    for (const direction of ["A", "B", "C", "D"]) {
      expect(shiftKeyTransform(`\x1b[${direction}`)).toBe(`\x1b[1;2${direction}`);
      expect(shiftKeyTransform(`\x1bO${direction}`)).toBe(`\x1b[1;2${direction}`);
      expect(shiftKeyTransform(`\x1b[${direction}`, true)).toBe(`\x1b[1;6${direction}`);
    }
  });
  it("shifts individual ASCII keys without corrupting IME commits or existing escapes", () => {
    expect(shiftKeyTransform("a")).toBe("A");
    expect(shiftKeyTransform("/")).toBe("?");
    expect(shiftKeyTransform("-")).toBe("_");
    expect(shiftKeyTransform("[")).toBe("{");
    for (const value of ["", "abc", "中文？", "\x7f", "\r", "\x03", "\x1b[Z", "\x1b[1;5A", "\x1b[200~paste\x1b[201~"]) {
      expect(shiftKeyTransform(value)).toBe(value);
    }
  });
});
