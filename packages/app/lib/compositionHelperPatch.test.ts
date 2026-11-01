import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

import {
  patchCompositionHelperSendRace,
  type XtermCompositionHelper,
} from "./compositionHelperPatch";

interface Harness {
  helper: XtermCompositionHelper;
  textarea: { value: string };
  sent: string[];
  /** Android-style 229 commit: xterm's keydown handler calls
   * _handleAnyTextareaChanges (snapshot), then the IME inserts text. */
  commit229(text: string): void;
  /** xterm clears the hidden textarea itself (Enter / Ctrl+C / blur / paste). */
  clearTextarea(): void;
  /** Composition commit through compositionstart + sync finalize. */
  commitComposition(text: string): void;
}

function makeHarness(): Harness {
  const textarea = { value: "" };
  const sent: string[] = [];
  const helper = {
    _isComposing: false,
    _compositionPosition: { start: 0, end: 0 },
    _compositionSuffix: "",
    _isSendingComposition: false,
    _dataAlreadySent: "",
    _textareaChangeTimer: undefined,
    _textarea: textarea,
    _compositionView: { classList: { remove: vi.fn() } },
    _coreService: {
      triggerDataEvent: (data: string) => {
        sent.push(data);
      },
    },
    // Originals are stubs: only the patched behavior is under test.
    compositionstart: vi.fn(function (this: XtermCompositionHelper) {
      helper._isComposing = true;
      helper._compositionPosition.start = textarea.value.length;
    }),
    _finalizeComposition: vi.fn(),
    _handleAnyTextareaChanges: vi.fn(),
  } as unknown as XtermCompositionHelper;

  const term = { _core: { _compositionHelper: helper }, options: {} } as unknown as Terminal;
  patchCompositionHelperSendRace(term);

  return {
    helper,
    textarea,
    sent,
    commit229(text) {
      helper._handleAnyTextareaChanges();
      textarea.value += text;
      vi.advanceTimersByTime(1);
    },
    clearTextarea() {
      textarea.value = "";
    },
    commitComposition(text) {
      helper.compositionstart();
      textarea.value += text;
      helper._compositionPosition.end = textarea.value.length;
      helper._finalizeComposition(false);
    },
  };
}

describe("patchCompositionHelperSendRace watermark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The patch uses window.setTimeout and sniffs navigator for the Apple
    // path; the vitest env is node, so provide a non-Apple browser shape.
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id),
    });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends a 229 commit made after Enter cleared the textarea", () => {
    const h = makeHarness();
    h.commit229("ls -la");
    h.clearTextarea(); // Enter keydown: xterm sets textarea.value = ""
    h.commit229("你好世界");
    h.commit229("吗");
    expect(h.sent).toEqual(["ls -la", "你好世界", "吗"]);
  });

  it("sends a 229 commit made after a blur-style clear", () => {
    const h = makeHarness();
    h.commit229("hello");
    h.clearTextarea(); // _handleTextAreaBlur
    h.commit229("你好世界");
    expect(h.sent).toEqual(["hello", "你好世界"]);
  });

  it("sends a 229 commit after a composition commit followed by an Enter clear", () => {
    const h = makeHarness();
    h.commitComposition("你好");
    h.clearTextarea();
    h.commit229("吗啊");
    expect(h.sent).toEqual(["你好", "吗啊"]);
  });

  it("still emits repeated text and later appends without a clear", () => {
    const h = makeHarness();
    h.commit229("测");
    h.commit229("测");
    expect(h.sent).toEqual(["测", "测"]);
  });

  it("does not re-emit text a sync finalize already sent while a 229 timer was pending (#5023)", () => {
    const h = makeHarness();
    h.helper._handleAnyTextareaChanges(); // 229 snapshot, old value ""
    h.commitComposition("你好"); // compositionend emits synchronously
    vi.advanceTimersByTime(1); // starved 229 diff timer finally fires
    expect(h.sent).toEqual(["你好"]);
  });

  it("does not re-emit text a deferred finalize sent while a 229 timer was pending (#5023)", () => {
    const h = makeHarness();
    h.helper._handleAnyTextareaChanges(); // 229 snapshot, old value ""
    h.helper.compositionstart();
    h.textarea.value = "你好";
    h.helper._compositionPosition.end = 2;
    h.helper._isComposing = false;
    h.helper._finalizeComposition(true); // deferred send
    vi.advanceTimersByTime(1);
    expect(h.sent).toEqual(["你好"]);
  });

  it("does not lower the watermark when a second 229 snapshot is scheduled over still-present emitted text", () => {
    const h = makeHarness();
    h.commitComposition("你好"); // watermark 2, textarea still "你好"
    h.helper._handleAnyTextareaChanges(); // old "你好"
    // Stale timer scenario: value unchanged, nothing may be sent.
    vi.advanceTimersByTime(1);
    expect(h.sent).toEqual(["你好"]);
  });
});
