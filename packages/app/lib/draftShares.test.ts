import { describe, expect, it } from "vitest";
import { expiryLabel, formatBytes, relativeAgo, summarizeAssets, truncateMiddle } from "./draftShares";

describe("truncateMiddle", () => {
  it("keeps short strings", () => expect(truncateMiddle("abc", 10)).toBe("abc"));
  it("shortens the middle and respects max", () => {
    const out = truncateMiddle("https://hub.example.com/s/abcdefghijklmnop", 20);
    expect(out.length).toBe(20);
    expect(out.startsWith("https://")).toBe(true);
    expect(out.endsWith("mnop")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("expiryLabel", () => {
  const now = 1_000_000_000;
  it("handles never / expired / future", () => {
    expect(expiryLabel(null, now)).toBe("never expires");
    expect(expiryLabel(now - 1, now)).toBe("expired");
    expect(expiryLabel(now + 3 * 86_400_000, now)).toBe("expires in 3d");
    expect(expiryLabel(now + 2 * 3_600_000, now)).toBe("expires in 2h");
  });
});

describe("relativeAgo / formatBytes", () => {
  it("formats", () => {
    expect(relativeAgo(1000, 1000)).toBe("just now");
    expect(relativeAgo(0, 5 * 60_000)).toBe("5m ago");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("summarizeAssets", () => {
  it("counts included and lists failures", () => {
    const s = summarizeAssets([
      { source: "file://dev/a.png", ok: true },
      { source: "file://dev/b.png", ok: false, reason: "machine offline" },
      { source: "file://dev/c.png", ok: false },
    ]);
    expect(s.total).toBe(3);
    expect(s.included).toBe(1);
    expect(s.headline).toBe("1 image included");
    expect(s.failed).toEqual([
      { source: "file://dev/b.png", reason: "machine offline" },
      { source: "file://dev/c.png", reason: "unknown error" },
    ]);
  });
  it("handles empty", () => {
    expect(summarizeAssets(undefined).headline).toBe("0 images included");
  });
});
