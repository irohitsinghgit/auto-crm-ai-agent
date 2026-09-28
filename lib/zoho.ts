const API_VERSION = 'v8';
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type Query = Record<string, string | number | undefined>;

export class ZohoError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, { status, code }: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.code = code;
  }
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new ZohoError(`Missing environment variable ${name}`, { code: 'CONFIG_ERROR' });
  }
  return value.replace(/\/$/, '');
}

interface TokenCache {
  token: string | null;
  expiresAt: number;
  pending: Promise<string> | null;
}

// Stored on globalThis so Next.js dev-mode module reloads don't discard the token.
const globalStore = globalThis as typeof globalThis & { __zohoToken?: TokenCache };
const tokenCache: TokenCache = (globalStore.__zohoToken ??= { token: null, expiresAt: 0, pending: null });

async function requestAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env('ZOHO_CLIENT_ID'),
    client_secret: env('ZOHO_CLIENT_SECRET'),
    refresh_token: env('ZOHO_REFRESH_TOKEN'),
  });

  const res = await fetch(`${env('ZOHO_ACCOUNTS_URL', 'https://accounts.zoho.in')}/oauth/v2/token`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));

  // An invalid refresh token still comes back as HTTP 200 with an "error" field.
  if (!res.ok || data.error || !data.access_token) {
    throw new ZohoError(`Zoho token refresh failed: ${data.error ?? res.statusText}`, {
      status: res.status,
      code: 'TOKEN_REFRESH_FAILED',
    });
  }

  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return data.access_token;
}

export async function getAccessToken(forceRefresh = false): Promise<string> {
  const isFresh = tokenCache.token && Date.now() < tokenCache.expiresAt - REFRESH_MARGIN_MS;
  if (isFresh && !forceRefresh) {
    return tokenCache.token as string;
  }
  // Concurrent callers share a single in-flight refresh.
  tokenCache.pending ??= requestAccessToken().finally(() => {
    tokenCache.pending = null;
  });
  return tokenCache.pending;
}

async function send(method: string, url: URL, body: unknown, token: string): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ZohoError(`Could not reach Zoho CRM: ${(err as Error).message}`, { code: 'NETWORK_ERROR' });
  }
}

async function request<T>(method: string, path: string, { query, body }: { query?: Query; body?: unknown } = {}): Promise<T | null> {
  const url = new URL(`${env('ZOHO_API_DOMAIN', 'https://www.zohoapis.in')}/crm/${API_VERSION}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  let res = await send(method, url, body, await getAccessToken());
  if (res.status === 401) {
    res = await send(method, url, body, await getAccessToken(true));
  }

  // Search and related-list endpoints answer 204 with an empty body when nothing matches.
  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const detail = data?.data?.[0] ?? data;
    throw new ZohoError(detail?.message ?? `Zoho request failed with HTTP ${res.status}`, {
      status: res.status,
      code: detail?.code,
    });
  }
  return data as T;
}

export const zoho = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  delete: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
};
