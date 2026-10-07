import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { FileBrowser } from "./FileBrowser.web";
import { colors, colorAlpha } from "@/lib/colors";

// A floating panel over the workspace listing one machine's files, like the
// agent browser overlay. The workspace underneath stays mounted.
export function FileBrowserOverlay({
  machineId,
  machineName,
  homeDir,
  startPath,
  onClose,
}: {
  machineId: string;
  machineName: string;
  homeDir?: string;
  startPath: string;
  onClose: () => void;
}) {
  // Whatever had focus underneath (an xterm); the FileBrowser takes focus on
  // mount, so this must be read before it does.
  const [previous] = useState(() => document.activeElement);

  useEffect(() => {
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [previous]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="file-browser-overlay-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: colorAlpha.backgroundShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-label={`${machineName} 上的文件`}
        data-testid="file-browser-overlay"
        tabIndex={-1}
        style={{
          width: "min(92vw, 760px)",
          height: "min(80vh, 640px)",
          display: "flex",
          flexDirection: "column",
          background: colors.bg0,
          color: colors.fg0,
          border: `1px solid ${colors.line}`,
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.35)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 8px 8px 14px",
            background: colors.bg1,
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>文件</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: colors.fg3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {machineName}
          </span>
          <button
            type="button"
            data-testid="file-browser-overlay-close"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: colors.fg2,
              cursor: "pointer",
              padding: 4,
              display: "flex",
              borderRadius: 4,
            }}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <FileBrowser
          machineId={machineId}
          homeDir={homeDir}
          startPath={startPath}
          touch={false}
        />
      </div>
    </div>
  );
}
