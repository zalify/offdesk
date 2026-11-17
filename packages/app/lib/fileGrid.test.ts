import { describe, expect, it } from "vitest";
import type { DirEntry } from "@offdesk/shared";
import { gridColumns, gridMoveDelta, isThumbnailable } from "./fileGrid";
import { LruCache } from "./lruCache";

describe("gridMoveDelta", () => {
  it("moves by one horizontally and a row vertically", () => {
    expect(gridMoveDelta(4, "ArrowRight", 3, 10)).toBe(1);
    expect(gridMoveDelta(4, "ArrowLeft", 3, 10)).toBe(-1);
    expect(gridMoveDelta(4, "ArrowUp", 3, 10)).toBe(-3);
    expect(gridMoveDelta(4, "ArrowDown", 3, 10)).toBe(3);
  });
  it("stays put at the edges", () => {
    expect(gridMoveDelta(0, "ArrowLeft", 3, 10)).toBe(0);
    expect(gridMoveDelta(9, "ArrowRight", 3, 10)).toBe(0);
    expect(gridMoveDelta(1, "ArrowUp", 3, 10)).toBe(0);
    expect(gridMoveDelta(9, "ArrowDown", 3, 10)).toBe(0);
  });
  it("goes to the last item when the row below is partial", () => {
    // 10 items, 3 columns: index 5 is in row 1, row 3 holds only index 9.
    expect(gridMoveDelta(7, "ArrowDown", 3, 10)).toBe(2);
    expect(gridMoveDelta(8, "ArrowDown", 3, 10)).toBe(1);
  });
  it("ignores left/right in a single column", () => {
    expect(gridMoveDelta(2, "ArrowRight", 1, 5)).toBe(0);
    expect(gridMoveDelta(2, "ArrowDown", 1, 5)).toBe(1);
    expect(gridMoveDelta(2, "ArrowUp", 1, 5)).toBe(-1);
  });
  it("is zero for an empty listing", () => {
    expect(gridMoveDelta(0, "ArrowDown", 3, 0)).toBe(0);
  });
});

describe("gridColumns", () => {
  it("fits as many tiles as the width allows, at least one", () => {
    expect(gridColumns(500, 100, 10)).toBe(4);
    expect(gridColumns(50, 100, 10)).toBe(1);
  });
});

describe("isThumbnailable", () => {
  const file = (name: string, size = 1000): DirEntry =>
    ({ name, path: `/x/${name}`, is_dir: false, size }) as DirEntry;
  it("accepts small images only", () => {
    expect(isThumbnailable(file("a.PNG"))).toBe(true);
    expect(isThumbnailable(file("a.svg"))).toBe(true);
    expect(isThumbnailable(file("a.txt"))).toBe(false);
    expect(isThumbnailable(file("a.png", 6 * 1024 * 1024))).toBe(false);
    expect(isThumbnailable({ ...file("d.png"), is_dir: true })).toBe(false);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const evicted: string[] = [];
    const cache = new LruCache<number>(2, (k) => evicted.push(k));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(evicted).toEqual(["b"]);
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
  });
});
