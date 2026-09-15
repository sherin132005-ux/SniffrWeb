// VITE_API_URL unset (dev): falls back to same-origin '/api', proxied by Vite to the backend (see vite.config.js).
// VITE_API_URL set (Vercel prod build / Capacitor APK): talks to the deployed backend directly, bypassing the dev-only proxy.
const API_ORIGIN = import.meta.env.VITE_API_URL || window.location.origin;
const BASE_URL = `${API_ORIGIN}/api`;

let accessToken = null;
let refreshPromise = null;
let onAuthFailure = null;

export function setAccessToken(token) { accessToken = token; }
export function getAccessToken() { return accessToken; }
export function setOnAuthFailure(fn) { onAuthFailure = fn; }

async function refreshTokens() {
  const refreshToken = localStorage.getItem('sniffr_refresh_token');
  if (!refreshToken) {
    const err = new Error('No refresh token');
    err.isAuthError = true;
    throw err;
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
  } catch (netErr) {
    const err = new Error('Network error during refresh');
    err.isNetworkError = true;
    throw err;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || 'Refresh failed');
    err.isAuthError = true;
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  accessToken = data.accessToken;
  localStorage.setItem('sniffr_refresh_token', data.refreshToken);
  return data.accessToken;
}

// ── Shared, deduplicated refresh entry point ──────────────────────
// IMPORTANT: this is the ONLY place in the whole app that should ever
// call /auth/refresh. Both the automatic 401-retry logic in request()
// below AND AuthContext's startup session-restore logic call THIS
// function, which shares the same `refreshPromise` guard. If two
// refresh attempts were ever triggered independently (e.g. one from
// AuthContext's mount effect and one from a 401 on some other request
// firing around the same moment), the SECOND call to the backend would
// get rejected -- refresh tokens are single-use/rotating server-side --
// which would then trigger onAuthFailure() and silently log the user
// back out immediately after a fresh login. Routing every refresh
// through this one deduplicated function eliminates that race entirely.
export async function ensureFreshSession() {
  if (!refreshPromise) {
    refreshPromise = refreshTokens().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request(url, options = {}) {
  const headers = { ...options.headers };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const deviceToken = localStorage.getItem('sniffr_device_token');
  if (deviceToken) headers['x-device-token'] = deviceToken;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}${url}`, { ...options, headers });
  } catch (netErr) {
    const err = new Error('Network request failed');
    err.isNetworkError = true;
    throw err;
  }

  // Auto-refresh on token expiry
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    // Only an actually-expired/invalid ACCESS token should trigger a
    // refresh-and-retry. This used to also match on bare `res.status === 401`
    // (redundant since we're already inside that check), which meant EVERY
    // 401 -- including a wrong-password login attempt -- fell into this
    // branch. With no refresh token yet during a login attempt, that threw
    // "No refresh token" and silently replaced the real "wrong credentials"
    // error from the server before it ever reached the UI.
    if (data.error === 'TOKEN_EXPIRED' || data.error === 'INVALID_TOKEN') {
      try {
        await ensureFreshSession();
        headers['Authorization'] = `Bearer ${accessToken}`;
        res = await fetch(`${BASE_URL}${url}`, { ...options, headers });
      } catch (err) {
        if (err.isAuthError && onAuthFailure) {
          onAuthFailure();
        }
        throw err;
      }
    } else {
      // Any other 401 (e.g. bad login credentials) -- preserve the
      // server's error code so callers like AuthPage can tell "wrong
      // password" apart from "your session died", and don't treat a
      // failed login attempt as a reason to log the user out.
      const err = new Error(data.message || 'Unauthorized');
      if (data.error) err.code = data.error;
      if (onAuthFailure && data.error !== 'NOT_FOUND' && data.error !== 'BAD_PASSWORD') onAuthFailure();
      throw err;
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ message: 'Request failed' }));
    const error = new Error(errBody.message || errBody.error || 'Request failed');
    // Preserve structured error data (e.g., validation errors array)
    if (errBody.errors) error.errors = errBody.errors;
    if (errBody.error) error.code = errBody.error;
    // QUOTA_EXCEEDED specifically (see utils/premiumErrors.js's
    // quotaUpsellCopy) needs these to show concrete "X of Y used" copy.
    if (errBody.usedBytes !== undefined) error.usedBytes = errBody.usedBytes;
    if (errBody.quotaBytes !== undefined) error.quotaBytes = errBody.quotaBytes;
    throw error;
  }
  return res.json();
}

const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body)
  }),
  put: (url, body) => request(url, {
    method: 'PUT',
    body: body instanceof FormData ? body : JSON.stringify(body)
  }),
  patch: (url, body) => request(url, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }),
  delete: (url) => request(url, { method: 'DELETE' }),

  // File upload helper
  upload: (url, file, fields = {}) => {
    const form = new FormData();
    form.append('media', file);
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    return request(url, { method: 'POST', body: form });
  }
};

export default api;

// TEMPORARY (5A.2 verification only) -- exposes the real api object, with
// its real in-memory accessToken and ensureFreshSession() refresh flow
// unchanged, so it can be called from the devtools console against a live
// logged-in session for manual testing. Dev-build only (import.meta.env.DEV
// is false in a production build, so this never ships). Safe to delete this
// block once 5A.2 is confirmed -- nothing else in the app reads
// window.__sniffrDebugApi.
if (import.meta.env.DEV) {
  window.__sniffrDebugApi = api;
}