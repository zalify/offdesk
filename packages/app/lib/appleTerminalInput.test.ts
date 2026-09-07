import { describe, expect, it } from "vitest";
import { terminalTailEdit } from "./appleTerminalInput";
const atEnd = (value: string) => ({ value, start: value.length, end: value.length });

describe("Apple terminal tail edits", () => {
  it("preserves punctuation, repeated words and dictated paragraphs", () => {
    for (const text of ["，", "。！？；：、", " ", "测试测试，整段语音 English 🦊"]) {
      expect(terminalTailEdit(atEnd("已有"), atEnd("已有" + text))).toBe(text);
    }
  });
  it("replaces a double-space suffix without resending the prefix", () => {
    expect(terminalTailEdit(atEnd("你好 "), atEnd("你好。"))).toBe("\x7f。");
    expect(terminalTailEdit(atEnd("你好 "), atEnd("你好"))).toBe("\x7f");
    expect(terminalTailEdit(atEnd("你好"), atEnd("你好。"))).toBe("。");
  });
  it("uses one deletion for a supplementary Unicode character", () => {
    expect(terminalTailEdit(atEnd("abc🦊"), atEnd("abc！"))).toBe("\x7f！");
  });
  it("does not map an arbitrary middle edit to terminal deletion", () => {
    expect(terminalTailEdit({ value: "abc", start: 1, end: 1 }, { value: "a，bc", start: 2, end: 2 })).toBeNull();
  });
});
