import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBAR_LAYOUT, sanitizeKeyBarLayout } from "./keyBarPreferences";

describe("terminal key preferences", () => {
  it("recovers malformed settings while allowing deliberately empty rows", () => {
    for (const value of [null, 1, {}, { primary: [], secondary: "invalid" }]) expect(sanitizeKeyBarLayout(value)).toEqual(DEFAULT_KEYBAR_LAYOUT);
    expect(sanitizeKeyBarLayout({ primary: [], secondary: [] })).toEqual({ primary: [], secondary: [] });
  });
  it("rejects unknown, duplicate and fixed keys, caps the first row, and preserves order", () => {
    expect(sanitizeKeyBarLayout({ primary: ["ctrl-c", "esc", "esc", "constructor", "enter", "tab", "shift-tab", "slash", "home"],
      secondary: ["tab", "home", "shift", "backspace", "keyboard", "up", "<script>"] })).toEqual({
      primary: ["ctrl-c", "esc", "tab", "shift-tab", "slash"], secondary: ["home", "shift", "backspace"],
    });
  });
});
