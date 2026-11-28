import { CONFIG } from './config.js';

function assertDb() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseAdminKey) {
    throw new Error('SUPABASE_URL / Supabase server key missing');
  }
}
async function call(path, init) {
  assertDb();
  const key = CONFIG.supabaseAdminKey;
  const headers = {
    apikey: key,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(init && init.headers ? init.headers : {})
  };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(CONFIG.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...(init || {}),
    headers
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + txt.slice(0, 500));
  return txt ? JSON.parse(txt) : null;
}
export const select = (table, query) => call(table + '?' + (query || ''));
export function exactCountFromResponse(contentRange) {
  const value = String(contentRange || '').trim();
  if (value === '*/0') return 0;
  const match = value.match(/^\d+-\d+\/(\d+)$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
export async function selectWithCount(table, query, maxRows = 1000) {
  assertDb();
  const limit = Number(maxRows);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('selectWithCount maxRows must be an integer from 1 to 1000');
  }
  const key = CONFIG.supabaseAdminKey;
  const headers = {
    apikey: key,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Prefer: 'count=exact',
    Range: '0-' + (limit - 1)
  };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const path = table + '?' + (query || '');
  const baseUrl = CONFIG.supabaseUrl.endsWith('/') ? CONFIG.supabaseUrl.slice(0, -1) : CONFIG.supabaseUrl;
  const res = await fetch(baseUrl + '/rest/v1/' + path, { headers });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase selectWithCount ' + res.status + ': ' + txt.slice(0, 500));
  const rows = txt ? JSON.parse(txt) : [];
  const total = exactCountFromResponse(res.headers.get('content-range'));
  if (!Array.isArray(rows) || total === null) {
    throw new Error('Supabase exact row count was unavailable for ' + table);
  }
  return { rows, total };
}
export async function count(table, query) {
  assertDb();
  const key = CONFIG.supabaseAdminKey;
  const headers = {
    apikey: key,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Prefer: 'count=exact',
    Range: '0-0'
  };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const path = table + '?' + (query || 'select=id');
  const baseUrl = CONFIG.supabaseUrl.replace(/\/$/, '');
  const res = await fetch(baseUrl + '/rest/v1/' + path, { headers });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase count ' + res.status + ': ' + txt.slice(0, 500));
  const total = exactCountFromResponse(res.headers.get('content-range'));
  // Range 0-0 intentionally returns at most one row. If Supabase does not
  // provide an exact Content-Range total, the response body cannot prove the
  // table count; return unknown rather than falsely claiming a complete ledger.
  return total;
}
export const insert = (table, row) => call(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
// Insert a list of history rows in one PostgREST request. Use for a complete
// scanner analysis pass so hundreds of setup rows don't cause hundreds of
// serial network round-trips before the signal cache/entry decisions complete.
export const insertMany = (table, rows) => {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return Promise.resolve([]);
  return call(table, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(list)
  });
};
export const insertManyIgnore = (table, rows, conflict) => {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return Promise.resolve([]);
  return call(table + '?on_conflict=' + encodeURIComponent(conflict), {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(list)
  });
};
// Insert a row once using the database's unique conflict target. The representation
// is non-empty for a new row and empty when the unique event ID already exists.
export const insertIgnore = (table, row, conflict) => call(table + '?on_conflict=' + encodeURIComponent(conflict), {
  method: 'POST',
  headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
  body: JSON.stringify(row)
});
export const updateReturning = (table, query, row) => call(table + '?' + query, {
  method: 'PATCH',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify(row)
});
export const upsert = (table, row, conflict) => call(table + '?on_conflict=' + encodeURIComponent(conflict), { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
export const upsertMany = (table, rows, conflict) => {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return Promise.resolve([]);
  return call(table + '?on_conflict=' + encodeURIComponent(conflict), {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(list)
  });
};
export const update = (table, query, row) => call(table + '?' + query, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
export const remove = (table, query) => call(table + '?' + query, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
export const rpc = (name, args) => call('rpc/' + name, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(args || {}) });

// Atomic global slot reservation. The database function serializes competing
// strategies and enforces the single ACTIVE row with a partial unique index.
export async function reserveGuardedAutoEntry({ strategy, symbol, clientOrderId, metadata = {} } = {}) {
  if (!['MOMENTUM', 'SCALPING'].includes(String(strategy || '').toUpperCase()) ||
      !['XAUTUSD', 'PAXGUSD'].includes(String(symbol || '').toUpperCase()) ||
      !String(clientOrderId || '').trim()) {
    throw new Error('Invalid Guarded Auto reservation request');
  }
  const result = await rpc('reserve_guarded_auto_entry', {
    p_strategy: String(strategy).toUpperCase(),
    p_symbol: String(symbol).toUpperCase(),
    p_client_order_id: String(clientOrderId),
    p_metadata: metadata && typeof metadata === 'object' ? metadata : {}
  });
  if (result === true || (Array.isArray(result) && result[0] === true) ||
      (result && typeof result === 'object' && result.reserve_guarded_auto_entry === true)) return true;
  return false;
}

export async function releaseGuardedAutoEntry({ clientOrderId, state = 'RELEASED', exchangeOrderId = null, metadata = {} } = {}) {
  if (!String(clientOrderId || '').trim()) return false;
  const result = await rpc('release_guarded_auto_entry', {
    p_client_order_id: String(clientOrderId),
    p_state: String(state).toUpperCase(),
    p_exchange_order_id: exchangeOrderId === null ? null : String(exchangeOrderId),
    p_metadata: metadata && typeof metadata === 'object' ? metadata : {}
  });
  return result === true || (Array.isArray(result) && result[0] === true) ||
    (result && typeof result === 'object' && result.release_guarded_auto_entry === true);
}

// Database diagnostic persistence is hard-limited to ERROR/FATAL. LOG_LEVEL cannot
// lower this threshold; INFO/WARN remain stdout-only to protect Free-tier ingestion.
export async function log(level, message, data) {
  const normalized = String(level || '').trim().toUpperCase();
  const severity = ({ DEBUG: 10, INFO: 20, NOTICE: 25, WARN: 30, WARNING: 30, ERROR: 40, FATAL: 50 })[normalized] ?? 40;
  // Worker heartbeat is safety-critical dashboard telemetry, not general diagnostic noise.
  // Persist this single INFO event so the dashboard can verify execution mode and freshness;
  // all other INFO/WARN messages remain stdout-only for Free-tier ingestion control.
  const isWorkerHeartbeat = normalized === 'INFO' &&
    String(message || '').startsWith('Worker heartbeat scan ');
  if (severity < 40 && !isWorkerHeartbeat) return;
  try { await insert('dd_engine_logs', { level: normalized || 'ERROR', message, data: data || null }); } catch {}
}
