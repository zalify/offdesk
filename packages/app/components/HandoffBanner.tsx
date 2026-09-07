import { useEffect, useState } from "react";

import { colors, colorAlpha } from "@/lib/colors";

export function HandoffBanner({
  isMobile,
  onDone,
}: {
  isMobile: boolean;
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

  return (
    <div
      data-testid="handoff-banner"
      style={{
        position: "absolute",
        top: isMobile ? 50 : 40,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 45,
        padding: "5px 10px",
        borderRadius: 999,
        background: colorAlpha.surfaceOpaque94,
        border: `1px solid ${colors.border}`,
        color: colors.foregroundSecondary,
        fontSize: 11,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 400ms ease",
      }}
    >
      Picked up where you left off
    </div>
  );
}
