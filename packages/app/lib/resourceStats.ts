import type { DiskInfo, ResourceStats } from "@offdesk/shared";

export interface DiskUsage {
  mountPoint: string;
  usedBytes: number;
  totalBytes: number;
  percent: number;
}

function toUsage(disk: DiskInfo): DiskUsage {
  const used = Math.min(disk.used_bytes, disk.total_bytes);
  return {
    mountPoint: disk.mount_point,
    usedBytes: used,
    totalBytes: disk.total_bytes,
    percent: Math.round((used / disk.total_bytes) * 100),
  };
}

// Machines can report the same filesystem under several mount points
// (btrfs subvolumes, bind mounts). Keep the first entry per mount point and
// drop anything with no capacity, which sysinfo reports for pseudo devices.
export function diskUsages(stats: ResourceStats | undefined): DiskUsage[] {
  if (!stats?.disks?.length) return [];
  const seen = new Set<string>();
  const usages: DiskUsage[] = [];
  for (const disk of stats.disks) {
    if (disk.total_bytes <= 0) continue;
    if (seen.has(disk.mount_point)) continue;
    seen.add(disk.mount_point);
    usages.push(toUsage(disk));
  }
  return usages;
}

// The disk worth putting in a one-slot meter: root when present, otherwise
// the largest volume the machine reported.
export function primaryDiskUsage(
  stats: ResourceStats | undefined,
): DiskUsage | null {
  const usages = diskUsages(stats);
  if (usages.length === 0) return null;
  const root = usages.find((usage) => usage.mountPoint === "/");
  if (root) return root;
  return usages.reduce((largest, usage) =>
    usage.totalBytes > largest.totalBytes ? usage : largest,
  );
}

export function diskPercent(stats: ResourceStats | undefined): number | null {
  return primaryDiskUsage(stats)?.percent ?? null;
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

// Hover text listing every reported volume, so the single meter does not hide
// the other disks on multi-volume hosts.
export function diskTooltip(stats: ResourceStats | undefined): string {
  const usages = diskUsages(stats);
  if (usages.length === 0) return "disk usage unavailable";
  return usages
    .map(
      (usage) =>
        `${usage.mountPoint}  ${formatBytes(usage.usedBytes)} / ${formatBytes(
          usage.totalBytes,
        )} (${usage.percent}%)`,
    )
    .join("\n");
}

export function memoryPercent(stats: ResourceStats | undefined): number | null {
  if (!stats || stats.memory_total <= 0) return null;
  return Math.round((Math.min(stats.memory_used, stats.memory_total) / stats.memory_total) * 100);
}

// One line for a machine's load where there is room for words, as on the
// phone's machine list: "cpu 12% · mem 54% · disk 71%". Null without stats.
export function loadReadout(stats: ResourceStats | undefined): string | null {
  if (!stats) return null;
  const mem = memoryPercent(stats);
  const disk = diskPercent(stats);
  return [
    `cpu ${Math.round(stats.cpu_percent)}%`,
    mem === null ? null : `mem ${mem}%`,
    disk === null ? null : `disk ${disk}%`,
  ]
    .filter(Boolean)
    .join(" · ");
}
