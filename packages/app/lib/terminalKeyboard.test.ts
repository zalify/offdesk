import { describe, expect, it } from "vitest";
import { createKeyboardViewportTracker } from "./terminalKeyboard";
const viewport = (height: number, width = 390, scale = 1) => ({ height, width, scale });
describe("OS keyboard dismissal", () => {
  it("detects the IME closing while the terminal keeps DOM focus", () => {
    const observe = createKeyboardViewportTracker(viewport(800));
    expect(observe(viewport(500), true)).toBe(false);
    expect(observe(viewport(650), true)).toBe(false);
    expect(observe(viewport(800), true)).toBe(true);
    expect(observe(viewport(800), true)).toBe(false);
    expect(observe(viewport(500), true)).toBe(false);
    expect(observe(viewport(800), true)).toBe(true);
  });
  it("does not mistake address-bar changes or an unfocused resize for a keyboard", () => {
    const observe = createKeyboardViewportTracker(viewport(800));
    expect(observe(viewport(730), true)).toBe(false);
    expect(observe(viewport(800), true)).toBe(false);
    expect(observe(viewport(500), false)).toBe(false);
    expect(observe(viewport(800), false)).toBe(false);
  });
  it("resets across rotation, split-screen width changes and zoom", () => {
    const observe = createKeyboardViewportTracker(viewport(800));
    expect(observe(viewport(500), true)).toBe(false);
    expect(observe(viewport(390, 800), true)).toBe(false);
    expect(observe(viewport(800, 390), true)).toBe(false);
    expect(observe(viewport(400, 195, 2), true)).toBe(false);
    expect(observe(viewport(800, 390, 1), true)).toBe(false);
  });
});
