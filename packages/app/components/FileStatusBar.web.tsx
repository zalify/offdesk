import type { DirEntry } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { formatBytes } from "@/lib/resourceStats";
import { rem } from "@/lib/rem";

/** "N items" or "M of N selected · total size" (files only). */
export function FileStatusBar({
  total,
  selected,
}: {
  total: number;
  selected: DirEntry[];
}) {
  let text = `${total} ${total === 1 ? "item" : "items"}`;
  if (selected.length > 0) {
    const bytes = selected.reduce((sum, e) => sum + (e.is_dir ? 0 : (e.size ?? 0)), 0);
    const hasFile = selected.some((e) => !e.is_dir);
    text = `${selected.length} of ${total} selected${hasFile ? ` · ${formatBytes(bytes)}` : ""}`;
  }
  return (
    <div
      data-testid="file-browser-status"
      style={{
        flexShrink: 0,
        padding: "6px 20px",
        borderTop: `1px solid ${colors.lineSoft}`,
        fontSize: rem(11.5),
        color: colors.fg3,
        fontFamily: "var(--font-display)",
      }}
    >
      {text}
    </div>
  );
}
