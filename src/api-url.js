const configuredBase = String(import.meta.env?.VITE_API_BASE_URL || '').trim();
export const API_BASE_URL = configuredBase.replace(/\/+$/, '');

export function joinApiUrl(path, baseUrl = API_BASE_URL) {
  const route = String(path || '').trim();
  if (!route.startsWith('/api/')) throw new Error('Dashboard API paths must start with /api/.');
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return route;
  const parsed = new URL(base);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) origin without a path.');
  }
  return base + route;
}

export const apiUrl = path => joinApiUrl(path);
