import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONT_FAMILY, resolveTerminalFontFamily } from "./terminalFonts";

describe("terminalFonts", () => {
  it("uses one bundled default regardless of locally installed fonts", () => {
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toBe("'Iosevka Term', monospace");
    for (const value of [null, undefined, "", "  ", "Iosevka Term"]) {
      expect(resolveTerminalFontFamily(value)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    }
  });
  it("preserves a custom preference with the bundled default as fallback", () => {
    expect(resolveTerminalFontFamily("JetBrains Mono")).toBe("'JetBrains Mono', 'Iosevka Term', monospace");
    expect(resolveTerminalFontFamily("Not Installed")).toBe("'Not Installed', 'Iosevka Term', monospace");
  });
});
