import { memo } from "react";
import { colors } from "@/lib/colors";
import { isTauri, isTauriMobile, detectOS } from "@/lib/platform";
import { WindowControls } from "./WindowControls";
import "./Primitives.css";

function AppTitleBarComponent({ isMobile, onOpenSettings }: { isMobile: boolean; onOpenSettings?: () => void }) {
  // The bar only hosts desktop window chrome (drag region + min/max/close).
  // The Android/iOS shells have no window to manage, so render nothing there.
  if (!isTauri() || isTauriMobile()) return null;
  const isMac = detectOS() === "macos";

  return (
    <div
      data-testid="app-title-bar"
      data-tauri-drag-region
      style={{
        display: "flex",
        alignItems: "stretch",
        borderBottom: `1px solid ${colors.lineSoft}`,
        background: colors.bg1,
        flexShrink: 0,
        minHeight: isMobile ? 44 : 36,
        userSelect: "none",
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {isMac && (
        // Native macOS traffic lights overlay this gutter (titleBarStyle: Overlay).
        <div data-tauri-drag-region style={{ width: 78, flexShrink: 0 }} />
      )}
      <div data-tauri-drag-region style={{ flex: 1 }} />
      {onOpenSettings && (
        <button type="button" aria-label="Settings" title="Settings" onClick={onOpenSettings}
          className="odk-text-btn" style={{ alignSelf: "center", marginRight: 8, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          settings
        </button>
      )}
      <WindowControls position="right" />
    </div>
  );
}

export const AppTitleBar = memo(AppTitleBarComponent);
