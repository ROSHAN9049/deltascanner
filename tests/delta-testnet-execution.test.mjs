import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaExecutor,
  assertDeltaTestnetConfiguration,
  DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_PRIVATE_WS_URL
} from '../worker/execution/delta-executor.mjs';
import { DeltaTestnetTracker, normalizeDeltaWsPosition, strategyFromClientOrderId } from '../worker/execution/delta-tracker.mjs';
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

function fakeRuntime({
  emergencyStop = false,
  positions = [],
  positionsAfterFill = null,
  closedRows = [],
  orders = [],
  equity = 1000,
  available = equity,
  markPrice = 60000,
  orderState = 'open',
  orderAverageFillPrice = 60000
} = {}) {
  const httpCalls = [];
  const logs = [];
  const updates = [];
  const persistedPositions = [];
  let hasPostedOrder = false;

  const database = {
    async select(table, query) {
      if (table === 'dd_settings') return [{ id: 1, emergency_stop: emergencyStop }];
      if (table === 'dd_delta_positions') {
        const symbolMatch = query.match(/symbol=eq\\.([^&]+)/);
        if (symbolMatch) {
          const symbol = decodeURIComponent(symbolMatch[1]);
          return persistedPositions.filter(row => row.status === 'OPEN' && row.symbol === symbol).map(row => ({ ...row }));
        }
        if (query.includes('status=eq.CLOSED')) return closedRows;
        if (query.includes('status=eq.OPEN')) {
          return [
            ...positions.map(row => ({ symbol: row.product_symbol || row.symbol })),
            ...persistedPositions.filter(row => row.status === 'OPEN').map(row => ({ symbol: row.symbol }))
          ];
        }
      }
      if (table === 'dd_orders') return orders;
      return [];
    },
    async log(level, message, data = {}) { logs.push({ level, message, data }); },
    async update(table, query, patch) {
      updates.push({ table, query, patch: { ...patch } });
      if (table === 'dd_delta_positions') {
        const idMatch = query.match(/id=eq\\.([^&]+)/);
        const row = persistedPositions.find(item => String(item.id) === decodeURIComponent(idMatch?.[1] || ''));
        if (row) Object.assign(row, patch);
      }
      return [];
    },
    async insert(table, row) {
      if (table === 'dd_delta_positions') {
        persistedPositions.push({ id: persistedPositions.length + 1, ...row });
      }
      return [];
    },
    async upsert() {}
  };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    httpCalls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname === '/v2/products') {
      return response({ success: true, result: [{ id: 27, symbol: 'BTCUSD', contract_type: 'perpetual_futures' }], meta: {} });
    }
    if (parsed.pathname.startsWith('/v2/tickers/')) {
      return response({ success: true, result: { symbol: parsed.pathname.split('/').pop(), mark_price: String(markPrice) } });
    }
    if (parsed.pathname === '/v2/positions/margined') {
      const rows = hasPostedOrder && positionsAfterFill !== null ? positionsAfterFill : positions;
      return response({ success: true, result: rows });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'GET') return response({ success: true, result: [] });
    if (parsed.pathname === '/v2/wallet/balances') {
      return response({ success: true, result: [], meta: { net_equity: String(equity), available_balance: String(available) } });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'POST') {
      hasPostedOrder = true;
      const clientOrderId = JSON.parse(init.body).client_order_id;
      const order = { id: 123, state: orderState, client_order_id: clientOrderId };
      if (['closed', 'filled'].includes(String(orderState).toLowerCase())) {
        order.unfilled_size = 0;
        order.average_fill_price = String(orderAverageFillPrice);
      }
      return response({ success: true, result: order });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'DELETE') {
      return response({ success: true, result: { id: JSON.parse(init.body).id, state: 'cancelled' } });
    }
    return response({ success: false, error: { code: 'unexpected_test_request' } }, 400);
  };

  return { httpCalls, database, fetchImpl, logs, updates, persistedPositions };
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

