import { describe, expect, it } from "vitest";
import { BUNDLED_TERMINAL_FONTS, isFontInstalled } from "./terminalFonts";

// A fake device: each installed font has its own width; anything else falls
// back to the generic family named after it.
const device = (installed: Record<string, number>) => (font: string) => {
  const generic = { monospace: 600, serif: 520, "sans-serif": 560 } as Record<string, number>;
  const [first, fallback] = font.split(", ").map((part) => part.replace(/^'|'$/g, ""));
  if (fallback === undefined) return generic[first];
  return installed[first] ?? generic[fallback];
};

describe("terminal fonts", () => {
  it("offers a system font only where the device draws it", () => {
    const mac = device({ Menlo: 602 });
    expect(isFontInstalled("Menlo", mac)).toBe(true);
    expect(isFontInstalled("Consolas", mac)).toBe(false);
    // A font that happens to match one generic still differs from the others.
    expect(isFontInstalled("Courier New", device({ "Courier New": 600 }))).toBe(true);
    expect(isFontInstalled("Menlo", null)).toBe(false);
  });

  it("ships its own fonts, so those are on every device", () => {
    expect(BUNDLED_TERMINAL_FONTS).toEqual(["JetBrains Mono", "Geist Mono", "Fira Code", "IBM Plex Mono", "Source Code Pro"]);
  });
});
