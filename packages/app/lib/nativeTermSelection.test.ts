import { describe, expect, it } from "vitest";
import {
  createSelection,
  detectScrollShift,
  extractSelectionText,
  getVisibleSelectionRanges,
  syncSelectionWithFrame,
  updateSelectionEnd,
  type NativeTermFrameLike,
} from "./nativeTermSelection";

function makeFrame(
  lines: string[],
  opts?: {
    cols?: number;
    display_offset?: number;
    history_size?: number;
    wrapped_rows?: boolean[];
  },
): NativeTermFrameLike {
  const cols = opts?.cols ?? 40;
  return {
    cols,
    rows: lines.length,
    spans: lines.map((line) => (line ? [{ c: 0, t: line }] : [])),
    display_offset: opts?.display_offset ?? 0,
    history_size: opts?.history_size,
    wrapped_rows: opts?.wrapped_rows,
  };
}

describe("detectScrollShift", () => {
  it("detects full-screen upward and downward scroll", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")}`);
    const f0 = doc.slice(20, 30);
    const fUp3 = doc.slice(17, 27);
    const fDown4 = doc.slice(24, 34);

    expect(detectScrollShift(f0, fUp3)).toEqual({ shift: 3, band: { top: 0, bottom: 9 } });
    expect(detectScrollShift(f0, fDown4)).toEqual({ shift: -4, band: { top: 0, bottom: 9 } });
  });

  it("detects scroll inside a TUI with a fixed footer (e.g. Claude Code)", () => {
    const conv = Array.from({ length: 30 }, (_, i) => `msg ${i}: hello world`);
    const footer = ["────────────────────", "> type a message", "status: idle"];
    const f0 = [...conv.slice(15, 25), ...footer];
    const fUp3 = [...conv.slice(12, 22), ...footer];
    const fDown2 = [...conv.slice(17, 27), ...footer];

    expect(detectScrollShift(f0, fUp3)).toEqual({ shift: 3, band: { top: 0, bottom: 9 } });
    expect(detectScrollShift(f0, fDown2)).toEqual({ shift: -2, band: { top: 0, bottom: 9 } });
  });

  it("detects scroll inside a TUI with both fixed header and changing status footer", () => {
    const header = ["=== Header Bar ==="];
    const body = Array.from({ length: 30 }, (_, i) => `row-${i} content`);
    const f0 = [...header, ...body.slice(10, 20), "pos: 50%"];
    const fUp2 = [...header, ...body.slice(8, 18), "pos: 40%"];

    expect(detectScrollShift(f0, fUp2)).toEqual({ shift: 2, band: { top: 1, bottom: 10 } });
  });

  it("returns 0 for identical frames (e.g. hitting top of scrollback)", () => {
    const f = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    expect(detectScrollShift(f, [...f])).toEqual({ shift: 0, band: null });
  });

  it("returns 0 for in-place 1-2 line updates (typing/spinner)", () => {
    const f0 = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const f1 = [...f0];
    f1[11] = "line 11 updated";
    expect(detectScrollShift(f0, f1)).toEqual({ shift: 0, band: null });
  });

  it("returns 0 for completely unrelated screens (clear / tab switch)", () => {
    const f0 = Array.from({ length: 12 }, (_, i) => `screen A line ${i}`);
    const f1 = Array.from({ length: 12 }, (_, i) => `screen B line ${i}`);
    expect(detectScrollShift(f0, f1)).toEqual({ shift: 0, band: null });
  });

  it("does not false-positive on repeated identical lines", () => {
    const f0 = ["---", "---", "---", "---", "---", "---", "prompt a", "status 1"];
    const f1 = ["---", "---", "---", "---", "---", "---", "prompt b", "status 2"];
    expect(detectScrollShift(f0, f1)).toEqual({ shift: 0, band: null });
  });

  it("uses preferredDirection to break ties on periodic alternating lines", () => {
    const f0 = ["alpha", "beta", "alpha", "beta", "alpha", "beta", "alpha", "beta"];
    const f1 = ["beta", "alpha", "beta", "alpha", "beta", "alpha", "beta", "alpha"];
    expect(detectScrollShift(f0, f1, 1).shift).toBe(1);
    expect(detectScrollShift(f0, f1, -1).shift).toBe(-1);
  });
});

