import test from 'node:test';
import assert from 'node:assert/strict';

test('insertMany sends the whole scanner history batch in one request', async () => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const oldSecretKey = process.env.SUPABASE_SECRET_KEY;
  const oldFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test_key';

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('', { status: 201 });
  };
  try {
    const db = await import('../server/db.js?insert-many-test=' + Date.now());
    const rows = [
      { symbol: 'ETHUSD', strategy: 'MOMENTUM', ready: false },
      { symbol: 'COINXUSD', strategy: 'MOMENTUM', ready: true }
    ];
    await db.insertMany('dd_signals', rows);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://supabase.test/rest/v1/dd_signals');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Prefer, 'return=minimal');
    assert.deepEqual(JSON.parse(calls[0].init.body), rows);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldServiceKey;
    if (oldSecretKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = oldSecretKey;
  }
});

test('insertMany returns immediately for an empty batch', async () => {
  const db = await import('../server/db.js?insert-many-empty-test=' + Date.now());
  assert.deepEqual(await db.insertMany('dd_signals', []), []);
});
