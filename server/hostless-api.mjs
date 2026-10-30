import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import healthHandler from '../api/health.js';
import marketHandler from '../api/market.js';
import engineStateHandler from '../api/engine/state.js';
import engineSessionHandler from '../api/engine/session.js';
import engineToggleHandler from '../api/engine/toggle.js';

export const HOSTLESS_API_ROUTES = Object.freeze({
  '/api/health': healthHandler,
  '/api/market': marketHandler,
  '/api/engine/state': engineStateHandler,
  '/api/engine/session': engineSessionHandler,
  '/api/engine/toggle': engineToggleHandler
});

function normalizeOrigins(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(',').map(x => x.trim()).filter(Boolean);
  const origins = new Set();
  for (const value of values) {
    const parsed = new URL(String(value));
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('APP_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.');
    }
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error('APP_ALLOWED_ORIGINS must use HTTPS outside localhost.');
    }
    origins.add(parsed.origin);
  }
  return origins;
}

async function readBody(request, maxBytes = 1024 * 1024) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method || 'GET').toUpperCase())) return {};
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!bytes) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON request body must be an object.');
      return parsed;
    } catch (error) {
      if (!error.statusCode) error.statusCode = 400;
      throw error;
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return raw;
}

function json(response, status, payload) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  response.end(JSON.stringify(payload));
}

function responseAdapter(response) {
  let status = 200;
  return {
    setHeader(name, value) {
      if (String(name).toLowerCase() === 'vary' && response.hasHeader('vary')) {
        const parts = new Set((String(response.getHeader('vary')) + ',' + value).split(',').map(x => x.trim()).filter(Boolean));
        response.setHeader(name, [...parts].join(', '));
      } else response.setHeader(name, value);
      return this;
    },
    status(code) { status = Number(code) || 200; return this; },
    json(payload) {
      if (!response.writableEnded) json(response, status, payload);
      return this;
    }
  };
}

export function createHostlessApiServer({ allowedOrigins = process.env.APP_ALLOWED_ORIGINS, handlers = HOSTLESS_API_ROUTES } = {}) {
  const allowed = normalizeOrigins(allowedOrigins);
  if (!allowed.size) throw new Error('APP_ALLOWED_ORIGINS is required; configure the exact Hostless Site origin.');

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Vary', 'Origin');

    const origin = String(request.headers.origin || '');
    if (origin) {
      let normalized;
      try { normalized = new URL(origin).origin; }
      catch { return json(response, 403, { success: false, error: 'Browser origin is not allowed.' }); }
      if (!allowed.has(normalized) || normalized !== origin) {
        return json(response, 403, { success: false, error: 'Browser origin is not allowed.' });
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Engine-Secret');
      response.setHeader('Access-Control-Max-Age', '600');
    }

    if (request.method === 'OPTIONS') {
      if (!origin) return json(response, 400, { success: false, error: 'CORS preflight requires an allowed Origin.' });
      response.statusCode = 204;
      return response.end();
    }

    let parsedUrl;
    try { parsedUrl = new URL(request.url || '/', 'http://' + (request.headers.host || 'localhost')); }
    catch { return json(response, 400, { success: false, error: 'Invalid request URL.' }); }

    if (request.method === 'GET' && parsedUrl.pathname === '/healthz') {
      return json(response, 200, { success: true, service: 'dealdost-hostless-api', timestamp: new Date().toISOString() });
    }

    const handler = handlers[parsedUrl.pathname];
    if (!handler) return json(response, 404, { success: false, error: 'API route not found.' });

    let body;
    try { body = await readBody(request); }
    catch (error) { return json(response, error.statusCode || 400, { success: false, error: error.message || 'Invalid request body.' }); }

    const query = {};
    for (const [key, value] of parsedUrl.searchParams.entries()) query[key] = value;
    request.query = query;
    request.body = body;
    request.path = parsedUrl.pathname;

    try {
      await handler(request, responseAdapter(response));
      if (!response.writableEnded) json(response, 204, { success: true });
    } catch (error) {
      console.error('[Hostless API] Request failed:', String(error?.message || error));
      json(response, 500, { success: false, error: 'Internal API error.' });
    }
  });
}

export function startHostlessApiServer() {
  const rawPort = Number(process.env.PORT || 8000);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8000;
  const server = createHostlessApiServer();
  server.listen(port, '0.0.0.0', () => console.log('[Hostless API] Listening on 0.0.0.0:' + port));
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) startHostlessApiServer();
