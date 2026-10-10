import { describe, expect, it } from "vitest";

import {
  mergeWrappedRows,
  trimTrailingBlankLines,
  type RawRow,
} from "./terminalSelection";

const row = (text: string, isWrapped = false): RawRow => ({ text, isWrapped });

describe("mergeWrappedRows", () => {
  it("returns plain rows untouched when nothing is wrapped", () => {
    expect(
      mergeWrappedRows([row("hello"), row("world"), row("")]),
    ).toEqual(["hello", "world", ""]);
  });

  it("joins a soft-wrapped continuation into the previous row", () => {
    expect(
      mergeWrappedRows([
        row("Work is done — PR #176 merged, container"),
        row(" deployed, service responding, memories", true),
        row(" saved. Nothing left to poll. Ending the", true),
        row(" loop.", true),
      ]),
    ).toEqual([
      "Work is done — PR #176 merged, container deployed, service responding, memories saved. Nothing left to poll. Ending the loop.",
    ]);
  });

  it("keeps real newlines between non-wrapped rows", () => {
    expect(
      mergeWrappedRows([
        row("$ ls"),
        row("file-a"),
        row("file-with-a-name-that-wrapped-onto-two-rows"),
        row("-and-here-is-the-rest", true),
        row("$"),
      ]),
    ).toEqual([
      "$ ls",
      "file-a",
      "file-with-a-name-that-wrapped-onto-two-rows-and-here-is-the-rest",
      "$",
    ]);
  });

  it("does not crash when the first row is marked wrapped", () => {
    // Defensive: terminals shouldn't emit this, but if isWrapped is true on
    // row 0 (e.g. viewport starts mid-wrap), treat it as a fresh logical
    // line rather than blowing up.
    expect(mergeWrappedRows([row("orphan continuation", true)])).toEqual([
      "orphan continuation",
    ]);
  });
});

describe("mergeWrappedRows with the terminal width", () => {
  const COLS = 50;
  const rows = (...lines: string[]) =>
    lines.map((text) => {
      if (text.length > COLS) throw new Error(`wider than ${COLS}: ${text}`);
      return row(text);
    });

  it("undoes the breaks Claude Code makes in prose and in a command", () => {
    // As it printed them on a 50-column phone screen.
    expect(
      mergeWrappedRows(
        rows(
          "  - The environment: the run script loads the app",
          "    web service's production variables from Render",
          "    (database, Reach and Postmark keys, app URL)",
          "    and never prints or saves them.",
          "",
          "  To run it yourself, type this in the prompt. It",
          "  takes about 3-5 minutes, and the output lands in",
          "  this conversation:",
          "",
          "  ! SP=/private/tmp/claude-501/-Users-zourenyuan-w",
          "  orkspaces-Zalify-Eng/3dd50db1-d139-4660-9e56-e26",
          "  7c2ea1399/scratchpad; cd",
          "  /Users/zourenyuan/workspaces/Zalify/Eng/app.zali",
          "  fy.com/.claude/worktrees/segment-builder &&",
          "  python3 $SP/app_prod_env.py -- pnpm tsx",
          "  src/server/scripts/pregenerate-ses-domains.ts",
          "  --input $SP/postmark_domains_30d_v2.tsv",
          "  --execute --report $SP/ses_move_report.json 2>&1",
          "  | tail -25",
          "",
          "✻ Cooked for 33s",
        ),
        COLS,
      ),
    ).toEqual([
      "  - The environment: the run script loads the app web service's production variables from Render (database, Reach and Postmark keys, app URL) and never prints or saves them.",
      "",
      "  To run it yourself, type this in the prompt. It takes about 3-5 minutes, and the output lands in this conversation:",
      "",
      "  ! SP=/private/tmp/claude-501/-Users-zourenyuan-workspaces-Zalify-Eng/3dd50db1-d139-4660-9e56-e267c2ea1399/scratchpad; cd /Users/zourenyuan/workspaces/Zalify/Eng/app.zalify.com/.claude/worktrees/segment-builder && python3 $SP/app_prod_env.py -- pnpm tsx src/server/scripts/pregenerate-ses-domains.ts --input $SP/postmark_domains_30d_v2.tsv --execute --report $SP/ses_move_report.json 2>&1 | tail -25",
      "",
      "✻ Cooked for 33s",
    ]);
  });

  it("keeps real line breaks", () => {
    expect(
      mergeWrappedRows(
        rows(
          "  Done.",
          "  Next, the report.",
          "  - one item",
          "  - another item",
          "    with more",
          "./a",
          "./a/path/longer/than/what/was/left/on/row/above",
        ),
        COLS,
      ),
    ).toEqual([
      "  Done.",
      "  Next, the report.",
      "  - one item",
      "  - another item",
      "    with more",
      "./a",
      "./a/path/longer/than/what/was/left/on/row/above",
    ]);
  });

  it("joins after the item marker's indent", () => {
    expect(
      mergeWrappedRows(
        rows("● The report is in /Users/zourenyuan/workspace", "  s/Zalify/Eng/report.json"),
        46,
      ),
    ).toEqual(["● The report is in /Users/zourenyuan/workspaces/Zalify/Eng/report.json"]);
    expect(
      mergeWrappedRows(rows("  ⎿  Read 3 files from the directory that was", "     given"), 46),
    ).toEqual(["  ⎿  Read 3 files from the directory that was given"]);
  });

  it("measures wide characters by their columns", () => {
    // 2 + 4×2 = 10 columns: the row is full, and the halves of the broken
    // word are longer than a row together.
    const full: RawRow = { text: "  中文中文", isWrapped: false, columns: [0, 1, 2, 4, 6, 8], width: 10 };
    const rest: RawRow = { text: "  测试", isWrapped: false, columns: [0, 1, 2, 4], width: 6 };
    expect(mergeWrappedRows([full, rest], 10)).toEqual(["  中文中文测试"]);
  });

  it("leaves rows alone without the width", () => {
    expect(mergeWrappedRows(rows("  takes about 3-5 minutes, and the output lands in", "  this"))).toEqual([
      "  takes about 3-5 minutes, and the output lands in",
      "  this",
    ]);
  });
});

describe("trimTrailingBlankLines", () => {
  it("removes empty trailing rows", () => {
    expect(trimTrailingBlankLines(["a", "b", "", ""])).toEqual(["a", "b"]);
  });

  it("removes trailing whitespace-only rows", () => {
    expect(trimTrailingBlankLines(["a", "   ", ""])).toEqual(["a"]);
  });

  it("keeps blanks in the middle", () => {
    expect(trimTrailingBlankLines(["a", "", "b"])).toEqual(["a", "", "b"]);
  });
});
