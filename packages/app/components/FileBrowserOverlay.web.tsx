import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { FileBrowser } from "./FileBrowser.web";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { UNSAVED_EDIT_NOTICE } from "@/lib/fileEdit";
import { showNotice } from "@/lib/workspaceToast";

// A floating panel over the workspace listing one machine's files, like the
// agent browser overlay. The workspace underneath stays mounted.
export function FileBrowserOverlay({
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
  // An open editor with unsaved changes keeps the overlay open.
  const [dirty, setDirty] = useState(false);
  const onClose = useCallback(() => {
    if (dirty) showNotice(UNSAVED_EDIT_NOTICE);
    else close();
  }, [dirty, close]);
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
        background: colorAlpha.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-label={`Files on ${machineName}`}
        data-testid="file-browser-overlay"
        tabIndex={-1}
        style={{
          width: "min(92vw, 1120px)",
          height: "min(84vh, 640px)",
          display: "flex",
          flexDirection: "column",
          background: colors.bg1,
          color: colors.fg0,
          border: `1px solid ${colors.line}`,
          borderRadius: 6,
          boxShadow: "0 24px 64px rgb(0 0 0 / 0.45)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 20px",
            borderBottom: `1px solid ${colors.lineSoft}`,
            flexShrink: 0,
          }}
        >
          <h2 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: rem(18), lineHeight: rem(24), fontWeight: 600, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            files on {machineName}
          </h2>
          <button
            type="button"
            data-testid="file-browser-overlay-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className="odk-text-btn"
          >
            [esc]
          </button>
        </div>
        <FileBrowser
          machineId={machineId}
          homeDir={homeDir}
          startPath={startPath}
          touch={false}
          canEdit={canEdit}
          onDirtyChange={setDirty}
        />
      </div>
    </div>
  );
}
