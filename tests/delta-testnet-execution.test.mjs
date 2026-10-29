import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaExecutor,
  assertDeltaTestnetConfiguration,
  DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_PRIVATE_WS_URL
} from '../worker/execution/delta-executor.mjs';
import { DeltaTestnetTracker, normalizeDeltaWsPosition, normalizeDeltaFill, strategyFromClientOrderId } from '../worker/execution/delta-tracker.mjs';
import { parseDeltaExecutionMode } from '../server/config.js';
import { assessCorrelatedEntry, correlationGroupForSymbol } from '../worker/engine.mjs';

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
  orderAverageFillPrice = 60000,
  fills = [],
  orderHistory = []
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
        const symbolMatch = query.match(/symbol=eq\.([^&]+)/);
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
        const idMatch = query.match(/id=eq\.([^&]+)/);
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
    if (parsed.pathname === '/v2/fills') return response({ success: true, result: fills, meta: {} });
    if (parsed.pathname === '/v2/orders/history') return response({ success: true, result: orderHistory, meta: {} });
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

test('AMDBUSD is classified in the stock-token correlation group', () => {
  assert.equal(correlationGroupForSymbol('AMDBUSD'), 'STOCK_TOKENS');
  const decision = assessCorrelatedEntry({
    symbol: 'AMDBUSD',
    side: 'SELL',
    positions: [{ symbol: 'NVDAXUSD', side: 'BUY', qty: 1 }]
  });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reason, 'CORRELATION_GROUP_LIMIT');
  assert.equal(decision.conflictingSymbol, 'NVDAXUSD');
});

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

test('close-fill lookup uses epoch microseconds and reads nested position metadata', async () => {
  const clockMs = Date.parse('2026-10-29T08:00:00.000Z');
  const openedAt = '2026-10-29T07:00:00.000Z';
  const runtime = fakeRuntime({
    fills: [{
      id: 'fill-1', product_id: 27, product_symbol: 'BTCUSD',
      order_id: '9001', size: '2', price: '61005',
      commission: '0.05', settling_asset_symbol: 'USD',
      fill_type: 'normal', created_at: String((clockMs - 1000) * 1000),
      meta_data: { new_position: { size: 0, realized_pnl: '4.5' }, order_type: 'market_order' }
    }],
    orderHistory: [{
      id: 9001, product_symbol: 'BTCUSD', stop_order_type: 'stop_loss_order',
      client_order_id: 'DDM-BTCUSD-entry', reduce_only: true, state: 'closed'
    }]
  });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt);
  assert.equal(details.exit_price, 61005);
  assert.equal(details.fees, 0.05);
  assert.equal(details.fee_currency, 'USD');
  assert.equal(details.realized_pnl, 4.5);
  assert.equal(details.close_order_id, '9001');

  const fillCall = runtime.httpCalls.find(call => new URL(call.url).pathname === '/v2/fills');
  const params = new URL(fillCall.url).searchParams;
  assert.equal(Number(params.get('start_time')), Date.parse(openedAt) * 1000);
  assert.equal(Number(params.get('end_time')), clockMs * 1000);
  assert.equal(fillCall.init.method, 'GET');
});
 
