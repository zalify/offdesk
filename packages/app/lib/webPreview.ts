import * as api from "./api";
import { isTauri } from "./platform";

export interface LocalPreview {
  port: number;
  address_family: "ipv4" | "ipv6";
  target: string;
}

export function parseLocalPreview(value: string): LocalPreview | null {
  // Check the input authority before URL normalizes unusual IPv4 spellings.
  if (!/^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) return null;
  try {
    const url = new URL(value);
    const port = Number(url.port || 80);
    if (url.username || url.password || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port, address_family: url.hostname === "[::1]" ? "ipv6" : "ipv4", target: url.pathname + url.search + url.hash };
  } catch { return null; }
}

export function launcherUrl(base: string, machine: string, terminal: string, local: LocalPreview): string {
  const url = new URL("/__offdesk_preview__/launch", base || window.location.origin);
  url.search = new URLSearchParams({ machine, terminal, port: String(local.port), family: local.address_family, target: local.target }).toString();
  return url.href;
}

async function nativeOpen(url: string): Promise<void> {
  const bridge = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!bridge) throw new Error("Could not open your browser. Please update the offdesk app.");
  for (const [cmd, args] of [["plugin:opener|open_url", { url }], ["plugin:shell|open", { path: url }]] as const) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([bridge.invoke(cmd, args), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 2500); })]);
      return;
    } catch { /* Never display or log a launch URL or native error containing its code. */ }
    finally { clearTimeout(timer); }
  }
  throw new Error("Could not open your browser. Please update the offdesk app and try again.");
}

export async function openWebPreview(machine: string, terminal: string, local: LocalPreview): Promise<string | undefined> {
  if (!isTauri()) {
    // Remain inside the click's user activation. This trusted Hub page uses
    // that browser's Hub login; it does not put the Bearer in a URL.
    const url = launcherUrl(api.getBaseUrl(), machine, terminal, local);
    // noopener can return null even on success. Always retain a safe retry link.
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* The caller displays the link. */ }
    return url;
  }
  const created = await api.createWebPreview(machine, { ...local, terminal_id: terminal });
  try { await nativeOpen(created.launch_url); }
  catch (error) { await api.closeWebPreview(created.preview.id).catch(() => {}); throw error; }
}
