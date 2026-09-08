import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONT_FAMILY, resolveTerminalFontFamily } from "./terminalFonts";

describe("terminalFonts", () => {
  it("uses a fixed bundled default regardless of locally installed fonts", () => {
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toBe("'JetBrains Mono', 'Offdesk Terminal Symbols', monospace");
    for (const value of [null, undefined, "", "  ", "JetBrains Mono"]) {
      expect(resolveTerminalFontFamily(value)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    }
  });
  it("preserves a custom preference with the bundled default as fallback", () => {
    expect(resolveTerminalFontFamily("Custom Mono")).toBe("'Custom Mono', 'JetBrains Mono', 'Offdesk Terminal Symbols', monospace");
    expect(resolveTerminalFontFamily("Not Installed")).toBe("'Not Installed', 'JetBrains Mono', 'Offdesk Terminal Symbols', monospace");
  });
});
