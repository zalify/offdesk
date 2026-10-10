import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  findPathsAcrossRows,
  findPathsInLine,
  lineTextWithColumns,
  parseFileUri,
  parsePathLinkUri,
  pathLinkUri,
  readTerminalRow,
  remotePathFromLink,
  resolveRemotePath,
} from "./remoteFileLinks";
import type { TerminalRow } from "./remoteFileLinks";

const paths = (line: string) => findPathsInLine(line).map((m) => m.path);

describe("parseFileUri", () => {
  it("ignores the host and decodes the path", () => {
    expect(parseFileUri("file://box/tmp/report.pdf")).toBe("/tmp/report.pdf");
    expect(parseFileUri("file:///tmp/a.txt")).toBe("/tmp/a.txt");
  });
  it("decodes spaces and unicode", () => {
    expect(parseFileUri("file://h/tmp/my%20file.txt")).toBe("/tmp/my file.txt");
    expect(parseFileUri("file://h/tmp/%E6%8A%A5%E5%91%8A.pdf")).toBe("/tmp/报告.pdf");
  });
  it("drops query and fragment, rejects bad input", () => {
    expect(parseFileUri("file://h/tmp/a.txt#frag")).toBe("/tmp/a.txt");
    expect(parseFileUri("file://h/tmp/%zz")).toBeNull();
    expect(parseFileUri("https://h/tmp/a")).toBeNull();
    expect(parseFileUri("file://h")).toBeNull();
  });
});

describe("path link uri", () => {
  it("round-trips", () => {
    expect(parsePathLinkUri(pathLinkUri("/a b/c%d"))).toEqual({ path: "/a b/c%d" });
    expect(parsePathLinkUri("https://x")).toBeNull();
  });
  it("carries a fallback", () => {
    expect(parsePathLinkUri(pathLinkUri("/a b/cd", "/a b/c"))).toEqual({
      path: "/a b/cd",
      fallback: "/a b/c",
    });
    expect(remotePathFromLink(pathLinkUri("/x/yz", "/x/y"))?.fallback).toBe("/x/y");
    expect(remotePathFromLink("file://h/tmp/a")).toEqual({ path: "/tmp/a" });
  });
});

describe("findPathsInLine", () => {
  it("matches absolute, home and relative paths", () => {
    expect(paths("see /var/log/syslog now")).toEqual(["/var/log/syslog"]);
    expect(paths("cat ~/notes/todo.md")).toEqual(["~/notes/todo.md"]);
    expect(paths("run ./build/out.bin and ../x/y")).toEqual(["./build/out.bin", "../x/y"]);
    expect(paths("./a.sh")).toEqual(["./a.sh"]);
  });
  it("does not match inside URLs", () => {
    expect(paths("https://example.com/a/b/c")).toEqual([]);
    expect(paths("see http://localhost:3000/a/b")).toEqual([]);
    expect(paths("git@github.com:org/repo/x")).toEqual([]);
  });
  it("does not match fragments of words or single-segment absolutes", () => {
    expect(paths("and/or a/b/c 1/2")).toEqual([]);
    expect(paths("/etc")).toEqual([]);
    expect(paths("a // b")).toEqual([]);
  });
  it("strips trailing punctuation and line suffixes", () => {
    expect(paths("open /tmp/a/b.txt.")).toEqual(["/tmp/a/b.txt"]);
    expect(paths("(see /tmp/a/b.txt)")).toEqual(["/tmp/a/b.txt"]);
    expect(paths("/tmp/a/b.txt, /tmp/c/d.txt:")).toEqual(["/tmp/a/b.txt", "/tmp/c/d.txt"]);
    expect(paths("error at ./src/a.ts:12:3")).toEqual(["./src/a.ts"]);
    expect(paths('"/tmp/a/b"')).toEqual(["/tmp/a/b"]);
  });
  it("reports ranges", () => {
    const [m] = findPathsInLine("x /tmp/a/b y");
    expect(m).toEqual({ start: 2, end: 10, path: "/tmp/a/b" });
  });
  it("handles unicode names and trailing slash", () => {
    expect(paths("ls /home/me/文档/报告.pdf")).toEqual(["/home/me/文档/报告.pdf"]);
    expect(paths("cd /usr/local/")).toEqual(["/usr/local/"]);
  });
  it("matches after = and quotes", () => {
    expect(paths("--out=/tmp/x/y.txt")).toEqual(["/tmp/x/y.txt"]);
  });
});

