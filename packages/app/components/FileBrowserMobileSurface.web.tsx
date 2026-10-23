import { useCallback, useState } from "react";
import { FileBrowser } from "./FileBrowser.web";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { UNSAVED_EDIT_NOTICE } from "@/lib/fileEdit";
import { showNotice } from "@/lib/workspaceToast";

// The phone's file browser: a full-screen surface over the terminal area (the
// terminals underneath stay mounted) with a back button, sized for touch.
export function FileBrowserMobileSurface({
  machineId,
  machineName,
  homeDir,
  startPath,
  canEdit = false,
  onClose: close,
}: {
  machineId: string;
  machineName: string;
  homeDir?: string;
  startPath: string;
  canEdit?: boolean;
  onClose: () => void;
}) {
  // An open editor with unsaved changes keeps the surface open.
  const [dirty, setDirty] = useState(false);
  const onClose = useCallback(() => {
    if (dirty) showNotice(UNSAVED_EDIT_NOTICE);
    else close();
  }, [dirty, close]);
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
      {/* P08: `← back to terminal`, then the Files heading and where. */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", padding: "4px 8px" }}>
        <button
          type="button"
          data-testid="mobile-file-browser-surface-back"
          aria-label="Back to terminal"
          title="Back to terminal"
          onClick={onClose}
          className="odk-text-btn"
          style={{ height: 44, padding: "0 8px", fontSize: rem(13), color: colors.fg2 }}
        >
          ← back to terminal
        </button>
      </div>
      <div style={{ flexShrink: 0, padding: "0 16px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: rem(28), lineHeight: rem(34), fontWeight: 600, letterSpacing: "-0.035em" }}>Files</h1>
        <div style={{ fontFamily: "var(--font-display)", fontSize: rem(12), color: colors.fg3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {machineName}
        </div>
      </div>
      <FileBrowser
        machineId={machineId}
        homeDir={homeDir}
        startPath={startPath}
        touch
        canEdit={canEdit}
        onDirtyChange={setDirty}
      />
    </div>
  );
}