test('bracket entry fails closed if the live mark has crossed the requested SL/TP bracket', async () => {
  const runtime = fakeRuntime({ markPrice: 61000 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });

  await assert.rejects(
    executor.placeBracketOrder('BTCUSD', 'SELL', 1, 60000, 60500, 59000, {
      strategy: 'MOMENTUM', clientOrderId: 'DDM-BTCUSD-CROSSED'
    }),
    /Live mark has moved outside the requested SL\/TP bracket/
  );
  assert.equal(
    runtime.httpCalls.some(call => new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST'),
    false,
    'stale/crossed bracket must be blocked before order submission'
  );
  assert.ok(runtime.logs.some(row => row.message.includes('live mark moved outside requested SL/TP bracket')));
});

test('closed REST order acknowledgement immediately polls and persists an OPEN position', async () => {
  const runtime = fakeRuntime({
    orderState: 'closed',
    orderAverageFillPrice: 60010,
    positionsAfterFill: [{
      product_id: 27,
      product_symbol: 'BTCUSD',
      size: -1,
      entry_price: '60010',
      mark_price: '60012',
      unrealized_pnl: '-0.02',
      realized_pnl: '0'
    }]
  });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });

  const order = await executor.placeBracketOrder('BTCUSD', 'SELL', 1, 60000, 61000, 59000, {
    strategy: 'MOMENTUM', clientOrderId: 'DDM-BTCUSD-RESTFILL'
  });

  assert.equal(order.state, 'closed');
  assert.equal(runtime.persistedPositions.length, 1);
  const position = runtime.persistedPositions[0];
  assert.equal(position.symbol, 'BTCUSD');
  assert.equal(position.side, 'SELL');
  assert.equal(position.qty, 1);
  assert.equal(position.status, 'OPEN');
  assert.equal(position.entry_price, 60010);
  assert.equal(position.order_id, '123');
  assert.equal(position.client_order_id, 'DDM-BTCUSD-RESTFILL');
  assert.ok(runtime.logs.some(row =>
    row.message.includes('REST fill confirmation persisted to dd_delta_positions')
  ));
  assert.ok(runtime.logs.some(row =>
    row.message.includes('order acknowledgement and fill confirmation status') &&
    row.data.fillConfirmedByRest === true &&
    row.data.positionSnapshotConfirmedByRest === true
  ));
});

test('private WebSocket auth subscribes to all-symbol orders and positions channels', async () => {
  const sent = [];
  const socket = { send: value => sent.push(JSON.parse(value)) };
  const logs = [];
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(),
    database: { async log(level, message, data) { logs.push({ level, message, data }); } },
    executor: { async getOpenPositions() { return []; } },
    WebSocketImpl: class {}
  });
  tracker.stopped = false;
  tracker.socket = socket;

  await tracker.handleMessage(JSON.stringify({ type: 'key-auth', success: true }));

  assert.equal(tracker.authenticated, true);
  assert.equal(sent[0].type, 'enable_heartbeat');
  assert.deepEqual(sent[1], {
    type: 'subscribe',
    payload: { channels: [{ name: 'orders', symbols: ['all'] }] }
  });
  assert.deepEqual(sent[2], {
    type: 'subscribe',
    payload: { channels: [{ name: 'positions', symbols: ['all'] }] }
  });
  assert.ok(logs.some(row => row.message.includes('authenticated; orders and positions subscribed')));
});

test('private WebSocket fill event updates the order row and records explicit fill confirmation', async () => {
  const updates = [];
  const logs = [];
  const orderRow = { raw: { fill_confirmed_by_rest: false } };
  const database = {
    async select(table) {
      if (table === 'dd_orders') return [orderRow];
      return [];
    },
    async update(table, query, patch) {
      updates.push({ table, query, patch });
      if (table === 'dd_orders' && patch.raw) orderRow.raw = patch.raw;
      return [];
    },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(),
    database,
    executor: { async getOpenPositions() { return []; } },
    WebSocketImpl: class {}
  });
  tracker.stopped = true;
  tracker.scheduleSymbolReconcile = () => {};

  await tracker.processOrder({
    symbol: 'ETHUSD',
    product_symbol: 'ETHUSD',
    side: 'sell',
    state: 'closed',
    reason: 'fill',
    size: 14,
    unfilled_size: 0,
    id: 2176469490,
    client_order_id: 'DDM-ETHUSD-test',
    average_fill_price: '2310.75'
  });

  assert.equal(orderRow.raw.fill_confirmed_by_private_websocket, true);
  assert.ok(orderRow.raw.fill_confirmed_by_private_websocket_at);
  assert.ok(updates.some(row => row.table === 'dd_orders' && row.patch.raw?.fill_confirmed_by_private_websocket === true));
  assert.ok(logs.some(row => row.message.includes('private WebSocket confirmed order fill')));
});
