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
export const rpc = (name, args) => call('rpc/' + name, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(args || {}) });
export async function log(level, message, data) {
  try { await insert('dd_engine_logs', { level, message, data: data || null }); } catch {}
}