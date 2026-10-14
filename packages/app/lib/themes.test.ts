import { describe, expect, it } from "vitest";
// @ts-ignore Vitest runs this in Node; the app tsconfig omits Node types (CI has none, local installs may).
import { readFileSync } from "node:fs";
import {
  THEME_IDS, THEMES, contrastRatio, hexToTriplet, parseSystemThemes, parseTheme, resolveThemeId,
  terminalMinimumContrast, themeCssVariables,
} from "./themes";

describe("every theme is legible without glare", () => {
  for (const id of THEME_IDS) {
    const { ui, terminal } = THEMES[id];
    it(id, () => {
      const text = contrastRatio(ui.fg0, ui.bg0);
      // Comfortable reading: well above WCAG AAA, but short of white on black.
      expect(text).toBeGreaterThanOrEqual(7);
      expect(text).toBeLessThanOrEqual(18);
      for (const muted of [ui.fg1, ui.fg2]) expect(contrastRatio(muted, ui.bg0)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.fg3, ui.bg0)).toBeGreaterThanOrEqual(3.5);
      // Accent and warn are also text colours (links, "!", "waiting for you").
      expect(contrastRatio(ui.accent, ui.bg0)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.warn, ui.bg0)).toBeGreaterThanOrEqual(4.5);
      // Text on the fills: "in control", ^C, "waiting".
      expect(contrastRatio(ui.onPrimary, ui.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.onAccent, ui.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.onErr, ui.warn)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(terminal.foreground, terminal.background)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(terminal.cursor, terminal.background)).toBeGreaterThanOrEqual(3);
      for (const name of ["red", "green", "yellow", "blue", "magenta", "cyan", "white",
        "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
        expect(contrastRatio(terminal[name], terminal.background), name).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(terminal.brightBlack, terminal.background)).toBeGreaterThanOrEqual(2.5);
    });
  }

  it("lifts pale program colours only on light terminals", () => {
    expect(terminalMinimumContrast(THEMES.graphite)).toBe(1);
    expect(terminalMinimumContrast(THEMES.paper)).toBe(1);
    expect(terminalMinimumContrast(THEMES.sepia)).toBe(3);
    expect(terminalMinimumContrast(THEMES.sage)).toBe(3);
  });
});

describe("global.css paints Paper and Graphite before the app loads", () => {
  // ?raw yields no text for CSS under Vitest, so read the file itself.
  const css: string = readFileSync(decodeURIComponent(new URL("../global.css", import.meta.url).pathname), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf("\n  }", start));
  };
  const declared = (text: string) => Object.fromEntries(
    [...text.matchAll(/(--color-[a-z0-9-]+):\s*([0-9]+ [0-9]+ [0-9]+);/g)].map((m) => [m[1], m[2]]),
  );
  it("matches lib/themes.ts", () => {
    const light = declared(block(":root"));
    const dark = { ...light, ...declared(block(":root.dark")) };
    expect(light).toEqual(expect.objectContaining(themeCssVariables(THEMES.paper)));
    expect(dark).toEqual(expect.objectContaining(themeCssVariables(THEMES.graphite)));
    expect(hexToTriplet("#c6e26a")).toBe("198 226 106");
  });
});

describe("the saved choice", () => {
  it("keeps the meaning of the old light and dark settings", () => {
    expect(parseTheme("light")).toBe("paper");
    expect(parseTheme("dark")).toBe("graphite");
    expect(parseTheme("sepia")).toBe("sepia");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("neon")).toBe("system");
  });
  it("follows the system with a pair of themes", () => {
    const pair = parseSystemThemes(JSON.stringify({ light: "sage", dark: "ember" }));
    expect(pair).toEqual({ light: "sage", dark: "ember" });
    expect(resolveThemeId("system", "dark", pair)).toBe("ember");
    expect(resolveThemeId("system", "light", pair)).toBe("sage");
    expect(resolveThemeId("slate", "light", pair)).toBe("slate");
    expect(parseSystemThemes("not json")).toEqual({ light: "paper", dark: "graphite" });
    expect(parseSystemThemes(JSON.stringify({ light: "graphite?" }))).toEqual({ light: "paper", dark: "graphite" });
  });
});
