import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeltaOptionsTestnetConfiguration,
  createDeltaOptionsExecutor
} from '../worker/execution/delta-options-executor.mjs';
import {
  DELTA_TESTNET_REST_BASE
} from '../worker/execution/delta-executor.mjs';
import {
  OPTIONS_EXECUTION_ALLOWED,
  OPTIONS_EXECUTION_LOCK_REASON
} from '../worker/options-execution-lock.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const optionsEnv = () => ({
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_OPTIONS_API_KEY: 'options-demo-key-not-real',
  DELTA_TESTNET_OPTIONS_API_SECRET: 'options-demo-secret-not-real'
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Options Testnet configuration requires dedicated Options credentials, not Futures credentials', () => {
  assert.deepEqual(
    assertDeltaOptionsTestnetConfiguration(optionsEnv()),
    {
      apiKey: 'options-demo-key-not-real',
      apiSecret: 'options-demo-secret-not-real',
      base: DELTA_TESTNET_REST_BASE
    }
  );

  for (const env of [
    { ...optionsEnv(), DELTA_EXECUTION_MODE: 'disabled' },
    { ...optionsEnv(), DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange' },
    { DELTA_EXECUTION_MODE: 'testnet', DELTA_TESTNET_API_KEY: 'futures-key', DELTA_TESTNET_API_SECRET: 'futures-secret' },
    { ...optionsEnv(), DELTA_TESTNET_OPTIONS_API_SECRET: '' }
  ]) {
    assert.throws(() => assertDeltaOptionsTestnetConfiguration(env));
  }
});

test('Options Testnet product catalogue uses dedicated HMAC auth and 50-item cursor pagination', async () => {
  const calls = [];
  const executor = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ parsed, init });
      assert.match(init.headers.signature, /^[0-9a-f]{64}$/);
      assert.equal(init.headers['api-key'], 'options-demo-key-not-real');
      assert.equal(init.headers.timestamp, String(Math.floor(NOW / 1000)));
      assert.equal(new URL(url).origin, DELTA_TESTNET_REST_BASE);

      if (!parsed.searchParams.get('after')) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: 101, symbol: 'C-BTC-90000-311026',
              contract_type: 'call_options', state: 'live',
              contract_value: '0.001', tick_size: '0.0001'
            },
            {
              id: 102, symbol: 'P-BTC-85000-311026',
              contract_type: 'put_options', state: 'live',
              contract_value: '0.001', tick_size: '0.0001'
            },
            {
              id: 999, symbol: 'C-XAUT-4000-311026',
              contract_type: 'call_options', state: 'live',
              contract_value: '0.001', tick_size: '0.0001'
            },
            {
              id: 998, symbol: 'BTCUSD',
              contract_type: 'perpetual_futures', state: 'live',
              contract_value: '0.001', tick_size: '0.5'
            }
          ],
          meta: { after: 'next-page' }
        });
      }
      return jsonResponse({
        success: true,
        result: [{
          id: 103, symbol: 'C-ETH-3000-311026',
          contract_type: 'call_options', state: 'live',
          contract_value: '0.01', tick_size: '0.0001'
        }],
        meta: { after: null }
      });
    }
  });

  const products = await executor.getOptionProducts({ forceRefresh: true });
  assert.deepEqual(products.map(row => row.symbol), [
    'C-BTC-90000-311026',
    'P-BTC-85000-311026',
    'C-ETH-3000-311026'
  ]);
  assert.ok(products.every(row => row.testnet_product_verified === true));
  assert.equal(products[0].id, 101);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.parsed.pathname, '/v2/products');
    assert.equal(call.parsed.searchParams.get('contract_types'), 'call_options,put_options');
    assert.equal(call.parsed.searchParams.get('states'), 'live');
    assert.equal(call.parsed.searchParams.get('page_size'), '50');
  }
  assert.equal(calls[1].parsed.searchParams.get('after'), 'next-page');
});

