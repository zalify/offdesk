import { useCallback, useState } from "react";
import { isTauri, detectOS } from "@/lib/platform";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";

function MacControls() {
  const [hovered, setHovered] = useState(false);

  const handleClose = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  }, []);

  const handleMinimize = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }, []);

  const handleMaximize = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  }, []);

  const dotStyle = (color: string): React.CSSProperties => ({
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: color,
    border: "none",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        flexShrink: 0,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      <button onClick={handleClose} style={dotStyle("#ff5f57")} aria-label="Close">
        {hovered && (
          <svg width="6" height="6" viewBox="0 0 6 6">
            <line x1="0.5" y1="0.5" x2="5.5" y2="5.5" stroke="#4d0000" strokeWidth="1.2" />
            <line x1="5.5" y1="0.5" x2="0.5" y2="5.5" stroke="#4d0000" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button onClick={handleMinimize} style={dotStyle("#febc2e")} aria-label="Minimize">
        {hovered && (
          <svg width="6" height="2" viewBox="0 0 6 2">
            <line x1="0.5" y1="1" x2="5.5" y2="1" stroke="#995700" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button onClick={handleMaximize} style={dotStyle("#28c840")} aria-label="Maximize">
        {hovered && (
          <svg width="6" height="6" viewBox="0 0 6 6">
            <polyline points="1,4 1,1 4,1" fill="none" stroke="#006500" strokeWidth="1.2" />
            <polyline points="5,2 5,5 2,5" fill="none" stroke="#006500" strokeWidth="1.2" />
          </svg>
        )}
      </button>
    </div>
  );
}

function WinLinuxControls() {
  const handleMinimize = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }, []);

  const handleMaximize = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  }, []);

  const handleClose = useCallback(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  }, []);

  // Our own window buttons as text, on the right (wireframe D13).
  const buttonBase: React.CSSProperties = {
    width: 46,
    background: "none",
    border: "none",
    borderRadius: 0,
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: colors.fg2,
    fontFamily: "var(--font-display)",
    fontSize: rem(13),
  };
  const hover = (danger = false) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.background = danger ? colors.err : colors.bg3;
      e.currentTarget.style.color = danger ? colors.onErr : colors.fg0;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.background = "none";
      e.currentTarget.style.color = colors.fg2;
    },
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        flexShrink: 0,
        borderLeft: `1px solid ${colors.lineSoft}`,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      <button onClick={handleMinimize} style={buttonBase} {...hover()} aria-label="Minimize">_</button>
      <button onClick={handleMaximize} style={buttonBase} {...hover()} aria-label="Maximize">[ ]</button>
      <button onClick={handleClose} style={buttonBase} {...hover(true)} aria-label="Close">x</button>
    </div>
  );
}

export function WindowControls({ position }: { position?: "left" | "right" }) {
  if (!isTauri()) return null;
  const os = detectOS();
  if (os === "macos" && position !== "right") return <MacControls />;
  if (os === "macos" && position === "right") return null;
  if (position === "left") return null;
  return <WinLinuxControls />;
}
