import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaExecutor,
  assertDeltaTestnetConfiguration,
  DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_PRIVATE_WS_URL
} from '../worker/execution/delta-executor.mjs';
import { normalizeDeltaWsPosition, strategyFromClientOrderId } from '../worker/execution/delta-tracker.mjs';
import { parseDeltaExecutionMode } from '../server/config.js';

const demoEnv = () => ({
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_TESTNET_API_KEY: 'demo-key-not-real',
  DELTA_TESTNET_API_SECRET: 'demo-secret-not-real',
  DELTA_TESTNET_REST_BASE: DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_WS_URL: DELTA_TESTNET_PRIVATE_WS_URL
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeRuntime({ emergencyStop = false, positions = [], closedRows = [], orders = [], equity = 1000, available = equity } = {}) {
  const httpCalls = [];
  const database = {
    async select(table, query) {
      if (table === 'dd_settings') return [{ id: 1, emergency_stop: emergencyStop }];
      if (table === 'dd_delta_positions' && query.includes('status=eq.CLOSED')) return closedRows;
      if (table === 'dd_delta_positions' && query.includes('status=eq.OPEN')) {
        return positions.map(row => ({ symbol: row.product_symbol || row.symbol }));
      }
      if (table === 'dd_orders') return orders;
      return [];
    },
    async log() {},
    async update() {},
    async insert() {},
    async upsert() {}
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    httpCalls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname === '/v2/products') {
      return response({ success: true, result: [{ id: 27, symbol: 'BTCUSD', contract_type: 'perpetual_futures' }], meta: {} });
    }
    if (parsed.pathname === '/v2/positions/margined') return response({ success: true, result: positions });
    if (parsed.pathname === '/v2/orders' && init.method === 'GET') return response({ success: true, result: [] });
    if (parsed.pathname === '/v2/wallet/balances') {
      return response({ success: true, result: [], meta: { net_equity: String(equity), available_balance: String(available) } });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'POST') {
      return response({ success: true, result: { id: 123, state: 'open', client_order_id: JSON.parse(init.body).client_order_id } });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'DELETE') {
      return response({ success: true, result: { id: JSON.parse(init.body).id, state: 'cancelled' } });
    }
    return response({ success: false, error: { code: 'unexpected_test_request' } }, 400);
  };
  return { httpCalls, database, fetchImpl };
}

test('configuration accepts only disabled/testnet and explicitly rejects live', () => {
  assert.equal(parseDeltaExecutionMode(undefined), 'disabled');
  assert.equal(parseDeltaExecutionMode('TESTNET'), 'testnet');
  assert.equal(parseDeltaExecutionMode('disabled'), 'disabled');
  assert.throws(() => parseDeltaExecutionMode('live'), {
    message: 'Live mode requires explicit user approval via code change'
  });
  assert.throws(() => parseDeltaExecutionMode('paper'), /must be either/);
});

test('executor requires testnet and refuses any non-testnet URL', async () => {
  assert.equal(assertDeltaTestnetConfiguration(demoEnv()).apiKey, 'demo-key-not-real');
  const disabled = createDeltaExecutor({
    env: { ...demoEnv(), DELTA_EXECUTION_MODE: 'disabled' },
    fetchImpl: async () => { throw new Error('network must not be reached'); }
  });
  await assert.rejects(disabled.getOpenPositions(), /must be testnet/);
  const liveHost = createDeltaExecutor({
    env: { ...demoEnv(), DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange' },
    fetchImpl: async () => { throw new Error('network must not be reached'); }
  });
  await assert.rejects(liveHost.getOpenPositions(), /hardcoded Testnet endpoint/);
});

test('bracket entry is a Testnet market order with exchange-side SL/TP and signed HMAC headers', async () => {
  const runtime = fakeRuntime();
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => 1770000000000
  });
  const order = await executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000, {
    strategy: 'MOMENTUM', clientOrderId: 'DDM-BTCUSD-TEST-1'
  });
  assert.equal(order.id, 123);
  const post = runtime.httpCalls.find(call => new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST');
  assert.ok(post);
  assert.equal(new URL(post.url).origin, DELTA_TESTNET_REST_BASE);
  assert.equal(post.body.order_type, 'market_order');
  assert.equal(post.body.limit_price, undefined);
  assert.equal(post.body.bracket_stop_loss_price, '59000');
  assert.equal(post.body.bracket_take_profit_price, '62000');
  assert.equal(post.body.bracket_stop_trigger_method, 'mark_price');
  assert.equal(post.body.client_order_id, 'DDM-BTCUSD-TEST-1');
  assert.match(post.init.headers.signature, /^[0-9a-f]{64}$/);
  assert.equal(post.init.headers.timestamp, '1770000000');
});