describe("nativeTermSelection (local scrollback)", () => {
  it("keeps selection anchored to content when scrolling up past viewport height", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}: payload`);
    // Viewport shows doc[30..39] (history_size=30, display_offset=0)
    const f0 = makeFrame(doc.slice(30, 40), { display_offset: 0, history_size: 30 });
    // Start dragging at vis row 5 ("L35: payload"), col 5 ("payload")
    let sel = createSelection(f0, { col: 5, row: 5 });

    // Scroll UP 5 lines -> viewport shows doc[25..34] (display_offset=5)
    // "L35" is now off-screen at visRow 10!
    const f1 = makeFrame(doc.slice(25, 35), { display_offset: 5, history_size: 30 });
    sel = syncSelectionWithFrame(sel, f1, { dragging: true, pointerCell: { col: 0, row: 2 } });

    // Highlight should cover vis rows 2..9 (anchor is below viewport at visRow 10)
    const vis1 = getVisibleSelectionRanges(sel, 40, 10);
    expect(vis1).toHaveLength(8);
    expect(vis1[0]).toEqual({ row: 2, startCol: 0, endCol: 40 });
    expect(vis1[7]).toEqual({ row: 9, startCol: 0, endCol: 40 });

    // Scroll UP 10 more lines -> viewport shows doc[15..24] (display_offset=15)
    const f2 = makeFrame(doc.slice(15, 25), { display_offset: 15, history_size: 30 });
    sel = syncSelectionWithFrame(sel, f2, { dragging: true, pointerCell: { col: 4, row: 5 } });

    // Selected range is doc[20] col 4 through doc[35] col 5
    const text = extractSelectionText(sel);
    const lines = text.split("\n");
    expect(lines[0]).toBe(" payload"); // doc[20].slice(4) -> " payload" ("L20: payload")
    expect(lines[1]).toBe("L21: payload");
    expect(lines[lines.length - 2]).toBe("L34: payload");
    expect(lines[lines.length - 1]).toBe("L35:"); // doc[35].slice(0, 5) trimmed -> "L35:"
    expect(lines).toHaveLength(16);
  });

  it("moves existing selection upward when new output prints at the bottom", () => {
    const doc = Array.from({ length: 20 }, (_, i) => `out ${i}`);
    const f0 = makeFrame(doc.slice(5, 15), { display_offset: 0, history_size: 5 });
    let sel = createSelection(f0, { col: 0, row: 6 }, { col: 6, row: 6 }); // "out 11"

    // 3 new lines print -> history_size becomes 8, display_offset stays 0
    const f1 = makeFrame(doc.slice(8, 18), { display_offset: 0, history_size: 8 });
    sel = syncSelectionWithFrame(sel, f1, { dragging: false });

    // "out 11" moved from vis row 6 to vis row 3
    expect(getVisibleSelectionRanges(sel, 40, 10)).toEqual([{ row: 3, startCol: 0, endCol: 6 }]);
    expect(extractSelectionText(sel)).toBe("out 11");
  });

  it("preserves selection after mouseup when scrolling away and back", () => {
    const doc = Array.from({ length: 30 }, (_, i) => `item-${i}`);
    const f0 = makeFrame(doc.slice(20, 30), { display_offset: 0, history_size: 20 });
    let sel = createSelection(f0, { col: 0, row: 2 }, { col: 7, row: 4 }); // item-22..item-24

    // Scroll up 15 lines -> selection is completely off-screen below viewport
    const f1 = makeFrame(doc.slice(5, 15), { display_offset: 15, history_size: 20 });
    sel = syncSelectionWithFrame(sel, f1, { dragging: false });
    expect(getVisibleSelectionRanges(sel, 40, 10)).toEqual([]);
    expect(extractSelectionText(sel)).toBe("item-22\nitem-23\nitem-24");

    // Scroll back down 15 lines -> highlight reappears at rows 2..4
    sel = syncSelectionWithFrame(sel, f0, { dragging: false });
    expect(getVisibleSelectionRanges(sel, 40, 10)).toEqual([
      { row: 2, startCol: 0, endCol: 40 },
      { row: 3, startCol: 0, endCol: 40 },
      { row: 4, startCol: 0, endCol: 7 },
    ]);
  });
});

describe("nativeTermSelection (remote-scrolled pty-daemon & TUI)", () => {
  it("stitches multi-screen selection across remote wheel scroll frames (display_offset always 0)", () => {
    const doc = Array.from({ length: 50 }, (_, i) => `remote line ${i}`);
    // Initial remote viewport: doc[35..44] (10 rows, display_offset=0, history_size=0)
    const f0 = makeFrame(doc.slice(35, 45), { display_offset: 0, history_size: 0 });
    // Anchor at row 6 ("remote line 41"), col 14 (end of line)
    let sel = createSelection(f0, { col: 14, row: 6 });

    // Simulate 5 incremental wheel-up frames of 4 lines each (total 20 lines up -> doc[15..24])
    for (let step = 1; step <= 5; step++) {
      const top = 35 - step * 4;
      const fn = makeFrame(doc.slice(top, top + 10), { display_offset: 0, history_size: 0 });
      sel = syncSelectionWithFrame(sel, fn, { dragging: true, pointerCell: { col: 0, row: 2 } });
    }

    // Now viewport is doc[15..24]; pointer at row 2 is doc[17] ("remote line 17")
    const copied = extractSelectionText(sel);
    const expected = doc.slice(17, 42).join("\n");
    expect(copied).toBe(expected);
  });

  it("handles TUI with fixed footer without corrupting scrolled-off lines", () => {
    const conv = Array.from({ length: 40 }, (_, i) => `claude msg ${i}`);
    const footer = ["────────────────────", "> prompt", "ready"];

    const f0 = makeFrame([...conv.slice(25, 35), ...footer], {
      display_offset: 0,
      history_size: 0,
    });
    // Start selecting at row 8 ("claude msg 33"), col 13
    let sel = createSelection(f0, { col: 13, row: 8 });

    // Scroll UP 3 lines at a time, 4 times (12 lines up -> conv[13..22] + footer)
    for (let step = 1; step <= 4; step++) {
      const top = 25 - step * 3;
      const fn = makeFrame([...conv.slice(top, top + 10), ...footer], {
        display_offset: 0,
        history_size: 0,
      });
      sel = syncSelectionWithFrame(sel, fn, { dragging: true, pointerCell: { col: 0, row: 1 } });
    }

    // Highlight must NOT bleed into fixed footer rows (10..12)
    const vis = getVisibleSelectionRanges(sel, 40, 13);
    expect(vis.every((r) => r.row <= 9)).toBe(true);

    // Copied text must contain conv[14..33] with zero footer contamination!
    const copied = extractSelectionText(sel);
    expect(copied).toBe(conv.slice(14, 34).join("\n"));
    expect(copied).not.toContain("prompt");
    expect(copied).not.toContain("────");
  });

  it("handles wide CJK characters, soft-wrapped lines, and rectangular selection", () => {
    const f0 = makeFrame(["中文测试123456", "wrapped-continuation", "third line"], {
      cols: 12,
      display_offset: 0,
      history_size: 0,
      wrapped_rows: [true, false, false],
    });

    // Normal selection spanning soft-wrapped row 0 -> row 1
    let sel = createSelection(f0, { col: 0, row: 0 });
    sel = updateSelectionEnd(sel, { col: 7, row: 1 });
    expect(extractSelectionText(sel)).toBe("中文测试1234wrapped");

    // Rectangular selection (Option+Drag) cols 4..8 across rows 0..2
    const rectSel = createSelection(f0, { col: 4, row: 0 }, { col: 8, row: 2 }, true);
    expect(extractSelectionText(rectSel)).toBe("测试\nped-\nd li");
  });

  it("returns empty string for zero-width click selection", () => {
    const f0 = makeFrame(["hello world"], { cols: 20 });
    const sel = createSelection(f0, { col: 3, row: 0 });
    expect(extractSelectionText(sel)).toBe("");
  });

  it("handles reversing scroll direction past the original anchor", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `row ${String(i).padStart(2, "0")}`);
    const f0 = makeFrame(doc.slice(20, 30), { display_offset: 0, history_size: 0 });
    // Anchor at row 5 ("row 25"), col 0
    let sel = createSelection(f0, { col: 0, row: 5 });

    // Scroll UP 4 lines -> doc[16..25]
    const fUp = makeFrame(doc.slice(16, 26), { display_offset: 0, history_size: 0 });
    sel = syncSelectionWithFrame(sel, fUp, { dragging: true, pointerCell: { col: 0, row: 2 } });

    // Scroll DOWN 4 lines back to doc[20..29], then 4 more to doc[24..33]
    sel = syncSelectionWithFrame(sel, f0, { dragging: true, pointerCell: { col: 6, row: 7 } });
    const fDown = makeFrame(doc.slice(24, 34), { display_offset: 0, history_size: 0 });
    sel = syncSelectionWithFrame(sel, fDown, { dragging: true, pointerCell: { col: 6, row: 7 } });

    // Anchor "row 25" is now at vis row 1; pointer at vis row 7 is "row 31"
    expect(extractSelectionText(sel)).toBe(doc.slice(25, 32).join("\n"));
  });

  it("clamps pointer dragged into a TUI fixed footer to the scroll band bottom", () => {
    const conv = Array.from({ length: 30 }, (_, i) => `msg ${i}`);
    const footer = ["────────", "> input", "status"];
    const f0 = makeFrame([...conv.slice(10, 20), ...footer], {
      display_offset: 0,
      history_size: 0,
    });
    // Start at row 2 ("msg 12"), col 0
    let sel = createSelection(f0, { col: 0, row: 2 });

    // Scroll DOWN 4 lines -> conv[14..23] + footer; pointer dragged below into footer row 12
    const f1 = makeFrame([...conv.slice(14, 24), ...footer], {
      display_offset: 0,
      history_size: 0,
    });
    sel = syncSelectionWithFrame(sel, f1, { dragging: true, pointerCell: { col: 3, row: 12 } });

    // Should select msg 12 through msg 23 cleanly without blank lines or footer text
    expect(extractSelectionText(sel)).toBe(conv.slice(12, 24).join("\n"));
  });

  it("preserves rectangular selection columns when pointer clamps to scrollBand edge", () => {
    const conv = Array.from({ length: 30 }, (_, i) => `row-${String(i).padStart(2, "0")}-abcdef`);
    const footer = ["────────", "> input", "status"];
    const f0 = makeFrame([...conv.slice(10, 20), ...footer], {
      display_offset: 0,
      history_size: 0,
    });
    // Option+Drag rectangular selection starting at col 4, row 2 ("12-abc")
    let sel = createSelection(f0, { col: 4, row: 2 }, { col: 4, row: 2 }, true);

    // Scroll DOWN 3 lines -> conv[13..22] + footer; pointer dragged into footer at col 9, row 11
    const f1 = makeFrame([...conv.slice(13, 23), ...footer], {
      display_offset: 0,
      history_size: 0,
    });
    sel = syncSelectionWithFrame(sel, f1, { dragging: true, pointerCell: { col: 9, row: 11 } });

    // Column must remain 4..9 (NOT snap to 4..40) and row clamps to scrollBand.bottom (9 -> docRow 12)
    expect(sel.end.col).toBe(9);
    const copiedLines = extractSelectionText(sel).split("\n");
    expect(copiedLines).toHaveLength(11); // conv[12..22]
    expect(copiedLines[0]).toBe("12-ab");
    expect(copiedLines[copiedLines.length - 1]).toBe("22-ab");
  });

  it("does not teleport selection when history_size drops (e.g. alt-screen or clear scrollback)", () => {
    const f0 = makeFrame(
      Array.from({ length: 10 }, (_, i) => `primary ${i}`),
      { display_offset: 0, history_size: 500 },
    );
    let sel = createSelection(f0, { col: 0, row: 2 }, { col: 9, row: 4 });

    // Entering alt-screen or \x1b[3J drops history_size from 500 to 0 with unrelated content
    const fAlt = makeFrame(
      Array.from({ length: 10 }, (_, i) => `altscreen ${i}`),
      { display_offset: 0, history_size: 0 },
    );
    sel = syncSelectionWithFrame(sel, fAlt, { dragging: false });

    // viewportTopDocRow must NOT jump by -500
    expect(sel.viewportTopDocRow).toBe(0);
  });
});
