import { describe, expect, it } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import {
  classifyListError,
  filterEntries,
  formatEntrySize,
  formatRelativeTime,
  isTooLarge,
  parentPath,
  rememberDirectory,
  resolveStartPath,
  sortEntries,
  splitBreadcrumb,
} from "./fileBrowser";
import { ApiError } from "./api";

const e = (name: string, is_dir: boolean, size?: number): DirEntry => ({
  name,
  path: `/x/${name}`,
  is_dir,
  size,
});

describe("sortEntries", () => {
  it("puts directories first and sorts case-insensitively", () => {
    const sorted = sortEntries([e("b.txt", false), e("Zed", true), e("A.txt", false), e("alpha", true)]);
    expect(sorted.map((x) => x.name)).toEqual(["alpha", "Zed", "A.txt", "b.txt"]);
  });
  it("does not mutate the input", () => {
    const input = [e("b", false), e("a", false)];
    sortEntries(input);
    expect(input[0].name).toBe("b");
  });
});

describe("filterEntries", () => {
  it("matches by case-insensitive substring", () => {
    expect(filterEntries([e("Readme.md", false), e("src", true)], "READ").map((x) => x.name)).toEqual(["Readme.md"]);
    expect(filterEntries([e("a", false)], "  ")).toHaveLength(1);
  });
});

describe("splitBreadcrumb", () => {
  it("splits absolute paths", () => {
    expect(splitBreadcrumb("/a/b")).toEqual([
      { label: "/", path: "/" },
      { label: "a", path: "/a" },
      { label: "b", path: "/a/b" },
    ]);
    expect(splitBreadcrumb("/")).toEqual([{ label: "/", path: "/" }]);
  });
  it("splits ~ paths", () => {
    expect(splitBreadcrumb("~/a")).toEqual([
      { label: "~", path: "~" },
      { label: "a", path: "~/a" },
    ]);
  });
  it("roots paths under home at ~", () => {
    expect(splitBreadcrumb("/home/u/proj/", "/home/u")).toEqual([
      { label: "~", path: "/home/u" },
      { label: "proj", path: "/home/u/proj" },
    ]);
    expect(splitBreadcrumb("/home/ux", "/home/u")[0].label).toBe("/");
  });
});

describe("parentPath", () => {
  it("climbs one level and stops at /", () => {
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBeNull();
  });
  it("climbs out of home", () => {
    expect(parentPath("/home/u", "/home/u")).toBe("/home");
    expect(parentPath("/home/u/x", "/home/u")).toBe("/home/u");
    expect(parentPath("~")).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;
  it("buckets", () => {
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime(now - 5_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toBe("3 个月前");
    expect(formatRelativeTime(now - 800 * 86_400_000, now)).toBe("2 年前");
  });
});

describe("size helpers", () => {
  it("formats file sizes only", () => {
    expect(formatEntrySize(e("a", false, 1536))).toBe("1.5 KB");
    expect(formatEntrySize(e("d", true))).toBe("");
  });
  it("flags files over 20 MiB", () => {
    expect(isTooLarge(e("big", false, 20 * 1024 * 1024 + 1))).toBe(true);
    expect(isTooLarge(e("ok", false, 20 * 1024 * 1024))).toBe(false);
    expect(isTooLarge(e("dir", true, 99 * 1024 * 1024))).toBe(false);
  });
});

describe("classifyListError", () => {
  it("classifies", () => {
    expect(classifyListError(new ApiError(400, "Permission denied (os error 13)"))).toBe("permission_denied");
    expect(classifyListError(new ApiError(400, "No such file or directory (os error 2)"))).toBe("not_found");
    expect(classifyListError(new ApiError(404, "Machine not found"))).toBe("not_found");
    expect(classifyListError(new ApiError(502, "machine not connected"))).toBe("offline");
    expect(classifyListError(new ApiError(400, "weird"))).toBe("other");
  });
});

describe("resolveStartPath", () => {
  it("prefers given, then cwd, then remembered, then ~", () => {
    rememberDirectory("m1", "/last");
    expect(resolveStartPath({ machineId: "m1", givenPath: "/g", cwd: "/c" })).toBe("/g");
    expect(resolveStartPath({ machineId: "m1", cwd: "/c" })).toBe("/c");
    expect(resolveStartPath({ machineId: "m1" })).toBe("/last");
    expect(resolveStartPath({ machineId: "m2" })).toBe("~");
  });
});