test('bracket entry fails closed on invalid SL or TP before making any API request', async () => {
  for (const badStop of [0, NaN, null, undefined, 'not-a-number']) {
    const runtime = fakeRuntime();
    const executor = createDeltaExecutor({
      env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
    });
    await assert.rejects(
      executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, badStop, 62000),
      /Invalid SL price/
    );
    assert.equal(runtime.httpCalls.length, 0, 'invalid SL must be rejected before any API call');
  }

  for (const badTarget of [0, NaN, null, undefined, 'not-a-number']) {
    const runtime = fakeRuntime();
    const executor = createDeltaExecutor({
      env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
    });
    await assert.rejects(
      executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, badTarget),
      /Invalid TP price/
    );
    assert.equal(runtime.httpCalls.length, 0, 'invalid TP must be rejected before any API call');
  }
});

test('placeOrder chooses market without price and limit with price', async () => {
  const runtime = fakeRuntime();
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => 1770000000000
  });
  await executor.placeOrder('BTCUSD', 'BUY', 1, null);
  await executor.placeOrder('BTCUSD', 'SELL', 1, 61000);
  const posts = runtime.httpCalls.filter(call => new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST');
  assert.equal(posts[0].body.order_type, 'market_order');
  assert.equal(posts[0].body.limit_price, undefined);
  assert.equal(posts[1].body.order_type, 'limit_order');
  assert.equal(posts[1].body.limit_price, '61000');
});

test('Emergency Stop blocks an entry before any exchange order is submitted', async () => {
  const runtime = fakeRuntime({ emergencyStop: true });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000), /Emergency Stop is active/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('unknown Emergency Stop state fails closed', async () => {
  const runtime = fakeRuntime({ emergencyStop: null });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000), /Emergency Stop state is unknown/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('daily loss at or beyond 5 percent halts entries', async () => {
  const runtime = fakeRuntime({ closedRows: [{ realized_pnl: -50 }], equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000), /Daily P&L stop reached/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('unknown realized P&L fails closed instead of treating it as zero', async () => {
  const runtime = fakeRuntime({ closedRows: [{ realized_pnl: null }], equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000), /Daily realized P&L is incomplete/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('20 already-open symbols hit the global position cap', async () => {
  const positions = Array.from({ length: 20 }, (_, index) => ({
    product_id: index + 1, product_symbol: 'SYM' + index + 'USD', size: 1,
    entry_price: 10, mark_price: 10, unrealized_pnl: 0
  }));
  const runtime = fakeRuntime({ positions, equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('BTCUSD', 'BUY', 1, 60000, 59000, 62000), /cap reached/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('WebSocket position normalizer handles signed size and strategy ids', () => {
  const short = normalizeDeltaWsPosition({ product_symbol: 'BTCUSD', size: '-2', entry_price: '60000' });
  assert.equal(short.symbol, 'BTCUSD');
  assert.equal(short.side, 'SELL');
  assert.equal(short.qty, 2);
  assert.equal(strategyFromClientOrderId('DDS-BTCUSD-123'), 'SCALPING');
  assert.equal(strategyFromClientOrderId('DDG-ETHUSD-123'), 'GRID');
});
