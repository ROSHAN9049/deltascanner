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
  const res = await fetch(CONFIG.supabaseUrl.replace(/\\/$/, '') + '/rest/v1/' + path, { headers });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase count ' + res.status + ': ' + txt.slice(0, 500));
  const range = res.headers.get('content-range') || '';
  const total = range.match(/\\/(\\d+|\\*)$/);
  if (total && total[1] !== '*') return Number(total[1]);
  const rows = txt ? JSON.parse(txt) : [];
  return Array.isArray(rows) ? rows.length : 0;
}
export const insert = (table, row) => call(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
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
export async function log(level, message, data) {
  try { await insert('dd_engine_logs', { level, message, data: data || null }); } catch {}
}