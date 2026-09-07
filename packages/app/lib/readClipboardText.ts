import { isTauri } from "./platform";

/** Invoke only from a user paste gesture, never while rendering or polling. */
export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__?: { invoke: <T>(cmd: string) => Promise<T> };
    }).__TAURI_INTERNALS__;
    if (internals?.invoke) {
      try {
        const text = await internals.invoke<string>("plugin:clipboard-manager|read_text");
        return typeof text === "string" ? text : "";
      } catch { /* Older shells can fall back to the browser clipboard. */ }
    }
  }
  return navigator.clipboard.readText();
}
