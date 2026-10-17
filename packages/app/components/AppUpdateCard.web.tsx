// P02: a newer phone app, as a floating card above the key bar. Android
// installs it in place; iPhone hands over to TestFlight.

import type { ReactNode } from "react";
import { colors } from "@/lib/colors";
import { useKeyBarClearance } from "@/lib/updateCardPlacement";
import { Button, FloatCard, fontDisplay, fontProse } from "./Primitives.web";

export function AppUpdateCard({
  version,
  current,
  note,
  status,
  actionLabel,
  busy,
  onAction,
  onLater,
  testId,
}: {
  version: string;
  /** The installed version; left out until it is known. */
  current: string | null;
  note: string;
  /** Progress or a problem, under the note. */
  status?: ReactNode;
  actionLabel: string;
  busy?: boolean;
  onAction: () => void;
  onLater: () => void;
  testId?: string;
}) {
  const bottom = useKeyBarClearance(true);
  return (
    <FloatCard
      testId={testId}
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: bottom === null ? "max(12px, env(safe-area-inset-bottom))" : bottom,
        zIndex: 10000,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ flexGrow: 1, minWidth: 0, fontFamily: fontDisplay, fontSize: 14, fontWeight: 600, color: colors.fg0 }}>
          Offdesk Dev {version}
        </span>
        {current ? (
          <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontFamily: fontDisplay, fontSize: 12, color: colors.fg3 }}>
            you have {current}
          </span>
        ) : null}
      </div>
      <div style={{ fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>{note}</div>
      {status}
      <div style={{ display: "flex", gap: 8 }}>
        {/* Labels arrive lowercase already; this keeps "open TestFlight" as written. */}
        <Button onClick={onAction} disabled={busy} style={{ height: 44, flexGrow: 1, textTransform: "none" }}>
          {actionLabel}
        </Button>
        <Button kind="secondary" onClick={onLater} disabled={busy} style={{ height: 44, flexShrink: 0 }}>
          later
        </Button>
      </div>
    </FloatCard>
  );
}
