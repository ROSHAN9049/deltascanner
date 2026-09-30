import { CONFIG } from './config.js';

function assertDb() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  }
}
async function call(path, init) {
  assertDb();
  const res = await fetch(CONFIG.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...(init || {}),
    headers: {
      apikey: CONFIG.supabaseServiceRoleKey,
      Authorization: 'Bearer ' + CONFIG.supabaseServiceRoleKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init && init.headers ? init.headers : {})
    }
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + txt.slice(0, 500));
  return txt ? JSON.parse(txt) : null;
}
export const select = (table, query) => call(table + '?' + (query || ''));
export const insert = (table, row) => call(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
export const upsert = (table, row, conflict) => call(table + '?on_conflict=' + encodeURIComponent(conflict), { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
export const update = (table, query, row) => call(table + '?' + query, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
export const rpc = (name, args) => call('rpc/' + name, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(args || {}) });
export async function log(level, message, data) {
  try { await insert('dd_engine_logs', { level, message, data: data || null }); } catch {}
}