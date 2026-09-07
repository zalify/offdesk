import { describe, it, expect } from "vitest";
import { bulkKeypressText } from "./terminalBulkKey";

const keypress = (key: string, overrides = {}) => ({ type: "keypress", key, charCode: key.charCodeAt(0), ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...overrides });

describe("bulk text keypress", () => {
  it("preserves paragraphs, repeated text, newlines and surrogate pairs", () => {
    for (const text of ["这是一段完整输入，测试测试。", "English paragraph", "line one\nline two", "🦊", "一".repeat(10000)]) {
      expect(bulkKeypressText(keypress(text))).toBe(text);
    }
  });
  it("leaves ordinary keys, shortcuts and uncommitted IME input to xterm", () => {
    for (const event of [
      keypress("中"), keypress("a"), keypress("Enter", { charCode: 13 }),
      keypress("Unidentified", { charCode: 229 }), keypress("Dead", { charCode: 0 }),
      keypress("整段文字", { type: "keydown" }), keypress("整段文字", { isComposing: true }),
      keypress("整段文字", { ctrlKey: true }), keypress("整段文字", { altKey: true }), keypress("整段文字", { metaKey: true }),
    ]) expect(bulkKeypressText(event)).toBeNull();
  });
});
