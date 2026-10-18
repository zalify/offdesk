import { useEffect, useState } from "react";
import { colorAlpha, colors } from "@/lib/colors";
import {
  PREFIX_ACTION_DEFINITIONS,
  formatPrefixBinding,
  loadPrefixBindings,
  type PrefixBindings,
} from "@/lib/prefixKey";
import { rem } from "@/lib/rem";

// Compact overlay listing the live ⌃B bindings. Opened by ⌃B ?, closed by
// Esc or any click. "Coming soon" actions (phase 2+) are filtered out.
export function CheatSheetOverlay({ onClose }: { onClose: () => void }) {
  const [bindings] = useState<PrefixBindings>(() => loadPrefixBindings());

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  const rows = PREFIX_ACTION_DEFINITIONS.filter(
    (definition) => !definition.comingSoon,
  );

  return (
    <div
      data-testid="prefix-cheatsheet"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: colorAlpha.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: colors.bg2,
          border: `1px solid ${colors.line}`,
          borderRadius: 6,
          padding: "20px 24px",
          width: "calc(100% - 48px)",
          maxWidth: 660,
          maxHeight: "80vh",
          overflow: "auto",
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            fontSize: rem(15),
            fontWeight: 600,
            color: colors.fg0,
            marginBottom: 14,
          }}
        >
          Keyboard shortcuts
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "7px 20px",
          }}
        >
          {rows.map((definition) => (
            <div
              key={definition.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                fontSize: rem(12.5),
                textTransform: "lowercase",
              }}
            >
              <span style={{ color: colors.fg2 }}>{definition.label}</span>
              <span
                style={{
                  color: colors.fg0,
                  fontFamily: "var(--font-display)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatPrefixBinding(definition.id, bindings)}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: `1px solid ${colors.lineSoft}`,
            fontFamily: "var(--font-sans)",
            fontSize: rem(12),
            color: colors.fg3,
          }}
        >
          Every key except ⌃B goes to the terminal · copy and paste the way your system does
        </div>
      </div>
    </div>
  );
}
