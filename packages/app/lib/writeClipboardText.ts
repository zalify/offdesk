import { isTauri } from "./platform";

/** Call from a user copy gesture. Mirrors the terminal's native clipboard path. */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (internals?.invoke) {
      try {
        // Use IPC directly: the dynamically imported plugin can silently fail
        // to reach macOS WKWebView's clipboard (see TerminalView.xterm.tsx).
        await internals.invoke("plugin:clipboard-manager|write_text", { text });
        return;
      } catch { /* Older shells can fall back to the browser clipboard. */ }
    }
  }
  await navigator.clipboard.writeText(text);
}
