import { useState, useEffect, useCallback } from "react";
import { isDesktopShell } from "@/lib/desktopHub";
import { colors } from "@/lib/colors";
import { Button, FloatCard } from "./Primitives.web";

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
  const status = busy === "installing" ? "Installing update…" : busy === "checking" ? "Checking…" : version ? (inline ? `v${version} available` : `offdesk/dev ${version} is ready`) : message ?? "Desktop app updates";
  if (inline) {
    return (
      <div data-testid="desktop-update-settings" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span role="status" style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: colors.fg2 }}>{status}</span>
          {version && <Button size="sm" disabled={!!busy} onClick={() => void install()}>install update</Button>}
          <Button size="sm" kind="secondary" disabled={!!busy} onClick={() => void checkForUpdate()}>check for updates</Button>
        </div>
        {error && <div role="alert" style={{ overflowWrap: "anywhere", fontSize: 12, color: colors.err }}>{error}</div>}
      </div>
    );
  }
  // The card above the status line (wireframe Main).
  return (
    <FloatCard testId="desktop-update-toast" style={{ width: 300, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <div role="status" style={{ fontWeight: 600 }}>{status}</div>
      {error && <div role="alert" style={{ overflowWrap: "anywhere", fontSize: 12, color: colors.err }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        {version && <Button size="xs" disabled={!!busy} onClick={() => void install()}>install update</Button>}
        <Button size="xs" kind="ghost" disabled={!!busy} ariaLabel="Dismiss update" onClick={() => setDismissed(true)}>later</Button>
      </div>
    </FloatCard>
  );
}
