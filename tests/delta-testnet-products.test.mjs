import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaTestnetProductsLoader,
  DELTA_TESTNET_PRODUCTS_CACHE_TTL_MS
} from '../server/delta-testnet-products.js';

const noTimers = {
  setTimeoutFn: () => ({ unref() {} }),
  clearTimeoutFn: () => {}
};
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; }
});
const product = (symbol, id, patch = {}) => ({
  id,
  symbol,
  contract_type: 'perpetual_futures',
  state: 'live',
  trading_status: 'operational',
  only_reduce_only_orders_allowed: false,
  ...patch
});

test('catalog keeps only live operational perpetuals that allow new orders and follows pagination', async () => {
  const urls = [];
  const fetchImpl = async value => {
    const url = new URL(value);
    urls.push(url);
    if (!url.searchParams.has('after')) {
      return response({
        success: true,
        result: [
          product('BTCUSD', 1),
          product('ETHUSD', 2, { only_reduce_only_orders_allowed: undefined, product_specs: { only_reduce_only_orders_allowed: false } }),
          product('OLDUSD', 3, { state: 'expired' }),
          product('HALTUSD', 4, { trading_status: 'disrupted_cancel_only' }),
          product('REDUCEUSD', 5, { only_reduce_only_orders_allowed: true }),
          product('OPTIONUSD', 6, { contract_type: 'call_options' }),
          product('UNKNOWNUSD', 7, { only_reduce_only_orders_allowed: undefined, product_specs: {} })
        ],
        meta: { after: 'cursor-next' }
      });
    }
    assert.equal(url.searchParams.get('after'), 'cursor-next');
    return response({
      success: true,
      result: [product('XRPUSD', 8), product('BTCUSD', 1)],
      meta: { after: '' }
    });
  };
  const load = createDeltaTestnetProductsLoader({ fetchImpl, now: () => 1_800_000_000_000, ...noTimers });
  const result = await load();

  assert.equal(result.success, true);
  assert.equal(result.environment, 'DELTA_TESTNET');
  assert.equal(result.complete, true);
  assert.equal(result.count, 3);
  assert.deepEqual(result.result.map(row => row.symbol).sort(), ['BTCUSD', 'ETHUSD', 'XRPUSD']);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].origin, 'https://cdn-ind.testnet.deltaex.org');
  assert.equal(urls[0].pathname, '/v2/products');
  assert.equal(urls[0].searchParams.get('contract_types'), 'perpetual_futures');
  assert.equal(urls[0].searchParams.get('states'), 'live');
  assert.equal(urls[0].searchParams.get('page_size'), '100');
});

test('catalog is cached briefly and refreshes after the TTL', async () => {
  let clock = 1_800_000_000_000;
  let calls = 0;
  const load = createDeltaTestnetProductsLoader({
    fetchImpl: async () => {
      calls += 1;
      return response({ success: true, result: [product('BTCUSD', 1)], meta: { after: '' } });
    },
    now: () => clock,
    ...noTimers
  });

  const first = await load();
  const cached = await load();
  assert.equal(first.success, true);
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);

  clock += DELTA_TESTNET_PRODUCTS_CACHE_TTL_MS + 1;
  const refreshed = await load();
  assert.equal(refreshed.success, true);
  assert.equal(refreshed.cached, false);
  assert.equal(calls, 2);
});

test('HTTP failures fail closed and do not return any route symbols', async () => {
  const load = createDeltaTestnetProductsLoader({
    fetchImpl: async () => response({ success: false }, 503),
    now: () => 1_800_000_000_000,
    ...noTimers
  });
  const result = await load();
  assert.equal(result.success, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.result, []);
  assert.match(result.error, /HTTP 503/);
});

test('invalid payload and repeated pagination cursor fail closed', async t => {
  await t.test('invalid payload', async () => {
    const load = createDeltaTestnetProductsLoader({
      fetchImpl: async () => response({ success: true, result: {} }),
      now: () => 1_800_000_000_000,
      ...noTimers
    });
    const result = await load();
    assert.equal(result.success, false);
    assert.equal(result.complete, false);
    assert.deepEqual(result.result, []);
  });
  await t.test('repeated cursor', async () => {
    let calls = 0;
    const load = createDeltaTestnetProductsLoader({
      fetchImpl: async () => {
        calls += 1;
        return response({ success: true, result: [], meta: { after: 'same-cursor' } });
      },
      now: () => 1_800_000_000_000,
      ...noTimers
    });
    const result = await load();
    assert.equal(result.success, false);
    assert.match(result.error, /cursor repeated/);
    assert.equal(calls, 2);
  });
});

test('catalog fails closed when the pagination page limit is reached before exhaustion', async () => {
  const load = createDeltaTestnetProductsLoader({
    fetchImpl: async () => response({ success: true, result: [product('BTCUSD', 1)], meta: { after: 'more-pages' } }),
    now: () => 1_800_000_000_000,
    maxPages: 1,
    ...noTimers
  });
  const result = await load();
  assert.equal(result.success, false);
  assert.equal(result.complete, false);
  assert.match(result.error, /exceeded the page limit/);
});

test('network and timeout errors fail closed', async () => {
  const load = createDeltaTestnetProductsLoader({
    fetchImpl: async () => { throw new Error('request aborted'); },
    now: () => 1_800_000_000_000,
    ...noTimers
  });
  const result = await load();
  assert.equal(result.success, false);
  assert.equal(result.complete, false);
  assert.match(result.error, /request aborted/);
});
