import { describe, expect, it } from "vitest";

import type { DiskInfo, ResourceStats } from "@offdesk/shared";

import {
  diskPercent,
  diskTooltip,
  diskUsages,
  formatBytes,
  loadReadout,
  memoryPercent,
  primaryDiskUsage,
} from "./resourceStats";

const GB = 1024 * 1024 * 1024;

function stats(disks: DiskInfo[]): ResourceStats {
  return {
    cpu_percent: 12,
    memory_total: 16 * GB,
    memory_used: 8 * GB,
    disks,
  };
}

function disk(
  mount_point: string,
  total_bytes: number,
  used_bytes: number,
): DiskInfo {
  return { mount_point, total_bytes, used_bytes };
}

describe("primaryDiskUsage", () => {
  it("returns null without stats or disks", () => {
    expect(primaryDiskUsage(undefined)).toBeNull();
    expect(primaryDiskUsage(stats([]))).toBeNull();
  });

  it("prefers the root mount over larger volumes", () => {
    const usage = primaryDiskUsage(
      stats([disk("/data", 900 * GB, 450 * GB), disk("/", 100 * GB, 40 * GB)]),
    );
    expect(usage).toEqual({
      mountPoint: "/",
      usedBytes: 40 * GB,
      totalBytes: 100 * GB,
      percent: 40,
    });
  });

  it("falls back to the largest volume when root is absent", () => {
    expect(
      primaryDiskUsage(
        stats([disk("/mnt/a", 100 * GB, 10 * GB), disk("/mnt/b", 500 * GB, 250 * GB)]),
      )?.mountPoint,
    ).toBe("/mnt/b");
  });

  it("clamps used above total so the meter never exceeds 100%", () => {
    expect(diskPercent(stats([disk("/", 100 * GB, 120 * GB)]))).toBe(100);
  });
});

describe("diskUsages", () => {
  it("drops duplicate mount points and zero-capacity devices", () => {
    expect(
      diskUsages(
        stats([
          disk("/", 100 * GB, 25 * GB),
          disk("/", 100 * GB, 25 * GB),
          disk("/mnt/pseudo", 0, 0),
        ]),
      ).map((usage) => usage.mountPoint),
    ).toEqual(["/"]);
  });
});

describe("formatBytes", () => {
  it("scales units and trims precision on large values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(40 * GB)).toBe("40.0 GB");
    expect(formatBytes(512 * GB)).toBe("512 GB");
  });
});

describe("diskTooltip", () => {
  it("lists every volume", () => {
    expect(
      diskTooltip(
        stats([disk("/", 100 * GB, 40 * GB), disk("/data", 500 * GB, 100 * GB)]),
      ),
    ).toBe("/  40.0 GB / 100 GB (40%)\n/data  100 GB / 500 GB (20%)");
  });

  it("says so when no disk was reported", () => {
    expect(diskTooltip(stats([]))).toBe("disk usage unavailable");
  });
});

describe("loadReadout", () => {
  it("reads cpu, memory and the primary disk as percents", () => {
    expect(loadReadout(stats([disk("/", 100 * GB, 71 * GB)]))).toBe("cpu 12% · mem 50% · disk 71%");
  });

  it("leaves out what the machine didn't report", () => {
    expect(loadReadout({ ...stats([]), memory_total: 0 })).toBe("cpu 12%");
    expect(loadReadout(undefined)).toBeNull();
    expect(memoryPercent(undefined)).toBeNull();
  });
});
