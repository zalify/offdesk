import { describe, expect, it } from "vitest";
import {
  findPathsInLine,
  lineTextWithColumns,
  parseFileUri,
  parsePathLinkUri,
  pathLinkUri,
  resolveRemotePath,
} from "./remoteFileLinks";

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
    expect(parsePathLinkUri(pathLinkUri("/a b/c%d"))).toBe("/a b/c%d");
    expect(parsePathLinkUri("https://x")).toBeNull();
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
    const { text, columns } = lineTextWithColumns(line);
    expect(text).toBe("报/a");
    expect(columns).toEqual([0, 2, 3]);
  });
});
