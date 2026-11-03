import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countOptionProductsByUnderlying,
  replaceOptionCacheSnapshot
} from '../worker/options-cache-snapshot.mjs';

test('per-underlying Testnet product counts derive from a retained cached catalogue', () => {
  const products = new Map([
    ['C-BTC-80000-131126', { product_id: 1 }],
    ['P-BTC-76000-131126', { product_id: 2 }],
    ['C-ETH-2400-131126', { product_id: 3 }],
    ['P-ETH-2200-131126', { product_id: 4 }]
  ]);

  assert.deepEqual(
    countOptionProductsByUnderlying(products, ['BTC', 'ETH', 'XAUT']),
    { BTC: 2, ETH: 2, XAUT: 0 }
  );
});

test('a complete Options snapshot replaces old rows and stamps the same snapshot rows', async () => {
  const events = [];
  const rows = [
    { cache_key: 'BTC:OPTIONS_BUY', symbol: 'C-BTC-80000-131126', cached_at: '2026-11-03T02:00:00.000Z' },
    { cache_key: 'ETH:OPTIONS_BUY', symbol: 'C-ETH-2400-131126', cached_at: '2026-11-03T02:00:00.000Z' }
  ];
  const result = await replaceOptionCacheSnapshot(rows, {
    remove: async (table, query) => events.push({ op: 'remove', table, query }),
    upsertMany: async (table, values, conflict) => events.push({ op: 'upsertMany', table, values, conflict })
  });

  assert.deepEqual(events.map(event => event.op), ['remove', 'upsertMany']);
  assert.equal(events[0].table, 'dd_option_cache');
  assert.equal(events[0].query, 'cache_key=not.is.null');
  assert.equal(events[1].conflict, 'cache_key');
  assert.equal(result.rowCount, 2);
});

test('an empty Options snapshot clears cached candidates rather than retaining stale rows', async () => {
  const events = [];
  const result = await replaceOptionCacheSnapshot([], {
    remove: async (...args) => events.push({ op: 'remove', args }),
    upsertMany: async (...args) => events.push({ op: 'upsertMany', args })
  });

  assert.equal(result.rowCount, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'remove');
});

test('a failed cache clear prevents any partial upsert', async () => {
  let upsertCalled = false;
  await assert.rejects(() => replaceOptionCacheSnapshot([
    { cache_key: 'BTC:OPTIONS_BUY', symbol: 'C-BTC-80000-131126' }
  ], {
    remove: async () => { throw new Error('database delete unavailable'); },
    upsertMany: async () => { upsertCalled = true; }
  }), /database delete unavailable/);
  assert.equal(upsertCalled, false);
});