test('resolveOptionProduct requires one exact cached Testnet product match', async () => {
  const executor = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async () => jsonResponse({
      success: true,
      result: [{
        id: 701, symbol: 'P-ETH-3000-311026',
        contract_type: 'put_options', state: 'live',
        contract_value: '0.01', tick_size: '0.0001'
      }],
      meta: {}
    })
  });
  const product = await executor.resolveOptionProduct('p-eth-3000-311026');
  assert.equal(product.product_id, 701);
  assert.equal(product.underlying, 'ETH');
  assert.equal(product.testnet_product_verified, true);
  await assert.rejects(executor.resolveOptionProduct('C-ETH-3000-311026'), /missing or ambiguous/);
});

test('option positions are fetched separately from Futures and malformed rows fail closed', async () => {
  const calls = [];
  const executor = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        success: true,
        result: [{
          product_symbol: 'P-BTC-85000-311026',
          product_id: 102,
          size: '-2',
          entry_price: '100',
          mark_price: '110',
          unrealized_pnl: '-20'
        }]
      });
    }
  });
  const positions = await executor.getOpenOptionPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'SELL');
  assert.equal(positions[0].qty, 2);
  assert.equal(positions[0].optionType, 'PUT');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v2/positions/margined');
  assert.equal(url.searchParams.get('contract_types'), 'call_options,put_options');

  const malformed = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async () => jsonResponse({ success: true, result: [{ symbol: 'BTCUSD', size: 1, product_id: 1 }] })
  });
  await assert.rejects(malformed.getOpenOptionPositions(), /malformed/);
});

test('open Option orders and fill pages are scoped to call_options/put_options', async () => {
  const calls = [];
  const executor = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async url => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === '/v2/orders') {
        const state = parsed.searchParams.get('state');
        return jsonResponse({
          success: true,
          result: [{
            id: state === 'open' ? 10 : 11,
            symbol: state === 'open' ? 'C-BTC-90000-311026' : 'P-BTC-85000-311026',
            client_order_id: state === 'open' ? 'DDO-1234567890-PW-1' : 'DDO-2234567890-LP-1',
            state
          }],
          meta: {}
        });
      }
      return jsonResponse({
        success: true,
        result: [{ id: 20, symbol: 'C-BTC-90000-311026', size: 1 }],
        meta: { after: 'cursor' }
      });
    }
  });
  const orders = await executor.getOpenOptionOrders();
  assert.equal(orders.length, 2);
  assert.ok(calls.filter(url => url.pathname === '/v2/orders').every(url =>
    url.searchParams.get('contract_types') === 'call_options,put_options' &&
    url.searchParams.get('page_size') === '50'
  ));

  const fills = await executor.getOptionFillsPage({
    startTime: NOW * 1000,
    endTime: (NOW + 60_000) * 1000,
    after: 'fill-cursor',
    pageSize: 200
  });
  assert.equal(fills.rows.length, 1);
  const fillUrl = calls.find(url => url.pathname === '/v2/fills');
  assert.ok(fillUrl);
  assert.equal(fillUrl.searchParams.get('page_size'), '50');
  assert.equal(fillUrl.searchParams.get('contract_types'), 'call_options,put_options');
  assert.equal(fillUrl.searchParams.get('after'), 'fill-cursor');

  const orderLookup = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async url => {
      assert.match(new URL(url).pathname, /client_order_id\\//);
      return jsonResponse({
        success: true,
        result: { id: 77, client_order_id: 'DDO-1234567890-PW-1', state: 'filled' }
      });
    }
  });
  const found = await orderLookup.getOptionOrderByClientId('DDO-1234567890-PW-1');
  assert.equal(found.id, 77);
});

test('Options order submission remains source-code hard-locked before any API request', async () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  let calls = 0;
  const executor = createDeltaOptionsExecutor({
    env: optionsEnv(),
    now: () => NOW,
    fetchImpl: async () => { calls += 1; throw new Error('network must not be reached'); }
  });
  await assert.rejects(executor.placeOptionOrder({
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    qty: 1,
    limitPrice: 100,
    clientOrderId: 'DDO-ABCDEFGHIJKLMN-LP-1'
  }), error => error.message === OPTIONS_EXECUTION_LOCK_REASON);
  assert.equal(calls, 0);
});
