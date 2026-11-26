import { isSecureConnection, secureFetch } from "./secureTransport";
import type {
  User,
  AgentRunInfo,
  BrowserStateSnapshot,
  CreateSpaceRequest,
  MachineInfo,
  SpaceInfo,
  TerminalInfo,
  DirEntry,
  Bookmark,
  UpdateSpaceRequest,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
  WorkspaceLayoutNode,
  ResourceStats,
  AgentBrowserInfo,
  AgentBrowserControlRequest,
  TokenAccess,
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

// Agent Scratchpad Drafts
export interface DraftInfo {
  id: string;
  user_id: string;
  title: string;
  content: string;
  project_group: string;
  source_terminal_id: string | null;
  space_id?: string | null;
  pinned: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
  /** Explicit + inline tag paths. Absent on hubs without tag support. */
  tags?: string[];
  /** Subset of `tags` that only comes from `#tag` in the body. */
  inline_tags?: string[];
}

export const listDrafts = (options?: {
  project?: string;
  spaceId?: string | null;
  includeArchived?: boolean;
}) => {
  const qs = new URLSearchParams();
  if (options?.project) qs.set("project", options.project);
  if (options?.spaceId) qs.set("space_id", options.spaceId);
  if (options?.includeArchived) qs.set("include_archived", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<DraftInfo[]>("GET", `/api/drafts${suffix}`);
};

export const upsertDraft = (payload: {
  title: string;
  content: string;
  project_group?: string;
  source_terminal_id?: string | null;
  space_id?: string | null;
  pinned?: boolean;
  force_new?: boolean;
  tags?: string[];
}) => request<DraftInfo>("POST", "/api/drafts", payload);

export const updateDraft = (
  draftId: string,
  patch: {
    title?: string;
    content?: string;
    project_group?: string;
    space_id?: string | null;
    pinned?: boolean;
    archived?: boolean;
    /** Replaces the EXPLICIT tag set; omit to leave tags unchanged. */
    tags?: string[];
  },
) => request<DraftInfo>("PATCH", `/api/drafts/${encodeURIComponent(draftId)}`, patch);

export const deleteDraft = (draftId: string) =>
  request<void>("DELETE", `/api/drafts/${encodeURIComponent(draftId)}`);

// Draft public sharing + version history
export interface DraftShareAsset {
  source: string;
  ok: boolean;
  reason?: string;
}

export interface DraftShare {
  id: string;
  url: string;
  kind: "draft" | "database";
  target_id: string;
  target_title: string;
  mode: "snapshot" | "live";
  view_id: string | null;
  expires_at: number | null;
  created_at: number;
  assets: DraftShareAsset[];
}

export interface DraftVersionInfo {
  id: string;
  title: string;
  size: number;
  created_at: number;
}

export interface DraftVersion {
  id: string;
  draft_id: string;
  title: string;
  content: string;
  created_at: number;
}

/** Resolves to null when the hub predates sharing (404): hide all sharing UI. */
export async function listDraftShares(targetId?: string): Promise<DraftShare[] | null> {
  const suffix = targetId ? `?target_id=${encodeURIComponent(targetId)}` : "";
  try {
    return await request<DraftShare[]>("GET", `/api/draft-shares${suffix}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const createDraftShare = (payload: {
  kind: "draft" | "database";
  target_id: string;
  mode?: "snapshot" | "live";
  view_id?: string;
  expires_in_days?: number;
}) => request<DraftShare>("POST", "/api/draft-shares", payload);

export const revokeDraftShare = (shareId: string) =>
  request<void>("DELETE", `/api/draft-shares/${encodeURIComponent(shareId)}`);

const draftVersionsPath = (draftId: string) =>
  `/api/drafts/${encodeURIComponent(draftId)}/versions`;

/** Resolves to null on 404 (older hub): hide the history UI. */
export async function listDraftVersions(draftId: string): Promise<DraftVersionInfo[] | null> {
  try {
    return await request<DraftVersionInfo[]>("GET", draftVersionsPath(draftId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const getDraftVersion = (draftId: string, versionId: string) =>
  request<DraftVersion>("GET", `${draftVersionsPath(draftId)}/${encodeURIComponent(versionId)}`);

export const restoreDraftVersion = (draftId: string, versionId: string) =>
  request<DraftInfo>("POST", `${draftVersionsPath(draftId)}/${encodeURIComponent(versionId)}/restore`);

// Draft databases (Notion-style tables whose rows are drafts)
export type DraftDbColumnType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "url";

export interface DraftDbOption {
  name: string;
  color?: string;
}

export interface DraftDbColumn {
  id: string;
  name: string;
  type: DraftDbColumnType;
  options?: DraftDbOption[];
}

/** Column as sent in a PATCH: no id means a new column. */
export type DraftDbColumnInput = Omit<DraftDbColumn, "id"> & { id?: string };

export type DraftDbFilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_empty"
  | "is_not_empty";

export interface DraftDbFilter {
  column: string;
  op: DraftDbFilterOp;
  value?: unknown;
}

export interface DraftDbSort {
  column: string;
  dir: "asc" | "desc";
}

export interface DraftDbView {
  id: string;
  name: string;
  type: "table" | "board";
  filters: DraftDbFilter[];
  sorts: DraftDbSort[];
  group_by?: string;
  hidden_columns?: string[];
}

/** View as sent in a PATCH: no id means a new view. */
export type DraftDbViewInput = Omit<DraftDbView, "id"> & { id?: string };

export interface DraftDatabase {
  id: string;
  name: string;
  project_group: string;
  space_id?: string | null;
  columns: DraftDbColumn[];
  views: DraftDbView[];
  row_count: number;
  created_at: number;
  updated_at: number;
}

export type DraftDbValue = string | number | boolean | string[] | null;

export interface DraftDbRow {
  id: string;
  database_id: string;
  title: string;
  properties: Record<string, DraftDbValue>;
  has_content: boolean;
  created_at: number;
  updated_at: number;
}

export interface DraftDbRowFull extends DraftDbRow {
  content: string;
}

export interface DraftDbQueryBody {
  filters?: DraftDbFilter[];
  sorts?: DraftDbSort[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DraftDbQueryResult {
  rows: DraftDbRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface DraftDbRowPatch {
  title?: string;
  properties?: Record<string, DraftDbValue>;
  content?: string;
}

const dbPath = (id: string) => `/api/draft-databases/${encodeURIComponent(id)}`;

/** Resolves to null when the hub predates draft databases (404). */
export async function listDraftDatabases(
  project?: string,
  spaceId?: string | null,
): Promise<DraftDatabase[] | null> {
  const qs = new URLSearchParams();
  if (project) qs.set("project", project);
  if (spaceId) qs.set("space_id", spaceId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    return await request<DraftDatabase[]>("GET", `/api/draft-databases${suffix}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export const createDraftDatabase = (payload: {
  name: string;
  project_group?: string;
  space_id?: string | null;
  columns?: DraftDbColumnInput[];
  if_not_exists?: boolean;
}) => request<DraftDatabase>("POST", "/api/draft-databases", payload);

export const getDraftDatabase = (id: string) =>
  request<DraftDatabase>("GET", dbPath(id));

export const updateDraftDatabase = (
  id: string,
  patch: {
    name?: string;
    space_id?: string | null;
    columns?: DraftDbColumnInput[];
    views?: DraftDbViewInput[];
  },
) => request<DraftDatabase>("PATCH", dbPath(id), patch);

export const deleteDraftDatabase = (id: string) =>
  request<void>("DELETE", dbPath(id));

export const queryDraftDbRows = (
  id: string,
  body: DraftDbQueryBody,
  signal?: AbortSignal,
) => request<DraftDbQueryResult>("POST", `${dbPath(id)}/rows/query`, body, signal);

export const groupDraftDbRows = (
  id: string,
  body: { group_by: string; filters?: DraftDbFilter[]; search?: string },
) =>
  request<{ groups: Array<{ value: string | boolean | null; count: number }> }>(
    "POST",
    `${dbPath(id)}/rows/groups`,
    body,
  );

export const createDraftDbRows = (
  id: string,
  rows: Array<{ title: string; properties?: Record<string, DraftDbValue>; content?: string }>,
  onConflict: "update" | "create" = "update",
) =>
  request<{ rows: DraftDbRow[]; created: number; updated: number }>(
    "POST",
    `${dbPath(id)}/rows`,
    { rows, on_conflict: onConflict },
  );

export const getDraftDbRow = (id: string, rowId: string) =>
  request<DraftDbRowFull>("GET", `${dbPath(id)}/rows/${encodeURIComponent(rowId)}`);

export const patchDraftDbRow = (id: string, rowId: string, patch: DraftDbRowPatch) =>
  request<DraftDbRowFull>(
    "PATCH",
    `${dbPath(id)}/rows/${encodeURIComponent(rowId)}`,
    patch,
  );

export const deleteDraftDbRow = (id: string, rowId: string) =>
  request<void>("DELETE", `${dbPath(id)}/rows/${encodeURIComponent(rowId)}`);

export const deleteDraftDbRows = (id: string, ids: string[]) =>
  request<{ deleted: number }>("POST", `${dbPath(id)}/rows/delete`, { ids });

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
  /** Null: full access. */
  access?: TokenAccess | null;
}
export interface CreatedApiToken {
  id: string;
  name: string;
  token: string;
  created_at: number;
  access?: TokenAccess | null;
}
export const listApiTokens = () =>
  request<ApiToken[]>("GET", "/api/auth/api-tokens");
/** Without `access`, a full-access token (what the CLI uses). */
export const createApiToken = (name: string, access?: TokenAccess) =>
  request<CreatedApiToken>(
    "POST",
    "/api/auth/api-tokens",
    access ? { name, access } : { name },
  );
export const deleteApiToken = (id: string) =>
  request<void>("DELETE", `/api/auth/api-tokens/${id}`);

// Webhooks: agent run events sent to a URL
export interface Webhook {
  id: string;
  kind: string;
  name: string;
  url: string;
  /** Empty: every event. */
  events: string[];
  access: TokenAccess;
  enabled: boolean;
  created_at: number;
  last_delivery_at: number | null;
  last_error: string | null;
}
export interface NewWebhook {
  name: string;
  url: string;
  events: string[];
  content: "metadata" | "requests" | "notes" | "conversation";
  include_production: boolean;
}
export interface WebhookDelivery {
  id: number;
  event_id: string;
  event_type: string;
  attempts: number;
  created_at: number;
  delivered_at: number | null;
  failed_at: number | null;
  last_error: string | null;
}
export const listWebhooks = () => request<Webhook[]>("GET", "/api/integrations");
export const createWebhook = (webhook: NewWebhook) =>
  request<{ integration: Webhook; secret: string }>(
    "POST",
    "/api/integrations",
    webhook,
  );
export const setWebhookEnabled = (id: string, enabled: boolean) =>
  request<Webhook>("PATCH", `/api/integrations/${id}`, { enabled });
export const deleteWebhook = (id: string) =>
  request<void>("DELETE", `/api/integrations/${id}`);
export const testWebhook = (id: string) =>
  request<void>("POST", `/api/integrations/${id}/test`);
export const listWebhookDeliveries = (id: string) =>
  request<WebhookDelivery[]>("GET", `/api/integrations/${id}/deliveries`);

// Bridges: servers the hub keeps a connection to (docs/agent-bridge-protocol.md)
export interface Bridge extends Webhook {
  paired: boolean;
  connection: { connected: boolean; since_ms: number | null; last_error: string | null };
}
export interface NewBridge {
  name: string;
  url: string;
  pairing_code: string;
  scopes: TokenAccess["scopes"];
  content: "metadata" | "requests" | "notes" | "conversation";
  include_production: boolean;
  dirs?: string[];
}
export const listBridges = async () =>
  (await request<Bridge[]>("GET", "/api/integrations")).filter(
    (integration) => integration.kind === "bridge",
  );
export const createBridge = (bridge: NewBridge) =>
  request<{ integration: Bridge }>("POST", "/api/integrations", {
    kind: "bridge",
    ...bridge,
  });

// What tokens and bridges did, and were refused
export interface AuditEntry {
  token_id: string;
  token_name: string;
  action: string;
  target: string;
  result: string;
  at_ms: number;
}
export const listTokenAudit = () =>
  request<AuditEntry[]>("GET", "/api/auth/api-tokens/audit");

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
export const listDirectory = (
  machineId: string,
  path: string,
  opts?: { showHidden?: boolean },
) =>
  request<DirEntry[]>(
    "GET",
    `/api/machines/${machineId}/fs/list?path=${encodeURIComponent(path)}${
      opts?.showHidden ? "&show_hidden=true" : ""
    }`,
  );

// Remote file read (fetch a file from the machine to this device)
export interface RemoteFile {
  name: string;
  path: string;
  mime: string;
  size: number;
  data_base64: string;
  /** Content hash, from machines that can save files; editing needs it. */
  sha256?: string;
}

/** Error from `fs/read` or `fs/write`; `code` is the hub's error code (e.g. `too_large`). */
export class RemoteFileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly size?: number,
    public readonly path?: string,
    /** For `conflict`: the hash of what the file holds now. */
    public readonly sha256?: string,
  ) {
    super(message);
    this.name = "RemoteFileError";
  }
}

function remoteFileError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  // ApiError.message is "<status>: <body>"; the body is the hub's JSON.
  let body: { error?: string; message?: string; size?: number; path?: string; sha256?: string } = {};
  try {
    body = JSON.parse(err.message.slice(err.message.indexOf(":") + 1).trim());
  } catch {
    // Non-JSON body (proxy error page): fall through with a generic code.
  }
  // A hub that predates a route answers a bare 404: no JSON, so no `error`.
  // Real hub 404s always carry a code (`not_found`, `machine_not_found`, ...).
  const code =
    body.error ??
    (err.status === 504 ? "timeout" : err.status === 404 ? "hub_outdated" : `http_${err.status}`);
  return new RemoteFileError(
    err.status,
    code,
    body.message ?? err.message,
    body.size,
    body.path,
    body.sha256,
  );
}

export async function readFile(
  machineId: string,
  path: string,
  cwd?: string,
): Promise<RemoteFile> {
  const query =
    `path=${encodeURIComponent(path)}` +
    (cwd ? `&cwd=${encodeURIComponent(cwd)}` : "");
  try {
    return await request<RemoteFile>(
      "GET",
      `/api/machines/${machineId}/fs/read?${query}`,
    );
  } catch (err) {
    throw remoteFileError(err);
  }
}

/** Replace a text file on the machine, only while it still hashes to `baseSha256`. */
export async function writeFile(
  machineId: string,
  path: string,
  dataBase64: string,
  baseSha256: string,
): Promise<{ path: string; size: number; sha256: string }> {
  try {
    return await request("PUT", `/api/machines/${machineId}/fs/write`, {
      path,
      data_base64: dataBase64,
      base_sha256: baseSha256,
    });
  } catch (err) {
    throw remoteFileError(err);
  }
}

// File operations (`fs/op`), transfers and zip. Errors are RemoteFileError
// with `code` (`exists`, `invalid`, `machine_outdated`, ...), `status`, `path`.
export type FsConflictPolicy = "error" | "keep_both" | "replace";

export type FsOp =
  | { op: "mkdir"; path: string }
  | { op: "create_file"; path: string }
  | { op: "rename"; path: string; new_name: string }
  | { op: "trash"; paths: string[] }
  | { op: "copy"; sources: string[]; dest_dir: string; on_conflict?: FsConflictPolicy }
  | { op: "move"; sources: string[]; dest_dir: string; on_conflict?: FsConflictPolicy };

/** Runs one file operation; resolves to the resulting absolute paths. */
export async function fsOp(
  machineId: string,
  op: FsOp,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const res = await request<{ paths: string[] }>(
      "POST",
      `/api/machines/${machineId}/fs/op`,
      op,
      signal,
    );
    return res.paths;
  } catch (err) {
    throw remoteFileError(err);
  }
}