test('WebSocket close persists confirmed close details and does not substitute mark price', async () => {
  const position = {
    id: 17, symbol: 'XAUTUSD', side: 'BUY', qty: 37, status: 'OPEN',
    entry_price: 3871.87, current_price: 4050, unrealized_pnl: 6.34,
    realized_pnl: null, strategy: 'MOMENTUM',
    opened_at: '2026-10-28T00:00:00.000Z'
  };
  let closePatch = null;
  const database = {
    async select(table) {
      return table === 'dd_delta_positions' ? [{ ...position }] : [];
    },
    async update(table, query, patch) {
      if (table === 'dd_delta_positions') closePatch = { ...patch };
      return [];
    },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(),
    database,
    executor: {
      async getRecentCloseDetails() {
        return {
          exit_price: 4058.5, fees: 0.02, fee_currency: 'USD',
          realized_pnl: 6.1, close_order_id: '9002',
          stop_order_type: 'take_profit_order',
          client_order_id: 'DDM-XAUTUSD-entry',
          close_order_history_found: true
        };
      }
    },
    WebSocketImpl: class {}
  });
  tracker.stopped = false;

  await tracker.processPosition({
    product_symbol: 'XAUTUSD', size: '0',
    mark_price: '4050', unrealized_pnl: '6.34',
    realized_pnl: '6.1'
  });

  assert.ok(closePatch);
  assert.equal(closePatch.status, 'CLOSED');
  assert.equal(closePatch.exit_price, 4058.5);
  assert.notEqual(closePatch.exit_price, 4050);
  assert.equal(closePatch.fees, 0.02);
  assert.equal(closePatch.fee_currency, 'USD');
  assert.equal(closePatch.realized_pnl, 6.1);
  assert.equal(closePatch.exit_reason, 'take_profit_order');
  assert.equal(closePatch.close_order_id, '9002');
});

test('WebSocket position normalizer handles signed size and strategy ids', () => {
  const short = normalizeDeltaWsPosition({ product_symbol: 'BTCUSD', size: '-2', entry_price: '60000' });
  assert.equal(short.symbol, 'BTCUSD');
  assert.equal(short.side, 'SELL');
  assert.equal(short.qty, 2);
  assert.equal(strategyFromClientOrderId('DDS-BTCUSD-123'), 'SCALPING');
  assert.equal(strategyFromClientOrderId('DDG-ETHUSD-123'), 'GRID');
});

test('WebSocket position update refreshes positive exchange UPL without changing its sign', async () => {
  const position = {
    id: 7, symbol: 'XAUTUSD', side: 'BUY', qty: 37, status: 'OPEN',
    entry_price: 3871.87, current_price: 4000, unrealized_pnl: -6.73,
    strategy: 'MOMENTUM', opened_at: '2026-10-28T00:00:00.000Z'
  };
  const updates = [];
  const database = {
    async select(table) { return table === 'dd_delta_positions' ? [{ ...position }] : []; },
    async update(table, query, patch) {
      updates.push({ table, query, patch: { ...patch } });
      if (table === 'dd_delta_positions') Object.assign(position, patch);
      return [];
    },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(), database, executor: {}, WebSocketImpl: class {}
  });
  tracker.stopped = false;

  await tracker.processPosition({
    product_symbol: 'XAUTUSD', size: '37', entry_price: '3871.87',
    mark_price: '4050', unrealized_pnl: '6.34'
  });

  assert.equal(position.current_price, 4050);
  assert.equal(position.unrealized_pnl, 6.34);
  assert.ok(updates.some(row => row.patch.unrealized_pnl === 6.34));
});

test('WebSocket position update clears stale mark and UPL when fields are missing', async () => {
  const position = {
    id: 8, symbol: 'XAUTUSD', side: 'BUY', qty: 37, status: 'OPEN',
    entry_price: 3871.87, current_price: 4050, unrealized_pnl: -6.73,
    strategy: 'MOMENTUM', opened_at: '2026-10-28T00:00:00.000Z'
  };
  let latestPatch = null;
  const database = {
    async select(table) { return table === 'dd_delta_positions' ? [{ ...position }] : []; },
    async update(table, query, patch) {
      if (table === 'dd_delta_positions') {
        latestPatch = { ...patch };
        Object.assign(position, patch);
      }
      return [];
    },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(), database, executor: {}, WebSocketImpl: class {}
  });
  tracker.stopped = false;

  await tracker.processPosition({
    product_symbol: 'XAUTUSD', size: '37', entry_price: '3871.87'
  });

  assert.equal(latestPatch.current_price, null);
  assert.equal(latestPatch.unrealized_pnl, null);
  assert.equal(position.current_price, null);
  assert.equal(position.unrealized_pnl, null);
});

