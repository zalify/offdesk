import type { SpaceInfo } from './contracts'

export interface CreateSpaceRequest {
  name: string
  icon?: string | null
  color?: string | null
  default_cwd?: string | null
  sort_order?: number
}

export interface UpdateSpaceRequest {
  name?: string
  icon?: string | null
  color?: string | null
  default_cwd?: string | null
  sort_order?: number
}

export interface SpacesApiOptions {
  baseUrl?: string
  token?: string | null
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
  signal?: AbortSignal
}

async function spaceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: SpacesApiOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`
  }
  const doFetch = options?.fetcher ?? fetch
  const url = `${options?.baseUrl ?? ''}${path}`
  const res = await doFetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export const listSpaces = (options?: SpacesApiOptions): Promise<SpaceInfo[]> =>
  spaceRequest<SpaceInfo[]>('GET', '/api/spaces', undefined, options)

export const createSpace = (
  payload: CreateSpaceRequest,
  options?: SpacesApiOptions,
): Promise<SpaceInfo> =>
  spaceRequest<SpaceInfo>('POST', '/api/spaces', payload, options)

export const updateSpace = (
  spaceId: string,
  patch: UpdateSpaceRequest,
  options?: SpacesApiOptions,
): Promise<SpaceInfo> =>
  spaceRequest<SpaceInfo>('PATCH', `/api/spaces/${encodeURIComponent(spaceId)}`, patch, options)

export const deleteSpace = (
  spaceId: string,
  options?: SpacesApiOptions,
): Promise<void> =>
  spaceRequest<void>('DELETE', `/api/spaces/${encodeURIComponent(spaceId)}`, undefined, options)
