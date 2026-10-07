import { ArrowLeft } from "lucide-react";
import { FileBrowser } from "./FileBrowser.web";
import { colors } from "@/lib/colors";

// The phone's file browser: a full-screen surface over the terminal area (the
// terminals underneath stay mounted) with a back button, sized for touch.
export function FileBrowserMobileSurface({
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
  return (
    <div
      data-testid="mobile-file-browser-surface"
      // The surface takes its own touches; edge swipes do not switch terminals.
      data-edge-swipe="off"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: colors.bg0,
        color: colors.fg0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 4px",
          background: colors.bg1,
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          data-testid="mobile-file-browser-surface-back"
          aria-label="返回终端"
          title="返回终端"
          onClick={onClose}
          style={{
            width: 44,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            border: "none",
            background: "transparent",
            color: colors.fg2,
            cursor: "pointer",
          }}
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>文件</span>
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
      </div>
      <FileBrowser machineId={machineId} homeDir={homeDir} startPath={startPath} touch />
    </div>
  );
}
