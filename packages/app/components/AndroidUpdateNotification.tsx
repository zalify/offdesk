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
  const button = { border: `1px solid ${colors.line}`, background: "transparent", color: colors.fg0,
    padding: "0 14px", borderRadius: 4, fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 500, minHeight: 44, cursor: "pointer", textTransform: "lowercase" as const };
  const primary = { ...button, border: "none", background: colors.primary, color: colors.onPrimary, fontWeight: 600 };
  return <div data-testid={inline ? "android-update-settings" : "android-update-toast"}
    style={{ ...(inline ? {} : { position: "fixed" as const, right: 12, left: 12, bottom: "max(12px, env(safe-area-inset-bottom))", zIndex: 10000, boxShadow: "0 24px 64px rgb(0 0 0 / .45)", border: `1px solid ${colors.line}` }),
      padding: inline ? "12px 0" : "14px 16px", borderRadius: 6, background: inline ? "transparent" : colors.bg2, color: colors.fg0, fontFamily: "var(--font-display)", fontSize: 13 }}>
    <div role="status" aria-live="polite">{state.busy === "checking" ? "Checking for updates…" : state.busy === "installing" ? "Preparing update… Confirm on Android and wait for the download." : state.version ? `offdesk/dev ${state.version} is ready` : "Android app updates"}</div>
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert" style={{ overflowWrap: "anywhere" }}>{state.error}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {state.version && <button type="button" style={primary} disabled={!!state.busy} onClick={() => void installAndroidUpdate()}>Install update</button>}
      {inline && <button type="button" style={button} disabled={!!state.busy} onClick={() => void checkAndroidUpdate()}>Check for updates</button>}
      {!inline && <button type="button" style={{ ...button, border: "none", color: colors.fg2 }} disabled={!!state.busy} onClick={dismissAndroidUpdate}>Later</button>}
    </div>
  </div>;
}
