import { isSecureConnection, forgetSecureConnection } from "./secureTransport";
import { useCallback, useRef, useState } from "react";

/** Navigation belongs to the native shell, which also forgets the saved hub. */
export function useMobileHubSwitch() {
  const pending = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchHub = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setSwitching(true);
    setError(null);
    try {
      // Browser confirm dialogs are not available in every mobile WebView.
      // The labelled Switch hub action already expresses the user's intent.
      const { invoke } = await import("@tauri-apps/api/core");
      if (isSecureConnection()) await forgetSecureConnection();
      await invoke("clear_mobile_hub_url");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Please try again.";
      setError(`Could not switch hubs. ${detail}`);
    } finally {
      pending.current = false;
      setSwitching(false);
    }
  }, []);
  return { switchHub, switching, error };
}