// A `cols`-wide screen of ASCII rows; `wrapped` lists the rows the terminal
// soft-wrapped onto.
const screen =
  (cols: number, lines: string[], wrapped: number[] = []) =>
  (row: number): TerminalRow | undefined => {
    const line = lines[row];
    if (line === undefined) return undefined;
    if (line.length > cols) throw new Error(`row ${row} is wider than ${cols}`);
    const text = line.padEnd(cols);
    return {
      text,
      columns: [...text].map((_, i) => i),
      full: line.length === cols && line[cols - 1] !== " ",
      wrapped: wrapped.includes(row),
    };
  };

describe("findPathsAcrossRows", () => {
  // As Claude Code printed it on a 50-column phone screen.
  const claude = screen(50, [
    "● All the files are in /Users/zourenyuan/workspace",
    "  s/Zalify/Eng/output/app-listing-2026-10/final/.",
    "  These are the six to upload:",
    "",
    "  /Users/zourenyuan/workspaces/Zalify/Eng/output/a",
    "  pp-listing-2026-10/final/feature.png",
  ]);

  it("joins a path an app broke at the right edge, from either row", () => {
    const joined = {
      path: "/Users/zourenyuan/workspaces/Zalify/Eng/output/app-listing-2026-10/final/",
      start: { row: 0, column: 23 },
      end: { row: 1, column: 47 },
      fallback: "/Users/zourenyuan/workspace",
    };
    expect(findPathsAcrossRows(claude, 0)).toEqual([joined]);
    expect(findPathsAcrossRows(claude, 1)).toEqual([joined]);
    expect(findPathsAcrossRows(claude, 2)).toEqual([]);
    expect(findPathsAcrossRows(claude, 5)).toEqual([
      {
        path: "/Users/zourenyuan/workspaces/Zalify/Eng/output/app-listing-2026-10/final/feature.png",
        start: { row: 4, column: 2 },
        end: { row: 5, column: 37 },
        fallback: "/Users/zourenyuan/workspaces/Zalify/Eng/output/a",
      },
    ]);
  });

  it("follows a path over three rows", () => {
    const rows = screen(12, ["  /tmp/aaaaa", "  bbbbb/cccc", "  c.txt"]);
    expect(findPathsAcrossRows(rows, 1).map((m) => m.path)).toEqual([
      "/tmp/aaaaabbbbb/ccccc.txt",
    ]);
    expect(findPathsAcrossRows(rows, 2)[0].start).toEqual({ row: 0, column: 2 });
  });

  it("joins soft-wrapped rows as they are", () => {
    const rows = screen(10, ["ls /tmp/ab", "c/d.txt"], [1]);
    expect(findPathsAcrossRows(rows, 1).map((m) => m.path)).toEqual(["/tmp/abc/d.txt"]);
  });

  it("leaves rows that stop short of the edge alone", () => {
    const rows = screen(30, ["  see /tmp/a/b.txt", "  and more"]);
    expect(findPathsAcrossRows(rows, 0)).toEqual([
      { path: "/tmp/a/b.txt", start: { row: 0, column: 6 }, end: { row: 0, column: 17 } },
    ]);
  });

  it("does not join words or URLs that reach the edge", () => {
    const url = screen(28, ["  go https://example.com/a/b", "  c/d/e"]);
    expect(findPathsAcrossRows(url, 0)).toEqual([]);
    expect(findPathsAcrossRows(url, 1)).toEqual([]);
    const prose = screen(29, ["  the report is in the folder", "  /tmp/out/report.pdf"]);
    expect(findPathsAcrossRows(prose, 0)).toEqual([]);
    expect(findPathsAcrossRows(prose, 1).map((m) => m.path)).toEqual(["/tmp/out/report.pdf"]);
  });

  it("keeps the first-row part of a path that only touches the edge", () => {
    const rows = screen(20, ["  edited /tmp/a/b.ts", "  and ran the tests"]);
    const [match] = findPathsAcrossRows(rows, 0);
    expect(match.path).toBe("/tmp/a/b.tsand");
    expect(match.fallback).toBe("/tmp/a/b.ts");
  });

  it("reads rows of a real terminal that narrowed", async () => {
    // How the phone sees it: tmux on the alternate screen, drawn wide, then
    // the terminal narrows and the app redraws for the new width.
    const term = new Terminal({ cols: 80, rows: 5, scrollback: 0, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((done) => term.write(data, done));
    await write(`\x1b[?1049h${" ".repeat(56)}see /tmp/e2e-wrap/hard-w\r\n  rapped-path-file.txt`);
    term.resize(46, 5);
    await write(`\x1b[H\x1b[J${" ".repeat(22)}see /tmp/e2e-wrap/hard-w\x1b[2;1H  rapped-path-file.txt`);
    const buffer = term.buffer.active;
    const rows = (row: number) => {
      const line = buffer.getLine(row);
      return line && readTerminalRow(line, term.cols);
    };
    expect(buffer.getLine(0)!.length).toBe(80);
    for (const row of [0, 1]) {
      expect(findPathsAcrossRows(rows, row).map((m) => m.path)).toEqual([
        "/tmp/e2e-wrap/hard-wrapped-path-file.txt",
      ]);
    }
    term.dispose();
  });

  it("returns only the paths on the asked row", () => {
    const rows = screen(20, ["x /tmp/a/b", "y /tmp/c/d"]);
    expect(findPathsAcrossRows(rows, 1).map((m) => m.path)).toEqual(["/tmp/c/d"]);
    expect(findPathsAcrossRows(rows, 7)).toEqual([]);
  });
});

describe("resolveRemotePath", () => {
  it("resolves relative paths against cwd", () => {
    expect(resolveRemotePath("./a/b.txt", "/work/repo")).toBe("/work/repo/a/b.txt");
    expect(resolveRemotePath("../x.txt", "/work/repo")).toBe("/work/x.txt");
    expect(resolveRemotePath("../../../x", "/a")).toBe("/x");
  });
  it("passes absolute and home paths through", () => {
    expect(resolveRemotePath("/a/./b//c", null)).toBe("/a/b/c");
    expect(resolveRemotePath("~/a", "/w")).toBe("~/a");
  });
  it("returns null for relative with no cwd", () => {
    expect(resolveRemotePath("./a", null)).toBeNull();
  });
});

describe("lineTextWithColumns", () => {
  it("maps indices to columns across wide chars", () => {
    const cells = [
      { c: "报", w: 2 },
      { c: "", w: 0 },
      { c: "/", w: 1 },
      { c: "a", w: 1 },
    ];
    const line = {
      length: cells.length,
      getCell: (x: number) => ({ getChars: () => cells[x].c, getWidth: () => cells[x].w }),
    };
    const { text, columns, full } = lineTextWithColumns(line);
    expect(text).toBe("报/a");
    expect(columns).toEqual([0, 2, 3]);
    expect(full).toBe(true);
  });
  it("says whether the text runs into the last column", () => {
    const line = (cells: { c: string; w: number }[]) => ({
      length: cells.length,
      getCell: (x: number) => ({ getChars: () => cells[x].c, getWidth: () => cells[x].w }),
    });
    expect(lineTextWithColumns(line([{ c: "a", w: 1 }, { c: "", w: 1 }])).full).toBe(false);
    expect(lineTextWithColumns(line([{ c: "a", w: 1 }, { c: " ", w: 1 }])).full).toBe(false);
    expect(lineTextWithColumns(line([{ c: "报", w: 2 }, { c: "", w: 0 }])).full).toBe(true);
  });
});
