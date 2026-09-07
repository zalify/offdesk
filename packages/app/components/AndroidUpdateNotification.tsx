import { useEffect, useSyncExternalStore } from "react";
import { colors } from "@/lib/colors";
import {
  isAndroidApp, getAndroidUpdateState, subscribeAndroidUpdates,
  checkAndroidUpdate, installAndroidUpdate, dismissAndroidUpdate,
} from "@/lib/androidUpdater";

/** Mounted above auth so an outdated App can update even without a working Hub. */
export function AndroidUpdateNotification({ inline = false }: { inline?: boolean }) {
  const state = useSyncExternalStore(subscribeAndroidUpdates, getAndroidUpdateState, getAndroidUpdateState);
  const android = isAndroidApp();
  useEffect(() => {
    if (!android || inline) return;
    const timer = setTimeout(() => void checkAndroidUpdate(true), 5000);
    const onForeground = () => { if (document.visibilityState === "visible") void checkAndroidUpdate(true); };
    document.addEventListener("visibilitychange", onForeground);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onForeground); };
  }, [android, inline]);
  if (!android || (!inline && (state.dismissed || !state.version))) return null;
  const button = { border: `1px solid ${colors.border}`, background: colors.surface, color: colors.foreground,
    padding: "10px 12px", borderRadius: 6, fontSize: 13, minHeight: 44, cursor: "pointer" };
  return <div data-testid={inline ? "android-update-settings" : "android-update-toast"}
    style={{ ...(inline ? {} : { position: "fixed" as const, right: 12, left: 12, bottom: "max(12px, env(safe-area-inset-bottom))", zIndex: 10000, boxShadow: "0 4px 24px #0004" }),
      padding: 12, borderRadius: 8, background: colors.surface, color: colors.foreground, fontSize: 13 }}>
    <div role="status" aria-live="polite">{state.busy === "checking" ? "Checking for updates…" : state.busy === "installing" ? "Preparing update… Confirm on Android and wait for the download." : state.version ? `Offdesk ${state.version} is available` : "Android app updates"}</div>
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert" style={{ overflowWrap: "anywhere" }}>{state.error}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {state.version && <button type="button" style={button} disabled={!!state.busy} onClick={() => void installAndroidUpdate()}>Install update</button>}
      {inline && <button type="button" style={button} disabled={!!state.busy} onClick={() => void checkAndroidUpdate()}>Check for updates</button>}
      {!inline && <button type="button" style={button} disabled={!!state.busy} onClick={dismissAndroidUpdate}>Later</button>}
    </div>
  </div>;
}
