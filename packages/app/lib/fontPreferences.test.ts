import { describe, expect, it } from "vitest";
import { resolveUiFontFamily } from "./fontPreferences";

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
