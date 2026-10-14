// P03: versions in the phone's Machines sheet. The phone cannot update a
// Mac, so it only says which nodes are behind and hands over the command to
// run there. A hub from before 0.23 has no version endpoints: then the sheet
// shows nothing extra and says nothing about it.

import { useEffect, useState } from "react";
import { getHubVersion, getMachineVersions, type HubVersionInfo, type MachineVersionInfo } from "./api";
import { FIRST_VERSIONED_HUB, hubHost } from "./hubVersionCheck";
import { savedHubs, secureConnectionStatus } from "./secureTransport";
import { getServerUrl } from "./serverUrl";

export const NODE_UPDATE_COMMAND = "curl -fsSL https://offdesk.dev/install | sh -s -- --node-only";

export interface SheetVersions {
  hub: HubVersionInfo;
  machines: Record<string, MachineVersionInfo>;
}

/** Both answers, or null — a half-known picture is not worth drawing. */
export async function loadSheetVersions(
  hub: () => Promise<HubVersionInfo> = getHubVersion,
  machines: () => Promise<MachineVersionInfo[]> = getMachineVersions,
): Promise<SheetVersions | null> {
  try {
    const [hubVersion, nodes] = await Promise.all([hub(), machines()]);
    if (typeof hubVersion?.hub !== "string" || !Array.isArray(nodes)) return null;
    return { hub: hubVersion, machines: Object.fromEntries(nodes.map((node) => [node.id, node])) };
  } catch {
    return null;
  }
}

/** "node 0.23.0", "node older than 0.23", or nothing for a node the hub did
 * not list (offline). */
export function nodeVersionLabel(node: MachineVersionInfo | undefined): string | null {
  if (!node) return null;
  return node.version ? `node ${node.version}` : `node older than ${FIRST_VERSIONED_HUB}`;
}

/** "↑ 0.24.0" when the node is behind a known release. */
export function nodeUpdateChip(node: MachineVersionInfo | undefined, latest: string | null): string | null {
  return node?.update_available && latest ? `↑ ${latest}` : null;
}

export const anyNodeBehind = (versions: SheetVersions | null) =>
  !!versions && Object.values(versions.machines).some((node) => node.update_available);

/** What the sheet calls the hub: the name an encrypted pairing was saved
 * under, else the hub's host. */
export async function currentHubName(): Promise<string> {
  const status = secureConnectionStatus();
  if (status) {
    const { public_key: key, hub_url: url } = status.endpoint;
    try {
      const saved = (await savedHubs()).find((hub) => hub.status.endpoint.public_key === key);
      if (saved && saved.name.trim() && saved.name !== url) return saved.name;
    } catch {
      // The host below is still a fine name.
    }
    return hubHost(url);
  }
  return hubHost(getServerUrl() || window.location.origin);
}

/** Asked each time the sheet opens; nodes come and go and update. */
export function useSheetVersions(open: boolean): { versions: SheetVersions | null; hubName: string | null } {
  const [versions, setVersions] = useState<SheetVersions | null>(null);
  const [hubName, setHubName] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadSheetVersions().then(async (result) => {
      const name = result ? await currentHubName().catch(() => null) : null;
      if (cancelled) return;
      setVersions(result);
      setHubName(name);
    });
    return () => { cancelled = true; };
  }, [open]);
  return { versions, hubName };
}

/** The app's clipboard where there is one (the phone app), else the
 * browser's. A hub on plain http at home is not a secure context, so the
 * browser has no clipboard API there; the old copy command still works. */
export async function copyNodeUpdateCommand(): Promise<void> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(NODE_UPDATE_COMMAND);
    return;
  } catch {
    // Not the app: the browser's clipboard below.
  }
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(NODE_UPDATE_COMMAND);
    return;
  }
  const field = document.createElement("textarea");
  field.value = NODE_UPDATE_COMMAND;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.focus();
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy was refused");
  } finally {
    field.remove();
  }
}
