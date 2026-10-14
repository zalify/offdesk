// P01: before a browser code (a sign-in link, not `offdesk://pair`) hands
// the phone app's WebView to a hub, ask the hub's version. That WebView then
// shows the interface built into the hub, so a hub older than the one this
// app was built with would quietly show an older interface. Encrypted
// pairing keeps the app's own interface and needs none of this.

import { compareMinor } from "./versions";

/** What native `probe_hub_version` reports. `hub` is null for a hub from
 * before 0.23, which has no /api/version; `latest` is the newest hub release
 * as that hub knows it; `expected` is the hub version this app was built
 * with (the repo's Cargo version, not the app's). */
export interface HubProbe {
  hub: string | null;
  latest?: string | null;
  expected: string;
}

/** `target` is the hub version the notice asks for. */
export type PlainScanVerdict =
  | { kind: "open" }
  | { kind: "older"; hub: string | null; target: string };

/** The first hub that answers /api/version. */
export const FIRST_VERSIONED_HUB = "0.23";
const FIRST_VERSIONED_HUB_FULL = `${FIRST_VERSIONED_HUB}.0`;

/** The hub version worth asking for: what this app was built with, but
 * never past the newest release (an app built from main is ahead of it). */
export function targetHubVersion(expected: string, latest: string | null | undefined): string {
  if (!latest) return expected;
  const order = compareMinor(latest, expected);
  return order !== null && order < 0 ? latest : expected;
}

/** Only a hub at least a minor version behind gets the notice, and nothing
 * that can't be compared does. A hub without /api/version is behind only
 * once this app expects one that has it: an app built at 0.22 must not send
 * every 0.22 hub (which answers 404) to update to 0.22. No answer at all
 * (offline, timed out, an odd reply) opens the hub as before — the check
 * explains a mismatch, it never stands between someone and a hub. */
export function plainScanVerdict(probe: HubProbe | null): PlainScanVerdict {
  if (!probe) return { kind: "open" };
  const target = targetHubVersion(probe.expected, probe.latest);
  if (probe.hub === null) {
    const order = compareMinor(probe.expected, FIRST_VERSIONED_HUB_FULL);
    return order !== null && order >= 0 ? { kind: "older", hub: null, target } : { kind: "open" };
  }
  const order = compareMinor(probe.hub, target);
  return order !== null && order < 0 ? { kind: "older", hub: probe.hub, target } : { kind: "open" };
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
