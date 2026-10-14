import { useEffect, useSyncExternalStore } from "react";
import {
  checkIosUpdate, dismissIosUpdate, getIosUpdateState, isIosApp, openTestFlight, subscribeIosUpdates,
} from "@/lib/iosUpdates";
import { AppUpdateCard } from "./AppUpdateCard.web";

/** P02 on iPhone: TestFlight has no in-app check, so a newer `ios-v*`
 * release on GitHub is the signal, and TestFlight does the install. */
export function IosUpdateNotification() {
  const state = useSyncExternalStore(subscribeIosUpdates, getIosUpdateState, getIosUpdateState);
  const ios = isIosApp();
  useEffect(() => {
    if (!ios) return;
    // Same pacing as Android: after launch has settled, and again on coming
    // back to the foreground (the day-long cache keeps that to one request).
    const timer = setTimeout(() => void checkIosUpdate(), 5000);
    const onForeground = () => { if (document.visibilityState === "visible") void checkIosUpdate(); };
    document.addEventListener("visibilitychange", onForeground);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onForeground); };
  }, [ios]);
  if (!ios || !state.version) return null;
  return <AppUpdateCard
    testId="ios-update-toast"
    version={state.version}
    current={state.current}
    note="Installs from TestFlight; pairing is kept."
    actionLabel="open TestFlight"
    onAction={() => void openTestFlight()}
    onLater={() => dismissIosUpdate()}
  />;
}