test('bracket entry fails closed if the live mark has crossed the requested SL/TP bracket', async () => {
  const runtime = fakeRuntime({ markPrice: 61500 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });

  await assert.rejects(
    executor.placeBracketOrder('BTCUSD', 'SELL', 1, 60000, 61000, 59000, {
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


test('concurrent bracket metadata syncs are coalesced per symbol', async () => {
  let openOrdersCalls = 0;
  let resolveOrders;
  const ordersPromise = new Promise(resolve => { resolveOrders = resolve; });
  const updates = [];
  const logs = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [{ id: 'position-1', symbol: 'BTCUSD', status: 'OPEN' }];
      return [];
    },
    async update(table, query, patch) { updates.push({ table, query, patch }); return []; },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(),
    database,
    executor: {
      async getOpenOrders() { openOrdersCalls += 1; return ordersPromise; }
    },
    WebSocketImpl: class {}
  });
  tracker.stopped = false;

  const first = tracker.syncBracketMetadata('BTCUSD');
  await Promise.resolve();
  const second = tracker.syncBracketMetadata('BTCUSD');
  assert.equal(openOrdersCalls, 1, 'only one open-orders request should be in flight for BTCUSD');

  resolveOrders([{
    id: 123,
    product_symbol: 'BTCUSD',
    bracket_stop_loss_price: '59000',
    bracket_take_profit_price: '62000'
  }]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(openOrdersCalls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.sl_price, 59000);
  assert.equal(updates[0].patch.tp_price, 62000);
  assert.equal(tracker.bracketMetadataSyncs.size, 0);
});


test('Delta fill normalizer preserves IDs, commission, and microsecond exchange timestamps', () => {
  const fill = normalizeDeltaFill({
    fill_id: 'fill-abc-1',
    symbol: 'btcusd',
    product_id: 27,
    order_id: 12345,
    client_order_id: 'DDM-BTCUSD-test',
    side: 'buy',
    size: '2',
    price: '60000',
    commission: '0.12',
    role: 'taker',
    reason: 'normal',
    timestamp: 1793289600123456,
    seq_no: 8
  });
  assert.equal(fill.id, 'fill-abc-1');
  assert.equal(fill.symbol, 'BTCUSD');
  assert.equal(fill.side, 'BUY');
  assert.equal(fill.size, 2);
  assert.equal(fill.price, 60000);
  assert.equal(fill.commission, 0.12);
  assert.equal(fill.order_id, '12345');
  assert.equal(fill.client_order_id, 'DDM-BTCUSD-test');
  assert.equal(fill.timestamp_us, 1793289600123456);
  assert.equal(fill.sequence_no, 8);
  assert.equal(fill.source, 'websocket');
  assert.equal(Date.parse(fill.created_at), 1793289600123);
});

test('Delta fill normalizer preserves ISO microseconds beyond JavaScript millisecond precision', () => {
  const timestamp = '2026-10-29T10:00:00.123456Z';
  const fill = normalizeDeltaFill({
    id: 'fill-iso-precision',
    symbol: 'BTCUSD',
    side: 'buy',
    size: '1',
    price: '60000',
    commission: '0.01',
    created_at: timestamp
  });
  assert.equal(fill.created_at, timestamp);
  assert.equal(fill.timestamp_us, Date.parse('2026-10-29T10:00:00.123Z') * 1000 + 456);
});

test('Delta fill normalizer refuses incomplete rows instead of creating synthetic fills', () => {
  assert.equal(normalizeDeltaFill({ symbol: 'BTCUSD', side: 'BUY', size: 1, price: 60000 }), null);
  assert.equal(normalizeDeltaFill({ id: 'x', symbol: 'BTCUSD', side: 'BUY', size: 0, price: 60000 }), null);
});

test('executor requests /v2/fills with signed cursor pagination and clamps page size to 50', async () => {
  const calls = [];
  const executor = createDeltaExecutor({
    env: demoEnv(),
    database: { async select() { return []; }, async log() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return response({
        success: true,
        result: [{ id: 'fill-rest-1', product_symbol: 'BTCUSD', side: 'buy', size: 1, price: '60000' }],
        meta: { after: 'next-cursor', before: null }
      });
    },
    now: () => 1770000000000
  });
  const page = await executor.getFillsPage({
    startTime: 1769990000000000,
    endTime: 1770000000000000,
    after: 'cursor-1',
    pageSize: 100
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v2/fills');
  assert.equal(calls[0].url.searchParams.get('contract_types'), 'perpetual_futures');
  assert.equal(calls[0].url.searchParams.get('page_size'), '50');
  assert.equal(calls[0].url.searchParams.get('after'), 'cursor-1');
  assert.equal(calls[0].url.searchParams.get('start_time'), '1769990000000000');
  assert.equal(calls[0].url.searchParams.get('end_time'), '1770000000000000');
  assert.match(calls[0].init.headers.signature, /^[0-9a-f]{64}$/);
  assert.deepEqual(page.rows.map(row => row.id), ['fill-rest-1']);
  assert.equal(page.after, 'next-cursor');
});

test('REST fill sync upserts idempotently and advances checkpoint only after the last page', async () => {
  const batches = [];
  let state = null;
  const database = {
    async select(table) {
      if (table === 'dd_delta_fill_sync_state') return state ? [{ ...state }] : [];
      if (table === 'dd_delta_positions') return [];
      return [];
    },
    async upsert(table, row) {
      if (table === 'dd_delta_fill_sync_state') state = { ...row };
    },
    async upsertMany(table, values, conflict) {
      batches.push({ table, values: values.map(value => ({ ...value })), conflict });
    },
    async log() {}
  };
  const executor = {
    async getFillsPage({ after }) {
      assert.equal(after, null);
      return {
        rows: [{
          id: 'fill-rest-1', product_symbol: 'BTCUSD', product_id: 27, order_id: '123',
          side: 'buy', size: '1', price: '60000', commission: '0.1',
          created_at: '1793289600123456', fill_type: 'normal'
        }],
        after: null
      };
    }
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor, WebSocketImpl: class {} });
  tracker.stopped = false;
  const result = await tracker.syncRecentFills();
  assert.equal(result.completedWindow, true);
  assert.equal(result.fillsUpserted, 1);
  const fillBatch = batches.find(row => row.table === 'dd_fills');
  assert.equal(fillBatch.conflict, 'id');
  assert.equal(fillBatch.values[0].id, 'fill-rest-1');
  assert.equal(fillBatch.values[0].source, 'rest');
  assert.ok(state.last_synced_through_us > 0);
  assert.equal(state.window_start_us, null);
  assert.equal(state.window_end_us, null);
  assert.equal(state.after_cursor, null);
  assert.equal(state.rows_ingested, 1);
});

test('closed trade projection requires matching entry order, exit side and full quantity', async () => {
  const closedPosition = {
    id: 42, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket', realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    qty: '2', entry_order_id: '123', order_id: 'bracket-stop-900', entry_price: '60000', realized_pnl: '0.2',
    opened_at: '2026-10-29T10:00:00.000Z', closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-1', symbol: 'BTCUSD', order_id: '123', side: 'BUY', size: '1', price: '59990', commission: '0.01', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'entry-2', symbol: 'BTCUSD', order_id: '123', side: 'BUY', size: '1', price: '60010', commission: '0.01', created_at: '2026-10-29T10:00:02.000Z' },
    { id: 'exit-1', symbol: 'BTCUSD', order_id: '456', side: 'SELL', size: '2', price: '60120', commission: '0.02', created_at: '2026-10-29T10:29:59.000Z' }
  ];
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [closedPosition];
      if (table === 'dd_fills') return fills;
      if (table === 'dd_market_cache') return [{ symbol: 'BTCUSD', contract_value: '0.001', notional_type: 'vanilla' }];
      return [];
    },
    async upsertMany(table, values, conflict) {
      materialized.push({ table, values, conflict });
    },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor: {}, WebSocketImpl: class {} });
  tracker.stopped = false;
  const result = await tracker.materializeVerifiedClosedTrades();
  assert.equal(result.materialized, 1);
  assert.equal(materialized.length, 2);
  const tradeBatch = materialized.find(row => row.table === 'dd_trades');
  assert.equal(tradeBatch.conflict, 'execution_id');
  const trade = tradeBatch.values[0];
  assert.equal(trade.execution_id, 'delta-testnet-position:42');
  assert.equal(trade.entry_price, 60000);
  assert.equal(trade.exit_price, 60120);
  assert.ok(Math.abs(trade.entry_notional - 120) < 1e-9);
  assert.ok(Math.abs(trade.exit_notional - 120.24) < 1e-9);
  assert.ok(Math.abs(trade.fees - 0.04) < 1e-9);
  assert.equal(trade.net_pnl, 0.16);
  assert.ok(Math.abs(trade.gross_pnl - 0.24) < 1e-9);
  assert.equal(trade.pnl_pct, (0.16 / 120) * 100);
  assert.deepEqual(trade.entry_fill_ids, ['entry-1', 'entry-2']);
  assert.deepEqual(trade.exit_fill_ids, ['exit-1']);
  const rotationBatch = materialized.find(row => row.table === 'dd_rotation_ledger');
  assert.ok(rotationBatch, 'verified positive net P&L should create a rotation accounting event');
  assert.equal(rotationBatch.conflict, 'execution_id');
  assert.equal(rotationBatch.values.length, 1);
  assert.equal(rotationBatch.values[0].execution_id, trade.execution_id);
  assert.equal(rotationBatch.values[0].profit, 0.16);
  assert.equal(rotationBatch.values[0].released, 0.144);
  assert.equal(rotationBatch.values[0].retained, 0.016);
  assert.equal(rotationBatch.values[0].rotation_id, 'delta-testnet-rotation:42');
  assert.equal(rotationBatch.values[0].trade_id, null);
  assert.equal(rotationBatch.values[0].created_at, closedPosition.closed_at);
});

test('closed trade projection supports partial exits when total fills match the entry quantity', async () => {
  const closedPosition = {
    id: 45, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket',
    realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    // Position qty may reflect a remaining partial size, and order_id may point to a bracket exit.
    qty: '2', order_id: 'exit-partial-2', client_order_id: 'DDM-BTCUSD-partial', realized_pnl: '0.26',
    opened_at: '2026-10-29T10:00:00.000Z', closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-partial-1', symbol: 'BTCUSD', order_id: 'entry-partial', client_order_id: 'DDM-BTCUSD-partial', side: 'BUY', size: '2', price: '60000', commission: '0.01', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'entry-partial-2', symbol: 'BTCUSD', order_id: 'entry-partial', client_order_id: 'DDM-BTCUSD-partial', side: 'BUY', size: '2', price: '60020', commission: '0.01', created_at: '2026-10-29T10:00:02.000Z' },
    { id: 'exit-partial-1', symbol: 'BTCUSD', order_id: 'exit-partial-1', side: 'SELL', size: '2', price: '60050', commission: '0.01', created_at: '2026-10-29T10:15:00.000Z' },
    { id: 'exit-partial-2', symbol: 'BTCUSD', order_id: 'exit-partial-2', side: 'SELL', size: '2', price: '60100', commission: '0.01', created_at: '2026-10-29T10:29:59.000Z' }
  ];
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [closedPosition];
      if (table === 'dd_fills') return fills;
      if (table === 'dd_market_cache') return [{ symbol: 'BTCUSD', contract_value: '0.001', notional_type: 'vanilla' }];
      return [];
    },
    async upsertMany(table, values, conflict) {
      materialized.push({ table, values, conflict });
    },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor: {}, WebSocketImpl: class {} });
  tracker.stopped = false;

  const result = await tracker.materializeVerifiedClosedTrades();

  assert.equal(result.materialized, 1);
  const trade = materialized.find(row => row.table === 'dd_trades').values[0];
  assert.equal(trade.qty, 4);
  assert.equal(trade.entry_price, 60010);
  assert.equal(trade.exit_price, 60075);
  assert.ok(Math.abs(trade.gross_pnl - 0.26) < 1e-9);
  assert.equal(trade.net_pnl, 0.22);
  assert.deepEqual(trade.exit_fill_ids, ['exit-partial-1', 'exit-partial-2']);
});

