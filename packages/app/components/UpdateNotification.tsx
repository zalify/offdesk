import { useEffect, useState } from "react";
import { desktopRole, isDesktopShell } from "@/lib/desktopHub";
import { colors } from "@/lib/colors";
import {
  cardVisible,
  checkDesktopUpdate,
  closeUpdateCard,
  dismissUntilTomorrow,
  restartToUpdate,
  updateWhenQuitting,
  useDesktopUpdate,
} from "@/lib/desktopUpdate";
import { openSettings } from "@/lib/openSettings";
import { Button, Chip, FloatCard, fontProse, TextButton } from "./Primitives.web";

const RECHECK_MS = 12 * 60 * 60 * 1000;

/** Wireframe Main (U01): the card above the status line once an update has
 *  downloaded. It also does the checking — a few seconds after launch, then
 *  twice a day — and hears the menu bar's `restart to update`. */
export function UpdateNotification() {
  const update = useDesktopUpdate();
  const [isHub, setIsHub] = useState(false);

  useEffect(() => {
    if (!isDesktopShell()) return;
    desktopRole().then((role) => setIsHub(role === "hub")).catch(() => {});
    const first = setTimeout(() => void checkDesktopUpdate({ silent: true }), 5000);
    const again = setInterval(() => void checkDesktopUpdate({ silent: true }), RECHECK_MS);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("offdesk://restart-to-update", () => void restartToUpdate()))
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(again);
      unlisten?.();
    };
  }, []);

  if (!isDesktopShell() || !cardVisible(update, Date.now())) return null;
  const installing = update.phase === "installing";
  const installed = update.phase === "installed";
  const sentence = installed
    ? "Installed. It takes over the next time Offdesk DEV starts."
    : `Downloaded in the background.${isHub ? " This Mac is the hub, so the hub and node restart with the app. Terminals keep running in tmux." : ""}`;
  return (
    <FloatCard testId="desktop-update-toast" style={{ width: 380, maxWidth: "calc(100vw - 32px)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span role="status" style={{ fontSize: 14, fontWeight: 600 }}>{update.available} is ready</span>
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
