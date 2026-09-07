import { useState, useEffect, useCallback } from "react";
import { isDesktopShell } from "@/lib/desktopHub";
import { colors } from "@/lib/colors";

/** Automatic toast and the always-available check in Settings → About. */
export function UpdateNotification({ inline = false }: { inline?: boolean }) {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checking" | "installing" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async (silent = false) => {
    setBusy("checking");
    setError(null);
    setMessage(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      setVersion(update?.version ?? null);
      if (!update && !silent) setMessage("You’re up to date.");
      await update?.close();
    } catch (e) {
      if (!silent) setError(`Could not check for updates: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!isDesktopShell() || inline) return;
    const timer = setTimeout(() => void checkForUpdate(true), 5000);
    return () => clearTimeout(timer);
  }, [inline, checkForUpdate]);

  const install = async () => {
    setBusy("installing");
    setError(null);
    setMessage(null);
    let update;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      update = await check();
      if (!update) {
        setVersion(null);
        setMessage("You’re up to date.");
        return;
      }
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(`Update failed. You can try again: ${String(e)}`);
    } finally {
      setBusy(null);
      await update?.close().catch(() => {});
    }
  };

  if (!isDesktopShell() || (!inline && (dismissed || (!version && !message && !error)))) return null;
  const foreground = inline ? colors.foreground : colors.onAccent;
  const buttonStyle = {
    border: `1px solid ${inline ? colors.border : "currentColor"}`,
    background: "transparent", color: foreground, borderRadius: 6,
    padding: "6px 10px", fontSize: 12, cursor: busy ? "default" : "pointer",
  };
  return (
    <div data-testid={inline ? "desktop-update-settings" : "desktop-update-toast"}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: inline ? "12px 0" : 12,
        maxWidth: 400, fontSize: 12, background: inline ? "transparent" : colors.accent,
        color: foreground, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span role="status">{busy === "installing" ? "Installing update…" : busy === "checking" ? "Checking…" : version ? `v${version} available` : message ?? "Desktop app updates"}</span>
        {version && <button type="button" disabled={!!busy} onClick={() => void install()} style={buttonStyle}>Install update</button>}
        {inline && <button type="button" disabled={!!busy} onClick={() => void checkForUpdate()} style={buttonStyle}>Check for updates</button>}
        {!inline && <button type="button" disabled={!!busy} aria-label="Dismiss update" onClick={() => setDismissed(true)} style={buttonStyle}>×</button>}
      </div>
      {error && <div role="alert" style={{ overflowWrap: "anywhere" }}>{error}</div>}
    </div>
  );
}
