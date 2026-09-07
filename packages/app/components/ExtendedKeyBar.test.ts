import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExtendedKeyBar } from "./ExtendedKeyBar";

const baseProps = {
  onKey: () => {},
  onToggleKeyboard: () => {},
  keyboardVisible: false,
  isController: true,
};

describe("ExtendedKeyBar", () => {
  it("renders Ctrl+C as a pinned button so it can't scroll out of view", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).toContain('data-testid="extended-keybar-ctrl-c"');
    expect(html).toContain("Ctrl+C");
  });

  it("hides the attach button when onAttachFile is not provided", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).not.toContain('data-testid="extended-keybar-attach"');
    expect(html).toContain('data-testid="extended-keybar-file-input" disabled=""');
  });

  it("renders an attach button + image-only file input when onAttachFile is provided", () => {
    const html = renderToStaticMarkup(
      createElement(ExtendedKeyBar, {
        ...baseProps,
        onAttachFile: () => {},
      }),
    );
    expect(html).toContain('data-testid="extended-keybar-attach"');
    expect(html).toContain('data-testid="extended-keybar-file-input"');
    expect(html).toContain('accept="image/*"');
  });

  it("disables key buttons when not in control", () => {
    const html = renderToStaticMarkup(
      createElement(ExtendedKeyBar, { ...baseProps, isController: false }),
    );
    // Pinned ^C still renders but is disabled.
    expect(html).toContain('data-testid="extended-keybar-ctrl-c"');
    expect(html).toContain('disabled="" data-testid="extended-keybar-keyboard"');
  });

  it("hides the select toggle when select-mode callbacks are missing", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).not.toContain('data-testid="extended-keybar-select-toggle"');
  });

  it("renders the select toggle when all select-mode callbacks are provided", () => {
    const html = renderToStaticMarkup(
      createElement(ExtendedKeyBar, {
        ...baseProps,
        onEnterSelectMode: () => {},
        onExitSelectMode: () => {},
        onCopySelection: () => null,
      }),
    );
    expect(html).toContain('data-testid="extended-keybar-select-toggle"');
  });

  it("morphs into the slim Done/hint/Copy bar while selectMode is true", () => {
    const html = renderToStaticMarkup(
      createElement(ExtendedKeyBar, {
        ...baseProps,
        onEnterSelectMode: () => {},
        onExitSelectMode: () => {},
        onCopySelection: () => null,
        selectMode: true,
      }),
    );
    expect(html).toContain('data-testid="extended-keybar-select-mode"');
    expect(html).toContain('data-testid="extended-keybar-select-done"');
    expect(html).toContain('data-testid="extended-keybar-copy"');
    expect(html).toContain("Drag on the terminal to select text");
    // Default-mode buttons should be gone.
    expect(html).not.toContain('data-testid="extended-keybar-ctrl-c"');
    expect(html).not.toContain('data-testid="extended-keybar-attach"');
  });

  it("keeps Space in the scrolling tools for TUI toggles", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).toContain('data-testid="extended-keybar-space"');
    expect(html).toContain(">Space<");
  });

  it("renders Enter in the pinned row so commands can be submitted without the soft keyboard", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).toContain('data-testid="extended-keybar-enter"');
    expect(html).toContain("Enter");
  });

  it("keeps Tab pinned and removes Shift+Tab", () => {
    const html = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(html).toContain('data-testid="extended-keybar-tab"');
    expect(html).not.toContain('data-testid="extended-keybar-shift-tab"');
    expect(html).toContain(">Tab<");
  });

  it("renders the Ctrl latch key only when onToggleCtrl is provided", () => {
    const without = renderToStaticMarkup(createElement(ExtendedKeyBar, baseProps));
    expect(without).not.toContain('data-testid="extended-keybar-ctrl-latch"');

    const withLatch = renderToStaticMarkup(
      createElement(ExtendedKeyBar, {
        ...baseProps,
        ctrlArmed: true,
        onToggleCtrl: () => {},
      }),
    );
    expect(withLatch).toContain('data-testid="extended-keybar-ctrl-latch"');
    expect(withLatch).toContain('aria-pressed="true"');
  });
});