test('closed trade projection refuses missing exit fill quantity', async () => {
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [{
        id: 43, symbol: 'ETHUSD', status: 'CLOSED', close_source: 'private_websocket', realized_pnl_verified: true, strategy: 'SCALPING', side: 'SELL',
        qty: 3, order_id: 'entry-2', realized_pnl: 0, opened_at: '2026-10-29T10:00:00Z',
        closed_at: '2026-10-29T10:30:00Z'
      }];
      if (table === 'dd_fills') return [
        { id: 'entry-2', symbol: 'ETHUSD', order_id: 'entry-2', side: 'SELL', size: 3, price: 2500, commission: 0.2, created_at: '2026-10-29T10:00:01Z' },
        { id: 'partial-exit', symbol: 'ETHUSD', order_id: 'exit-2', side: 'BUY', size: 2, price: 2490, commission: 0.2, created_at: '2026-10-29T10:29:59Z' }
      ];
      return [];
    },
    async upsertMany(table, values) { materialized.push({ table, values }); },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor: {}, WebSocketImpl: class {} });
  tracker.stopped = false;
  const result = await tracker.materializeVerifiedClosedTrades();
  assert.equal(result.materialized, 0);
  assert.equal(materialized.length, 0);
});


test('historical synthetic-close rows keep fill-derived gross but withhold unverified net P&L', async () => {
  const materialized = [];
  const database = {
    async select(table, query) {
      if (table === 'dd_delta_positions') {
        if (!String(query).includes('status=in.(CLOSED,CLOSED_EXTERNALLY)')) return [];
        return [{
        id: 44, symbol: 'BTCUSD', status: 'CLOSED_EXTERNALLY', close_source: 'rest_reconcile',
        realized_pnl_verified: false, strategy: 'MOMENTUM', side: 'BUY', qty: 1,
        order_id: 'entry-3', realized_pnl: 12, opened_at: '2026-10-29T10:00:00Z',
        closed_at: '2026-10-29T10:30:00Z'
        }];
      }
      if (table === 'dd_fills') return [
        { id: 'entry-3', symbol: 'BTCUSD', order_id: 'entry-3', side: 'BUY', size: 1, price: 60000, commission: 0.01, created_at: '2026-10-29T10:00:01Z' },
        { id: 'exit-3', symbol: 'BTCUSD', order_id: 'exit-3', side: 'SELL', size: 1, price: 60100, commission: 0.01, created_at: '2026-10-29T10:29:59Z' }
      ];
      if (table === 'dd_market_cache') return [{ symbol: 'BTCUSD', contract_value: '0.001', notional_type: 'vanilla' }];
      return [];
    },
    async upsertMany(table, values) { materialized.push({ table, values }); },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor: {}, WebSocketImpl: class {} });
  tracker.stopped = false;
  const result = await tracker.materializeVerifiedClosedTrades();
  assert.equal(result.materialized, 1);
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0].values[0].gross_pnl, 0.1);
  assert.equal(materialized[0].values[0].fees, 0.02);
  assert.equal(materialized[0].values[0].net_pnl, null);
  assert.equal(materialized[0].values[0].result, 'GROSS WIN · NET UNVERIFIED');
  assert.equal(materialized.some(row => row.table === 'dd_rotation_ledger'), false);
});