async function fsPost<T>(
  machineId: string,
  route: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await request<T>("POST", `/api/machines/${machineId}/fs/${route}`, body, signal);
  } catch (err) {
    throw remoteFileError(err);
  }
}

export const uploadBegin = (
  machineId: string,
  body: {
    dest_dir: string;
    filename: string;
    size: number;
    on_conflict: FsConflictPolicy;
    /** Offer positional chunks of exactly this size; the reply says if the node accepts them in any order. */
    chunk_bytes?: number;
  },
  signal?: AbortSignal,
) => fsPost<{ upload_id: string; parallel?: boolean }>(machineId, "upload/begin", body, signal);

export const uploadChunk = (
  machineId: string,
  uploadId: string,
  index: number,
  dataBase64: string,
  signal?: AbortSignal,
) =>
  fsPost<{ received: number }>(
    machineId,
    "upload/chunk",
    { upload_id: uploadId, index, data: dataBase64 },
    signal,
  );

export const uploadEnd = (machineId: string, uploadId: string, signal?: AbortSignal) =>
  fsPost<{ path: string; size: number }>(machineId, "upload/end", { upload_id: uploadId }, signal);

export const uploadAbort = (machineId: string, uploadId: string) =>
  fsPost<void>(machineId, "upload/abort", { upload_id: uploadId });

