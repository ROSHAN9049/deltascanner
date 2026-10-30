import crypto from 'node:crypto';

export const ENGINE_SESSION_COOKIE = 'dd_engine_session';
export const ENGINE_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const clean = value => String(value ?? '').trim();

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ''), 'utf8');
  const right = Buffer.from(String(rightValue ?? ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function header(req, name) {
  const headers = req?.headers || {};
  return headers[name.toLowerCase()] ?? headers[name] ?? '';
}

function signature(secret, expiry) {
  return crypto.createHmac('sha256', String(secret))
    .update('dealdost-engine-session:v1:' + String(expiry))
    .digest('base64url');
}

function cookieValue(req) {
  const raw = clean(header(req, 'cookie'));
  for (const piece of raw.split(';')) {
    const separator = piece.indexOf('=');
    if (separator < 0) continue;
    if (piece.slice(0, separator).trim() === ENGINE_SESSION_COOKIE) {
      return piece.slice(separator + 1).trim();
    }
  }
  return '';
}

function secureByDefault() {
  return process.env.NODE_ENV === 'production' ||
    Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.VERCEL);
}

export function safeEngineSecretEqual(candidate, expected) {
  const secret = clean(expected);
  return Boolean(secret) && safeEqual(candidate, secret);
}

export function createEngineSessionCookie(secret, {
  now = Date.now(),
  production = secureByDefault()
} = {}) {
  if (!clean(secret)) throw new Error('ENGINE_SECRET is not configured');
  const expiresAt = Math.floor(now / 1000) + ENGINE_SESSION_TTL_SECONDS;
  const value = expiresAt + '.' + signature(secret, expiresAt);
  const expires = new Date(expiresAt * 1000).toUTCString();
  return ENGINE_SESSION_COOKIE + '=' + value +
    '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + ENGINE_SESSION_TTL_SECONDS +
    '; Expires=' + expires + (production ? '; Secure' : '');
}

export function clearEngineSessionCookie({ production = secureByDefault() } = {}) {
  return ENGINE_SESSION_COOKIE + '=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' +
    (production ? '; Secure' : '');
}

export function isEngineSessionValid(req, secret, now = Date.now()) {
  const signingSecret = clean(secret);
  if (!signingSecret) return false;
  const match = cookieValue(req).match(/^(\d{10})\.([A-Za-z0-9_-]{40,50})$/);
  if (!match) return false;

  const expiry = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds ||
      expiry > nowSeconds + ENGINE_SESSION_TTL_SECONDS + 30) return false;

  return safeEqual(match[2], signature(signingSecret, expiry));
}

export function hasValidEngineSecretHeader(req, secret) {
  return safeEngineSecretEqual(header(req, 'x-engine-secret'), secret);
}

/**
 * Browser requests using the session cookie must be same-origin for mutations.
 * The HttpOnly + SameSite=Strict cookie is an additional CSRF barrier.
 */
export function isSameOriginRequest(req) {
  const origin = clean(header(req, 'origin'));
  const forwardedHost = clean(header(req, 'x-forwarded-host')).split(',')[0].trim();
  const host = (forwardedHost || clean(header(req, 'host'))).split(',')[0].trim();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    if (parsed.host.toLowerCase() === host.toLowerCase()) return true;
    // Cross-origin Site -> App mutations are allowed only from exact origins
    // explicitly configured on the private Hostless API App.
    const allowedOrigins = String(process.env.APP_ALLOWED_ORIGINS || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function hasEngineAccess(req, secret) {
  return hasValidEngineSecretHeader(req, secret) || isEngineSessionValid(req, secret);
}