test('private WebSocket auth subscribes to all-symbol orders, positions, and fill channels', async () => {
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
  assert.deepEqual(sent[3], {
    type: 'subscribe',
    payload: { channels: [{ name: 'user_trades', symbols: ['all'] }] }
  });
  assert.ok(logs.some(row => row.message.includes('authenticated; orders, positions and user_trades subscribed')));
});

test('private WebSocket fill event updates the order row and records explicit fill confirmation', async () => {
  const updates = [];
  const logs = [];
  const orderRow = { raw: { fill_confirmed_by_rest: false } };
  const database = {
    async select(table) {
      if (table === 'dd_orders') return [orderRow];
      if (table === 'dd_delta_positions') return [{ id: 'position-1', symbol: 'ETHUSD', status: 'OPEN', strategy: 'MOMENTUM' }];
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
  assert.ok(updates.some(row => row.table === 'dd_delta_positions' && row.patch.entry_order_id === '2176469490'));
  assert.ok(logs.some(row => row.message.includes('private WebSocket confirmed order fill')));
});

test('bracket entry rejects SL distance below the 1.5 percent minimum', async () => {
  const runtime = fakeRuntime({ markPrice: 2317 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });
  await assert.rejects(
    executor.placeBracketOrder('ETHUSD', 'SELL', 1, 2310.75, 2332.9, 2256, {
      strategy: 'MOMENTUM', clientOrderId: 'DDM-ETHUSD-TIGHTSL'
    }),
    /SL distance too tight \(0\.96%\), minimum required 1\.50%/
  );
  assert.equal(
    runtime.httpCalls.some(call => new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST'),
    false,
    'tight-stop bracket must be blocked before submission'
  );
  assert.ok(runtime.logs.some(row =>
    row.message.includes('SL distance too tight') && row.data.minimumSlDistancePct === 1.5
  ));
});

test('E-STOP blocks entries but permits closePosition to submit a reduce-only exit', async () => {
  const runtime = fakeRuntime({
    emergencyStop: true,
    positions: [{
      product_id: 27,
      product_symbol: 'BTCUSD',
      size: 1,
      entry_price: '60000',
      mark_price: '60000',
      unrealized_pnl: '0'
    }]
  });
  const executor = createDeltaExecutor({
    env: demoEnv(),
    fetchImpl: runtime.fetchImpl,
    database: runtime.database,
    now: () => 1770000000000
  });

  const order = await executor.closePosition('BTCUSD', 1);
  assert.equal(order.id, 123);
  const post = runtime.httpCalls.find(call =>
    new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST'
  );
  assert.ok(post);
  assert.equal(post.body.reduce_only, true);
  assert.equal(post.body.side, 'sell');
  assert.ok(!runtime.logs.some(row => row.message.includes('Emergency Stop is active')));
});


test('closed trade projection withholds net P&L when fill commissions are incomplete', async () => {
  const closedPosition = {
    id: 46, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket',
    realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    qty: '1', order_id: 'entry-unknown-fee', entry_order_id: 'entry-unknown-fee',
    realized_pnl: '0.1', opened_at: '2026-10-29T10:00:00.000Z',
    closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-unknown-fee', symbol: 'BTCUSD', order_id: 'entry-unknown-fee', side: 'BUY', size: '1', price: '60000', commission: '0.01', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'exit-unknown-fee', symbol: 'BTCUSD', order_id: 'exit-unknown-fee', side: 'SELL', size: '1', price: '60100', commission: null, created_at: '2026-10-29T10:29:59.000Z' }
  ];
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [closedPosition];
      if (table === 'dd_fills') return fills;
      if (table === 'dd_market_cache') return [{ symbol: 'BTCUSD', contract_value: '0.001', notional_type: 'vanilla' }];
      return [];
    },
    async upsertMany(table, values, conflict) { materialized.push({ table, values, conflict }); },
    async log() {}
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor: {}, WebSocketImpl: class {} });
  tracker.stopped = false;

  const result = await tracker.materializeVerifiedClosedTrades();

  assert.equal(result.materialized, 1);
  const trade = materialized.find(row => row.table === 'dd_trades').values[0];
  assert.equal(trade.fees, null);
  assert.ok(Math.abs(trade.gross_pnl - 0.1) < 1e-9);
  assert.equal(trade.net_pnl, null);
  assert.equal(trade.pnl_pct, null);
  assert.equal(trade.result, 'GROSS WIN · NET UNVERIFIED');
  assert.ok(!materialized.some(row => row.table === 'dd_rotation_ledger'));
});

