// The desktop app as the machine that stays on: what the Tauri side offers
// (packages/desktop/src-tauri/src/role.rs), typed, plus the two small
// parsers the screens need. Nothing here runs outside the desktop shell.

import { isTauri, isTauriMobile } from "./platform";

export type DesktopRole = "hub" | "client";

export interface HubStatus {
  supported: boolean;
  bundled: boolean;
  hub_installed: boolean;
  node_installed: boolean;
  listening: boolean;
  // Optional only for compatibility with shells released before diagnostics.
  setup?: {
    hub_running: boolean;
    machine_registered: boolean;
    node_online: boolean;
    tmux_available: boolean;
    error?: string | null;
  };
}

export interface HubCandidate {
  interface: string;
  address: string;
}

export interface HubLink {
  url: string;
  link: string | null;
  short: string | null;
  candidates: HubCandidate[];
  public_url?: string | null;
  local_url?: string | null;
  secure_url?: string | null;
}

/** The desktop app, as opposed to the phone app or a browser tab. */
export function isDesktopShell(): boolean {
  return isTauri() && !isTauriMobile();
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const desktopRole = () => invoke<DesktopRole | null>("desktop_role");
export const setDesktopRole = (role: DesktopRole) => invoke<void>("set_desktop_role", { role });
export const hubStatus = () => invoke<HubStatus>("hub_status");
export const hubLink = (baseUrl?: string) => invoke<HubLink>("hub_link", { baseUrl: baseUrl ?? null });
export const hubInstall = (baseUrl?: string) => invoke<HubLink>("hub_install", { baseUrl: baseUrl ?? null });
export const hubUninstall = () => invoke<void>("hub_uninstall");

/** Modern shells verify the registered node is live, not just a listening port. */
export function hubIsReady(status: HubStatus): boolean {
  const setup = status.setup;
  return status.hub_installed && status.node_installed && status.listening &&
    (!setup || (setup.hub_running && setup.machine_registered && setup.node_online && setup.tmux_available));
}

/** The `?token=` on a sign-in link, or null when the link has none. */
export function tokenFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).searchParams.get("token");
  } catch {
    return null;
  }
}

/** The `?code=` a scanned or pasted short link carries. */
export function codeFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).searchParams.get("code");
  } catch {
    return null;
  }
}

/** The hub's port, from the address it reports; 4317 when it says nothing. */
export function portOf(url: string): string {
  try {
    return new URL(url).port || "4317";
  } catch {
    return "4317";
  }
}

/** An address from the picker becomes the base URL the hub is asked for. */
export function baseUrlFor(address: string, port: string): string {
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** Preserve the public URL's scheme and port; LAN uses the local hub port. */
export function hubAddressOptions(link: HubLink): { url: string; label: string }[] {
  const options = new Map<string, string>();
  if (link.public_url) options.set(link.public_url, "Internet");
  const port = portOf(link.local_url ?? (link.public_url ? "" : link.url));
  for (const candidate of link.candidates) {
    options.set(baseUrlFor(candidate.address, port), candidate.interface);
  }
  if (!options.has(link.url)) options.set(link.url, "Current address");
  return [...options].map(([url, label]) => ({ url, label }));
}
