// The machine switcher's load at a glance: cpu, mem and disk as three bars.
// Shared by the tab bar and the sessions sidebar's machine row.

import type { ResourceStats } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { diskPercent, diskTooltip } from "@/lib/resourceStats";

// Over this share a resource reads as busy: its bar goes full strength.
// Not red: the warn colour stays for a terminal waiting on you.
const BUSY_PERCENT = 85;

function loadPercents(stats: ResourceStats | undefined) {
  return [
    { label: "cpu", name: "cpu", percent: stats ? Math.round(stats.cpu_percent) : null },
    {
      label: "mem",
      name: "memory",
      percent: stats && stats.memory_total > 0
        ? Math.round((stats.memory_used / stats.memory_total) * 100)
        : null,
    },
    { label: "disk", name: "disk", percent: diskPercent(stats) },
  ];
}

export function loadLabel(stats: ResourceStats | undefined): string {
  return loadPercents(stats)
    .map(({ name, percent }) => `${name} ${percent === null ? "unknown" : `${percent}%`}`)
    .join(", ");
}

/** cpu, mem and disk as three 3px bars, 12px tall: the machine's load at a
 *  glance. Exact values are in the switcher's title and its menu. */
export function LoadGlyph({ stats }: { stats: ResourceStats | undefined }) {
  return (
    <span
      data-testid="tab-bar-meters"
      aria-hidden="true"
      title={diskTooltip(stats)}
      style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12, flexShrink: 0 }}
    >
      {loadPercents(stats).map(({ label, percent }) => (
        <span
          key={label}
          data-testid={`tab-bar-meter-${label}`}
          data-percent={percent ?? undefined}
          style={{
            width: 3,
            height: `${Math.max(percent ?? 0, 8)}%`,
            background: percent !== null && percent > BUSY_PERCENT ? colors.fg0 : colors.fg3,
            opacity: percent === null ? 0.4 : 1,
          }}
        />
      ))}
    </span>
  );
}
