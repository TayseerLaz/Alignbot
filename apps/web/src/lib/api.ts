/**
 * Browser API client. Holds the access token in memory (refreshes via cookie),
 * automatically retries once on 401.
 */
import type { ApiErrorPayload } from '@aligned/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

let accessToken: string | null = null;
let accessTokenExpiresAt: number | null = null;
let refreshInFlight: Promise<void> | null = null;

export function setAccessToken(token: string, expiresAtIso: string) {
  accessToken = token;
  accessTokenExpiresAt = new Date(expiresAtIso).getTime();
}

export function clearAccessToken() {
  accessToken = null;
  accessTokenExpiresAt = null;
}

export function getAccessToken() {
  return accessToken;
}

// Event the API client emits when the refresh cookie is dead and the
// session can no longer be revived without a fresh login. Used by the
// SessionProvider to flip state → 'unauthenticated' which triggers the
// dashboard layout's redirect to /login. Without this, every polling
// useQuery on the page would keep firing every refetchInterval forever,
// each hitting 401 → silent refresh failure → 401 again, producing the
// console-wall the operator saw on 2026-06-01.
export const SESSION_EXPIRED_EVENT = 'aligned:session-expired';

function notifySessionExpired() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

async function tryRefresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        clearAccessToken();
        notifySessionExpired();
        return;
      }
      const json = (await res.json()) as { accessToken: string; expiresAt: string };
      setAccessToken(json.accessToken, json.expiresAt);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ApiErrorPayload['error'],
  ) {
    super(payload.message);
    this.name = 'ApiError';
  }
}

interface RequestOpts extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip auth header even if a token is set. */
  anonymous?: boolean;
  /** If true and the access token is missing/expired, attempt a refresh first. */
  ensureAuth?: boolean;
}

export async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { body, anonymous, ensureAuth, headers, ...rest } = opts;

  if (ensureAuth && (!accessToken || (accessTokenExpiresAt && accessTokenExpiresAt < Date.now() + 5_000))) {
    await tryRefresh();
  }

  const finalHeaders = new Headers(headers);
  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
  if (!anonymous && accessToken) finalHeaders.set('Authorization', `Bearer ${accessToken}`);

  const doFetch = () =>
    fetch(`${API_URL}${path}`, {
      ...rest,
      credentials: 'include',
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();

  // One-shot retry on 401 (e.g. access token just expired).
  if (res.status === 401 && !anonymous) {
    await tryRefresh();
    if (accessToken) {
      finalHeaders.set('Authorization', `Bearer ${accessToken}`);
      res = await doFetch();
    }
  }

  if (!res.ok) {
    let payload: ApiErrorPayload;
    try {
      payload = (await res.json()) as ApiErrorPayload;
    } catch {
      payload = { error: { code: 'INTERNAL', message: res.statusText } };
    }
    throw new ApiError(res.status, payload.error);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts: RequestOpts = {}) => apiFetch<T>(path, { ...opts, method: 'GET', ensureAuth: true }),
  post: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'PUT', body, ensureAuth: true }),
  patch: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'PATCH', body, ensureAuth: true }),
  delete: <T>(path: string, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE', ensureAuth: true }),
};
