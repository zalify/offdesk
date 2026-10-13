import { useEffect, useState } from "react";

import { colors } from "@/lib/colors";

/** "Picked up where you left off". On the desktop a square notice under the
 *  tab bar; on the phone (`inline`) it takes the title bar's subtitle line
 *  for a few seconds, so it never covers terminal output. */
export function HandoffBanner({
  isMobile,
  inline = false,
  onDone,
}: {
  isMobile: boolean;
  inline?: boolean;
  onDone: () => void;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setVisible(false), 3600);
    const removeTimer = window.setTimeout(onDone, 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [onDone]);

  if (inline) {
    return (
      <span
        data-testid="handoff-banner"
        role="status"
        style={{
          color: colors.accent,
          opacity: visible ? 1 : 0,
          transition: "opacity 400ms ease",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Picked up where you left off
      </span>
    );
  }

  return (
    <div
      data-testid="handoff-banner"
      style={{
        position: "absolute",
        top: isMobile ? 50 : 40,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 45,
        padding: "6px 12px",
        borderRadius: 4,
        background: colors.bg2,
        border: `1px solid ${colors.line}`,
        color: colors.fg1,
        fontFamily: "var(--font-display)",
        fontSize: 12,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 400ms ease",
      }}
    >
      Picked up where you left off
    </div>
  );
}