export interface RemoteRange {
  size: number;
  data_base64: string;
  eof: boolean;
}

/** Reads up to 4 MiB of a regular file starting at `offset`. */
export async function readRange(
  machineId: string,
  path: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RemoteRange> {
  const query = `path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`;
  try {
    return await request<RemoteRange>(
      "GET",
      `/api/machines/${machineId}/fs/read_range?${query}`,
      undefined,
      signal,
    );
  } catch (err) {
    throw remoteFileError(err);
  }
}

/** Zips files/folders on the machine; `path` is the zip to pull with `readRange`. */
export const zipPaths = (machineId: string, paths: string[], signal?: AbortSignal) =>
  fsPost<{ path: string; size: number; name: string }>(machineId, "zip", { paths }, signal);

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

// Spaces
export const listSpaces = () => request<SpaceInfo[]>("GET", "/api/spaces");

export const createSpace = (payload: CreateSpaceRequest) =>
  request<SpaceInfo>("POST", "/api/spaces", payload);

export const updateSpace = (spaceId: string, patch: UpdateSpaceRequest) =>
  request<SpaceInfo>("PATCH", `/api/spaces/${encodeURIComponent(spaceId)}`, patch);

export const deleteSpace = (spaceId: string) =>
  request<void>("DELETE", `/api/spaces/${encodeURIComponent(spaceId)}`);

// Workspace tabs
export const listWorkspaceGroups = (machineId: string) =>
  request<WorkspaceGroupInfo[]>(
    "GET",
    `/api/machines/${machineId}/workspace-groups`,
  );
export const createWorkspaceGroup = (
  machineId: string,
  name: string,
  spaceId?: string | null,
) =>
  request<WorkspaceGroupInfo>(
    "POST",
    `/api/machines/${machineId}/workspace-groups`,
    spaceId !== undefined ? { name, space_id: spaceId } : { name },
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
export const updateWorkspaceGroup = (
  machineId: string,
  groupId: string,
  patch: { name?: string; space_id?: string | null },
) =>
  request<WorkspaceGroupInfo>(
    "PATCH",
    `/api/machines/${machineId}/workspace-groups/${groupId}`,
    patch,
  );
export const renameTerminal = (
  machineId: string,
  terminalId: string,
  title: string,
) =>
  request<TerminalInfo>(
    "PATCH",
    `/api/machines/${machineId}/terminals/${terminalId}`,
    { title },
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

// Agent runs: answer the open request (typed into the terminal by its node)
export const answerAgentRun = (
  runId: string,
  answer: { request_id: string; approve?: boolean; option_id?: string; text?: string; device_id: string },
  signal?: AbortSignal,
) => request<AgentRunInfo>("POST", `/api/agent-runs/${encodeURIComponent(runId)}/answer`, answer, signal);

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

// Versions (hub 0.23+; older hubs answer 404/405)
/** This hub's version — also its built-in interface's — and the newest release. */
export interface HubVersionInfo {
  hub: string;
  latest: string | null;
  update_available: boolean;
}
/** An online node; `version` is null for a node from before 0.23. */
export interface MachineVersionInfo {
  id: string;
  name: string;
  version: string | null;
  update_available: boolean;
}
export const getHubVersion = () => request<HubVersionInfo>("GET", "/api/version");
export const getMachineVersions = () => request<MachineVersionInfo[]>("GET", "/api/machines/versions");

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

export function agentBrowserWsUrl(
  machineId: string,
  browserId: string,
  deviceId?: string,
): string {
  const base = _baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (_token) params.set("token", _token);
  if (deviceId) params.set("device_id", deviceId);
  const qs = params.toString();
  return `${base}/ws/agent-browser/${encodeURIComponent(machineId)}/${encodeURIComponent(browserId)}${qs ? "?" + qs : ""}`;
}

/** A person takes control of an agent browser (last writer wins) or hands it back. */
export const controlAgentBrowser = (
  machineId: string,
  browserId: string,
  body: AgentBrowserControlRequest,
) =>
  request<AgentBrowserInfo>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-browser/${encodeURIComponent(browserId)}/control`,
    body,
  );

/** Opens a new agent browser tab on the machine; resolves to its record (with `id`). */
export const openAgentBrowser = (machineId: string, url: string) =>
  request<AgentBrowserInfo>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-browser`,
    { type: "open", url, opener_terminal_id: null },
  );

export const closeAgentBrowser = (machineId: string, browserId: string) =>
  request<unknown>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-browser`,
    { type: "close", browser_id: browserId },
  );

export function eventsWsUrl(deviceId?: string, afterSeq?: number): string {
  const base = _baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (_token) params.set("token", _token);
  if (deviceId) params.set("device_id", deviceId);
  if (afterSeq && afterSeq > 0) params.set("after_seq", String(afterSeq));
  const qs = params.toString();
  return `${base}/ws/events${qs ? '?' + qs : ''}`;
}


export function getBaseUrl(): string { return _baseUrl; }

// E2EE device management; requests follow the current encrypted/direct transport.
export interface SecureDevice {
  id: string; name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null;
}
export const listSecureDevices = () => request<SecureDevice[]>("GET", "/api/security/devices");
/** For a screen that has the hub's link but hasn't signed in with it yet. */
export async function listSecureDevicesAt(baseUrl: string, token: string): Promise<SecureDevice[]> {
  const res = await fetch(`${baseUrl}/api/security/devices`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return await res.json() as SecureDevice[];
}
export const revokeSecureDevice = (id: string) => request<void>("DELETE", `/api/security/devices/${encodeURIComponent(id)}`);

// ── Headless Bots (Agent Sessions), Group Chat Channels, and Encrypted Vault ──

export type BotAgentKind = "claude" | "codex" | "grok" | "kimi";
export type BotSessionStatus =
  | "starting"
  | "working"
  | "asked"
  | "idle"
  | "error"
  | "disconnected";

export interface BotSessionInfo {
  id: string;
  machine_id: string;
  agent_kind: BotAgentKind;
  cwd: string;
  title: string;
  status: BotSessionStatus;
  auto_run: boolean;
  acp_session_id?: string | null;
  workspace_group_id?: string | null;
  current_model_id?: string | null;
  last_event_seq: number;
  created_at_ms: number;
}

export interface BotEventEntry {
  seq: number;
  event: Record<string, unknown>;
}

export interface BotEventsPage {
  events: BotEventEntry[];
  last_seq: number;
}

export const listBotSessions = () =>
  request<BotSessionInfo[]>("GET", "/api/agent-sessions");

export const createBotSession = (
  machineId: string,
  body: {
    agent_kind: BotAgentKind;
    cwd: string;
    title?: string;
    auto_run?: boolean;
    model_id?: string;
    device_id?: string;
  },
) =>
  request<BotSessionInfo>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions`,
    body,
  );

export const promptBotSession = (
  machineId: string,
  sessionId: string,
  body: { text: string; device_id?: string },
) =>
  request<void>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions/${encodeURIComponent(sessionId)}/prompt`,
    body,
  );

export const cancelBotSession = (
  machineId: string,
  sessionId: string,
  deviceId?: string,
) =>
  request<void>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions/${encodeURIComponent(sessionId)}/cancel${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,
  );

export const resumeBotSession = (
  machineId: string,
  sessionId: string,
  deviceId?: string,
) =>
  request<BotSessionInfo>(
    "POST",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions/${encodeURIComponent(sessionId)}/resume${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,
  );

export const deleteBotSession = (
  machineId: string,
  sessionId: string,
  deviceId?: string,
) =>
  request<void>(
    "DELETE",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions/${encodeURIComponent(sessionId)}${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,
  );

export const getBotSessionEvents = (
  machineId: string,
  sessionId: string,
  fromSeq = 0,
  limit = 500,
) =>
  request<BotEventsPage>(
    "GET",
    `/api/machines/${encodeURIComponent(machineId)}/agent-sessions/${encodeURIComponent(sessionId)}/events?from_seq=${fromSeq}&limit=${limit}`,
  );

export interface AgentMessageInfo {
  id: string;
  thread_id: string;
  channel: string | null;
  from_terminal_id: string | null;
  from_label: string;
  to_terminal_id: string | null;
  to_label: string | null;
  body: string;
  draft_id: string | null;
  read_at: number | null;
  created_at: number;
}

export const listChatChannels = () =>
  request<string[]>("GET", "/api/chat/channels");

export const listChannelMessages = (channel: string, limit = 100) =>
  request<AgentMessageInfo[]>(
    "GET",
    `/api/messages?channel=${encodeURIComponent(channel)}&limit=${limit}`,
  );

export const sendChannelMessage = (
  channel: string,
  body: { body: string; from_label?: string; thread_id?: string },
) =>
  request<{ message: AgentMessageInfo; routed_bots: string[] }>(
    "POST",
    `/api/chat/channels/${encodeURIComponent(channel)}/send`,
    body,
  );

export type VaultCategory = "api_key" | "account" | "token" | "ssh" | "other";

export interface VaultSecretSummary {
  id: string;
  name: string;
  category: VaultCategory;
  project_group: string;
  env_var: string | null;
  username: string | null;
  masked_preview: string;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export const listVaultSecrets = (project?: string) =>
  request<VaultSecretSummary[]>(
    "GET",
    project ? `/api/vault?project=${encodeURIComponent(project)}` : "/api/vault",
  );

export const createVaultSecret = (body: {
  name: string;
  category?: VaultCategory;
  project_group?: string;
  env_var?: string;
  username?: string;
  secret_value: string;
  notes?: string;
}) => request<VaultSecretSummary>("POST", "/api/vault", body);

export const deleteVaultSecret = (id: string) =>
  request<void>("DELETE", `/api/vault/${encodeURIComponent(id)}`);

export const revealVaultSecret = (id: string) =>
  request<{ value: string }>("POST", `/api/vault/${encodeURIComponent(id)}/reveal`);
