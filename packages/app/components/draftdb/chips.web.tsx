// Option chips for select / multi_select values. Neutral by default; an option
// with an explicit red / orange / yellow colour gets a faint tint of the theme's
// err / warn token. Other themes' info/ok tokens are the accent colour, which
// DESIGN.md reserves for action and focus, so they are never used as tints.
import type { DraftDbColumn } from "@/lib/api";
import { optionTintToken } from "@/lib/draftDatabases";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";

export function optionColor(column: Pick<DraftDbColumn, "options"> | null | undefined, name: string): string | undefined {
  return column?.options?.find((o) => o.name === name)?.color;
}

export function OptionChip({ name, color }: { name: string; color?: string }) {
  const token = optionTintToken(color);
  const tint = token ? colors[token].replace(/\)$/, " / 0.16)") : undefined;
  const line = token ? colors[token].replace(/\)$/, " / 0.35)") : undefined;
  return (
    <span
      style={{
        padding: "1px 7px",
        borderRadius: 3,
        background: tint ?? colors.bg3,
        border: line ? `1px solid ${line}` : "1px solid transparent",
        color: colors.fg1,
        fontSize: rem(11.5),
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </span>
  );
}
