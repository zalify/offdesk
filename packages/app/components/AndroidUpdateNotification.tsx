import { useEffect, useState, useSyncExternalStore } from "react";
import { colors } from "@/lib/colors";
import {
  isAndroidApp, getAndroidUpdateState, subscribeAndroidUpdates,
  checkAndroidUpdate, installAndroidUpdate, dismissAndroidUpdate,
} from "@/lib/androidUpdater";
import { AppUpdateCard } from "./AppUpdateCard.web";
import { rem } from "@/lib/rem";

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
  const [current, setCurrent] = useState<string | null>(null);
  const showCard = android && !inline && !state.dismissed && !!state.version;
  useEffect(() => {
    if (!showCard) return;
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setCurrent).catch(() => {});
  }, [showCard]);
  if (!android || (!inline && (state.dismissed || !state.version))) return null;
  const progress = state.busy === "installing" ? "Preparing update… Confirm on Android and wait for the download." : null;
  if (!inline && state.version) {
    // P02. The plugin reports a version but no release notes, so the card
    // says only what the install does.
    const status = progress ?? state.message;
    return <AppUpdateCard
      testId="android-update-toast"
      version={state.version}
      current={current}
      note="Signed and checked before it installs; pairing is kept."
      status={status || state.error ? <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-sans)", fontSize: rem(13), lineHeight: rem(20), color: colors.fg1 }}>
        {status ? <span role="status">{status}</span> : null}
        {state.error ? <span role="alert" style={{ color: colors.err, overflowWrap: "anywhere" }}>{state.error}</span> : null}
      </div> : null}
      actionLabel={state.busy === "installing" ? "installing…" : "install"}
      busy={!!state.busy}
      onAction={() => void installAndroidUpdate()}
      onLater={dismissAndroidUpdate}
    />;
  }
  const button = { border: `1px solid ${colors.line}`, background: "transparent", color: colors.fg0,
    padding: "0 14px", borderRadius: 4, fontFamily: "var(--font-display)", fontSize: rem(13), fontWeight: 500, minHeight: 44, cursor: "pointer", textTransform: "lowercase" as const };
  const primary = { ...button, border: "none", background: colors.primary, color: colors.onPrimary, fontWeight: 600 };
  return <div data-testid="android-update-settings"
    style={{ padding: "12px 0", borderRadius: 6, background: "transparent", color: colors.fg0, fontFamily: "var(--font-display)", fontSize: rem(13) }}>
    <div role="status" aria-live="polite">{state.busy === "checking" ? "Checking for updates…" : progress ?? (state.version ? `offdesk/dev ${state.version} is ready` : "Android app updates")}</div>
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert" style={{ overflowWrap: "anywhere" }}>{state.error}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {state.version && <button type="button" style={primary} disabled={!!state.busy} onClick={() => void installAndroidUpdate()}>Install update</button>}
      <button type="button" style={button} disabled={!!state.busy} onClick={() => void checkAndroidUpdate()}>Check for updates</button>
    </div>
  </div>;
}
