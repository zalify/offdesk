import { useEffect } from "react";
import { isDesktopShell } from "@/lib/desktopHub";
import { useBundledServices } from "@/lib/bundledServices";
import { colors } from "@/lib/colors";
import {
  cardVisible,
  checkDesktopUpdate,
  closeUpdateCard,
  dismissUntilTomorrow,
  restartToUpdate,
  restoreDesktopUpdate,
  updateWhenQuitting,
  useDesktopUpdate,
} from "@/lib/desktopUpdate";
import { openSettings } from "@/lib/openSettings";
import { Button, Chip, FloatCard, fontProse, TextButton } from "./Primitives.web";

const RECHECK_MS = 12 * 60 * 60 * 1000;

/** Wireframe Main (U01): the card above the status line once an update has
 *  downloaded. It also does the checking: a few seconds after launch, then
 *  twice a day. (The menu bar's `restart to update` is handled natively.) */
export function UpdateNotification() {
  const update = useDesktopUpdate();
  // The hub sentence holds only when the services run from this app.
  const services = useBundledServices();

  useEffect(() => {
    if (!isDesktopShell()) return;
    void restoreDesktopUpdate();
    const first = setTimeout(() => void checkDesktopUpdate({ silent: true }), 5000);
    const again = setInterval(() => void checkDesktopUpdate({ silent: true }), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, []);

  if (!isDesktopShell() || !cardVisible(update, Date.now())) return null;
  const installing = update.phase === "installing";
  const installed = update.phase === "installed";
  const sentence = installed
    ? "Installed. It takes over the next time Offdesk Dev starts."
    : update.phase === "downloading"
      ? `Downloading in the background${update.progress === null ? "…" : ` · ${Math.round(update.progress * 100)}%`}`
      : update.phase === "idle"
        ? "Not downloaded yet. Restarting downloads and installs it first."
        : `Downloaded in the background.${services?.bundled ? " This Mac is the hub, so the hub and node restart with the app. Terminals keep running in tmux." : ""}`;
  return (
    <FloatCard testId="desktop-update-toast" style={{ width: 380, maxWidth: "calc(100vw - 32px)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span role="status" style={{ fontSize: 14, fontWeight: 600 }}>{update.available} {update.phase === "downloading" ? "is downloading" : update.phase === "idle" ? "is out" : "is ready"}</span>
        {update.current ? <Chip>you have {update.current}</Chip> : null}
        <span style={{ flex: 1 }} />
        <TextButton label="Dismiss until tomorrow" onClick={() => dismissUntilTomorrow()}>×</TextButton>
      </div>
      <div style={{ fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>{sentence}</div>
      {update.error ? <div role="alert" style={{ overflowWrap: "anywhere", fontFamily: fontProse, fontSize: 12, color: colors.err }}>{update.error}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button size="sm" disabled={installing} onClick={() => void restartToUpdate()}>{installing ? "installing…" : "restart now"}</Button>
        {installed ? null : <Button size="sm" kind="secondary" disabled={installing} onClick={() => void updateWhenQuitting()}>when I quit</Button>}
        <TextButton onClick={() => { closeUpdateCard(); openSettings("Versions"); }}>what's new</TextButton>
      </div>
    </FloatCard>
  );
}
