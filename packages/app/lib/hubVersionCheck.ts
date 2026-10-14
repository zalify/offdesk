// P01: before a browser code (a sign-in link, not `offdesk://pair`) hands
// the phone app's WebView to a hub, ask the hub's version. That WebView then
// shows the interface built into the hub, so a hub older than the one this
// app was built with would quietly show an older interface. Encrypted
// pairing keeps the app's own interface and needs none of this.

import { isOlder } from "./versions";

/** What native `probe_hub_version` reports. `hub` is null for a hub from
 * before 0.23, which has no /api/version; `expected` is the hub version this
 * app was built with (the repo's Cargo version, not the app's). */
export interface HubProbe {
  hub: string | null;
  expected: string;
}

export type PlainScanVerdict =
  | { kind: "open" }
  | { kind: "older"; hub: string | null; expected: string };

/** The first hub that answers /api/version. */
export const FIRST_VERSIONED_HUB = "0.23";

/** No answer (offline, timed out, an odd reply) opens the hub as before:
 * the check explains a mismatch, it never stands between someone and a hub
 * it cannot judge. */
export function plainScanVerdict(probe: HubProbe | null): PlainScanVerdict {
  if (!probe) return { kind: "open" };
  if (probe.hub === null) return { kind: "older", hub: null, expected: probe.expected };
  if (isOlder(probe.hub, probe.expected)) return { kind: "older", hub: probe.hub, expected: probe.expected };
  return { kind: "open" };
}

/** Ask natively: the bundled screen's origin is not one every hub answers. */
export async function probeHubVersion(url: string): Promise<HubProbe | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<HubProbe>("probe_hub_version", { url });
  } catch {
    // Includes an app shell from before the command existed.
    return null;
  }
}

/** "mac-mini.local" out of whatever was scanned; the raw text if it is not a URL. */
export function hubHost(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).hostname || url;
  } catch {
    return url;
  }
}

/** The hub's interface version as the screen names it. */
export const hubInterfaceLabel = (hub: string | null) => hub ?? `older than ${FIRST_VERSIONED_HUB}`;
