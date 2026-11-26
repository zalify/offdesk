import type { CSSProperties } from "react";

import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";

/** Shared look for tag chips (card, editor, active-filter strip). */
export function chipStyle(opts: { compact?: boolean; inline?: boolean; active?: boolean } = {}): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    minHeight: opts.compact ? 36 : 20,
    padding: opts.compact ? "0 10px" : "0 7px",
    borderRadius: 4,
    border: `1px ${opts.inline ? "dashed" : "solid"} ${opts.active ? colorAlpha.accentLine : colors.line}`,
    background: opts.active ? colorAlpha.accentSoft : colors.bg2,
    color: opts.active ? colors.accent : opts.inline ? colors.fg2 : colors.fg1,
    fontFamily: "var(--font-display)",
    fontSize: rem(11.5),
    lineHeight: 1.2,
    cursor: "pointer",
    boxSizing: "border-box",
  };
}

export const ellipsis: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
