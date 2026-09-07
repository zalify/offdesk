import { isSecureConnection, secureFetch } from "./secureTransport";
import type {
  User,
  BrowserStateSnapshot,
  MachineInfo,
  TerminalInfo,
  DirEntry,
  Bookmark,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
  WorkspaceLayoutNode,
  ResourceStats,
} from "@offdesk/shared";

import { generateDeviceId } from "./deviceIdShared";

let _baseUrl = "";
let _token: string | null = null;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`${status}: ${message}`);
  }
}

export function configure(baseUrl: string, token: string | null) {
  _baseUrl = baseUrl;
  _token = token;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const url = `${_baseUrl}${path}`;
  const res = isSecureConnection()
    ? await secureFetch(method, path, body ? JSON.stringify(body) : undefined, signal)
    : await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// Auth
export const getMe = (signal?: AbortSignal) => request<User>("GET", "/api/auth/me", undefined, signal);
export const devLogin = () =>
  request<{ token: string }>("GET", "/api/auth/dev");

/** Which ways into this hub exist. `link` means no OAuth app is configured:
 * the hub prints a sign-in link on start, and signed-in users can mint one. */
export interface AuthProviders {
  github: boolean;
  google: boolean;
  link: boolean;
}
export const getAuthProviders = () =>
  request<AuthProviders>("GET", "/api/auth/providers");

/** A fresh session for the current user, to carry to another device. */
export const mintSessionToken = () =>
  request<{ token: string }>("POST", "/api/auth/session-token");
// A short code for a QR: ten characters instead of a session token's three
// hundred, redeemed once, within fifteen minutes.
export const mintLoginCode = () =>
  request<{ code: string; expires_at: number }>("POST", "/api/auth/login-code");
// Public: no token yet, that is the point. Called on the raw base URL.
export async function redeemLoginCode(baseUrl: string, code: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

// API Tokens
export interface ApiToken {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}
export interface CreatedApiToken {
  id: string;
  name: string;
  token: string;
  created_at: number;
}
export const listApiTokens = () =>
  request<ApiToken[]>("GET", "/api/auth/api-tokens");
export const createApiToken = (name: string) =>
  request<CreatedApiToken>("POST", "/api/auth/api-tokens", { name });
export const deleteApiToken = (id: string) =>
  request<void>("DELETE", `/api/auth/api-tokens/${id}`);

// Machines
export const listMachines = () =>
  request<MachineInfo[]>("GET", "/api/machines");
export const deleteMachine = (machineId: string) =>
  request<void>("DELETE", `/api/machines/${machineId}`);
export const getBootstrap = () =>
  request<BrowserStateSnapshot>("GET", "/api/bootstrap");
export const putFocus = (terminalId: string, machineId: string) =>
  request<void>("PUT", "/api/focus", {
    terminal_id: terminalId,
    machine_id: machineId,
  });

// Terminals
export const listTerminals = () =>
  request<TerminalInfo[]>("GET", "/api/terminals");
export const createTerminal = (
  machineId: string,
  cwd: string,
  deviceId?: string,
  startupCommand?: string,
  cols?: number,
  rows?: number,
  workspaceGroupId?: string | null,
) =>
  request<TerminalInfo>("POST", `/api/machines/${machineId}/terminals`, {
    cwd,
    device_id: deviceId,
    ...(startupCommand ? { startup_command: startupCommand } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(workspaceGroupId ? { workspace_group_id: workspaceGroupId } : {}),
  });
export const destroyTerminal = (
  machineId: string,
  terminalId: string,
  deviceId?: string,
) =>
  request<void>(
    "DELETE",
    `/api/machines/${machineId}/terminals/${terminalId}${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,
  );
export const checkForegroundProcess = (
  machineId: string,
  terminalId: string,
) =>
  request<{ has_foreground_process: boolean; process_name: string | null }>(
    "GET",
    `/api/machines/${machineId}/terminals/${terminalId}/foreground-process`,
  );

// Directory
export const listDirectory = (machineId: string, path: string) =>
  request<DirEntry[]>(
    "GET",
    `/api/machines/${machineId}/fs/list?path=${encodeURIComponent(path)}`,
  );

// Bookmarks
export const listBookmarks = (machineId: string) =>
  request<Bookmark[]>("GET", `/api/machines/${machineId}/bookmarks`);
export const createBookmark = (
  machineId: string,
  path: string,
  label: string,
) =>
  request<Bookmark>("POST", `/api/machines/${machineId}/bookmarks`, {
    path,
    label,
  });
export const deleteBookmark = (bookmarkId: string) =>
  request<void>("DELETE", `/api/bookmarks/${bookmarkId}`);

// Workspace tabs
export const listWorkspaceGroups = (machineId: string) =>
  request<WorkspaceGroupInfo[]>(
    "GET",
    `/api/machines/${machineId}/workspace-groups`,
  );
export const createWorkspaceGroup = (machineId: string, name: string) =>
  request<WorkspaceGroupInfo>(
    "POST",
    `/api/machines/${machineId}/workspace-groups`,
    { name },
  );
export const reorderWorkspaceGroups = (machineId: string, groupIds: string[]) =>
  request<WorkspaceGroupInfo[]>(
    "PUT",
    `/api/machines/${machineId}/workspace-groups/order`,
    { group_ids: groupIds },
  );
export const deleteWorkspaceGroup = (machineId: string, groupId: string) =>
  request<void>(
    "DELETE",
    `/api/machines/${machineId}/workspace-groups/${groupId}`,
  );
export const renameWorkspaceGroup = (
  machineId: string,
  groupId: string,
  name: string,
) =>
  request<WorkspaceGroupInfo>(
    "PATCH",
    `/api/machines/${machineId}/workspace-groups/${groupId}`,
    { name },
  );
export const assignTerminalWorkspaceGroup = (
  machineId: string,
  terminalId: string,
  workspaceGroupId: string | null,
) =>
  request<TerminalInfo>(
    "PUT",
    `/api/machines/${machineId}/terminals/${terminalId}/workspace-group`,
    { workspace_group_id: workspaceGroupId },
  );
export const saveWorkspaceLayout = (
  machineId: string,
  groupKey: string,
  root: WorkspaceLayoutNode | null,
  baseUpdatedAt: number | null,
) =>
  request<WorkspaceLayoutInfo>(
    "PUT",
    `/api/machines/${machineId}/workspace-layouts`,
    {
      group_key: groupKey,
      root,
      base_updated_at: baseUpdatedAt ?? -1,
    },
  );

// Registration
export const createRegistrationToken = (name: string) =>
  request<{ token: string; expires_at: number }>("POST", "/api/machines/register-token", { name });

// Device ID
export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  let id = sessionStorage.getItem('tc-device-id');
  if (!id) {
    id = generateDeviceId();
    sessionStorage.setItem('tc-device-id', id);
  }
  return id;
}

// Mode
export const getMode = (machineId: string) =>
  request<{ controller_device_id: string | null }>(
    "GET",
    `/api/mode?machine_id=${encodeURIComponent(machineId)}`,
  );
export const requestControl = (machineId: string, deviceId: string) =>
  request<{ controller_device_id: string | null }>("POST", "/api/mode/control", {
    machine_id: machineId,
    device_id: deviceId,
  });
export const releaseControl = (machineId: string, deviceId: string) =>
  request<{ controller_device_id: string | null }>("POST", "/api/mode/release", {
    machine_id: machineId,
    device_id: deviceId,
  });
export function releaseControlKeepalive(
  machineId: string,
  deviceId: string,
): void {
  if (!_token) {
    return;
  }
  if (isSecureConnection()) {
    void request("POST", "/api/mode/release", { machine_id: machineId, device_id: deviceId }).catch(() => {});
    return;
  }

  const body = JSON.stringify({
    machine_id: machineId,
    device_id: deviceId,
  });
  const url =
    `${_baseUrl}/api/mode/release-beacon?token=${encodeURIComponent(_token)}`;
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    const queued = navigator.sendBeacon(
      url,
      new Blob([body], { type: "application/json" }),
    );
    if (queued) {
      return;
    }
  }

  void fetch(url, {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
    },
    body,
  }).catch(() => {
    /* ignore unload races */
  });
}

// Machine Stats
export const getMachineStats = (machineId: string) =>
  request<ResourceStats>("GET", `/api/machines/${machineId}/stats`);

// Settings
export const getSettings = () =>
  request<{ settings: Record<string, string> }>("GET", "/api/settings");
export const updateSettings = (settings: Record<string, string>) =>
  request<{ settings: Record<string, string> }>("PUT", "/api/settings", { settings });

// WebSocket URLs
export function terminalWsUrl(
  machineId: string,
  terminalId: string,
  deviceId?: string,
): string {
  const base = _baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (_token) params.set("token", _token);
  if (deviceId) params.set("device_id", deviceId);
  // deflate-raw-v1 request: the hub acks only if the machine also supports
  // it; old hubs ignore the param and the stream stays uncompressed.
  // Escape hatch: localStorage "offdesk:compress" === "off".
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("offdesk:compress") !== "off"
  ) {
    params.set("compress", "deflate-raw-v1");
  }
  const qs = params.toString();
  return `${base}/ws/terminal/${machineId}/${terminalId}${qs ? '?' + qs : ''}`;
}

export function terminalPreviewsWsUrl(deviceId?: string): string {
  const base = _baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (_token) params.set("token", _token);
  if (deviceId) params.set("device_id", deviceId);
  const qs = params.toString();
  return `${base}/ws/terminal-previews${qs ? '?' + qs : ''}`;
}

export function eventsWsUrl(deviceId?: string, afterSeq?: number): string {
  const base = _baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (_token) params.set("token", _token);
  if (deviceId) params.set("device_id", deviceId);
  if (afterSeq && afterSeq > 0) params.set("after_seq", String(afterSeq));
  const qs = params.toString();
  return `${base}/ws/events${qs ? '?' + qs : ''}`;
}


export interface WebPreviewInfo { id: string; machine_id: string; port: number; url: string; expires_at: number }
export function getBaseUrl(): string { return _baseUrl; }
export const createWebPreview = (machineId: string, body: { port: number; address_family: "ipv4" | "ipv6"; target: string; terminal_id?: string }) =>
  request<{ preview: WebPreviewInfo; launch_url: string }>("POST", `/api/machines/${encodeURIComponent(machineId)}/web-previews`, body);
export const listWebPreviews = () => request<{ configured: boolean; previews: WebPreviewInfo[] }>("GET", "/api/web-previews");
export const closeWebPreview = (id: string) => request<void>("DELETE", `/api/web-previews/${encodeURIComponent(id)}`);

// E2EE device management; requests follow the current encrypted/direct transport.
export interface SecureDevice {
  id: string; name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null;
}
export const listSecureDevices = () => request<SecureDevice[]>("GET", "/api/security/devices");
export const revokeSecureDevice = (id: string) => request<void>("DELETE", `/api/security/devices/${encodeURIComponent(id)}`);
