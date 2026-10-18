import { describe, expect, it } from "vitest";
import { resolveUiFontFamily, uiRootFontSize } from "./fontPreferences";
import { rem } from "./rem";

describe("UI font families", () => {
  it("restores the app's separate display and body defaults when cleared", () => {
    expect(resolveUiFontFamily(null)).toBeNull();
    expect(resolveUiFontFamily("  ")).toBeNull();
  });
  it("uses the generic system family without quoting it as a font name", () => {
    expect(resolveUiFontFamily("System UI")).toBe("system-ui, -apple-system, sans-serif");
  });
  it("escapes custom names as one family instead of accepting injected CSS", () => {
    expect(resolveUiFontFamily(" John's Font ")).toBe("'John\\'s Font', system-ui, sans-serif");
    expect(resolveUiFontFamily("Font, serif")).toBe("'Font, serif', system-ui, sans-serif");
  });
});

describe("Interface text size", () => {
  it("keeps the browser's root size at the default and out of range", () => {
    for (const size of [0, 9, 14, 21, NaN]) expect(uiRootFontSize(size)).toBe("");
  });
  it("scales the root so rem sizes follow the setting", () => {
    expect(uiRootFontSize(20)).toBe("142.8571%");
    expect(uiRootFontSize(12)).toBe("85.7143%");
    // rem(13) is 13px at the default and 13 * 20 / 14 px at 20.
    expect(parseFloat(rem(13)) * 16).toBe(13);
    expect(parseFloat(rem(13)) * 16 * (parseFloat(uiRootFontSize(20)) / 100)).toBeCloseTo((13 * 20) / 14, 2);
  });
});
