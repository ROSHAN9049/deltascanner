import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaExecutor,
  assertDeltaTestnetConfiguration,
  DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS,
  DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_PRIVATE_WS_URL
} from '../worker/execution/delta-executor.mjs';
import { DeltaTestnetTracker, normalizeDeltaWsPosition, normalizeDeltaFill, normalizeDeltaWalletTransaction, strategyFromClientOrderId } from '../worker/execution/delta-tracker.mjs';
import { parseDeltaExecutionMode } from '../server/config.js';
import { assessCorrelatedEntry, correlationGroupForSymbol } from '../worker/engine.mjs';

const demoEnv = () => ({
  DELTA_ENVIRONMENT: 'TESTNET',
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
  orderHistory = [],
  orderByClientOrderId = null,
  timestamp = Date.now()
} = {}) {
  const httpCalls = [];
  const logs = [];
  const updates = [];
  const persistedPositions = [];
  let hasPostedOrder = false;
  let latestOrder = null;

  const database = {
    async select(table, query) {
      if (table === 'dd_settings') return [{
        id: 1, enabled: true, emergency_stop: emergencyStop, auto_trade: true,
        max_open_positions: 20, last_tick_at: new Date(timestamp).toISOString()
      }];
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
      return response({ success: true, result: [
        { id: 181689, symbol: 'XAUTUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: false },
        { id: 182001, symbol: 'PAXGUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: false },
        { id: 182002, symbol: 'NVDAXUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: false },
        { id: 27, symbol: 'BTCUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: false }
      ], meta: {} });
    }
    if (parsed.pathname.startsWith('/v2/tickers/')) {
      return response({ success: true, result: { symbol: parsed.pathname.split('/').pop(), mark_price: String(markPrice) } });
    }
    if (parsed.pathname === '/v2/positions/margined') {
      const rows = hasPostedOrder && positionsAfterFill !== null ? positionsAfterFill : positions;
      return response({ success: true, result: rows });
    }
    if (parsed.pathname === '/v2/fills') return response({ success: true, result: fills, meta: {} });
    if (parsed.pathname.startsWith('/v2/orders/client_order_id/')) {
      return orderByClientOrderId
        ? response({ success: true, result: orderByClientOrderId })
        : response({ success: false, error: { code: 'order_not_found' } }, 404);
    }
    if (parsed.pathname === '/v2/orders/history') return response({ success: true, result: orderHistory, meta: {} });
    if (parsed.pathname === '/v2/orders' && init.method === 'GET') return response({ success: true, result: [] });
    if (/^\/v2\/orders\/\d+$/.test(parsed.pathname) && init.method === 'GET') {
      return latestOrder ? response({ success: true, result: latestOrder }) : response({ success: false }, 404);
    }
    if (parsed.pathname === '/v2/wallet/balances') {
      return response({ success: true, result: [], meta: { net_equity: String(equity), available_balance: String(available) } });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'POST') {
      hasPostedOrder = true;
      const clientOrderId = JSON.parse(init.body).client_order_id;
      const requestBody = JSON.parse(init.body);
      const order = {
        id: 123, state: orderState, client_order_id: clientOrderId,
        bracket_stop_loss_price: requestBody.bracket_stop_loss_price,
        bracket_take_profit_price: requestBody.bracket_take_profit_price
      };
      if (['closed', 'filled'].includes(String(orderState).toLowerCase())) {
        order.unfilled_size = 0;
        order.average_fill_price = String(orderAverageFillPrice);
      } else {
        order.unfilled_size = 1;
      }
      latestOrder = order;
      return response({ success: true, result: order });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'DELETE') {
      if (latestOrder) latestOrder = { ...latestOrder, state: 'cancelled', unfilled_size: 0 };
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
  const runtime = fakeRuntime({ timestamp: 1770000000000 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => 1770000000000
  });
  const order = await executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000, {
    strategy: 'MOMENTUM', clientOrderId: 'DDM-XAUTUSD-TEST-1'
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
  assert.equal(post.body.client_order_id, 'DDM-XAUTUSD-TEST-1');
  assert.match(post.init.headers.signature, /^[0-9a-f]{64}$/);
  assert.equal(post.init.headers.timestamp, '1770000000');
});

test('Grid bracket entry uses a GTC non-reduce-only limit order with exchange-side SL/TP', async () => {
  const runtime = fakeRuntime({ orderState: 'open', markPrice: 2500 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });
  const order = await executor.placeBracketOrder('PAXGUSD', 'BUY', 1, 2500, 2462.5, 2575, {
    strategy: 'GRID', clientOrderId: 'DDG-PAXGUSD-G07-TEST', orderType: 'limit_order'
  });
  assert.equal(order.id, 123);
  const post = runtime.httpCalls.find(call =>
    new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST'
  );
  assert.equal(post.body.order_type, 'limit_order');
  assert.equal(post.body.time_in_force, 'gtc');
  assert.equal(post.body.reduce_only, false);
  assert.equal(post.body.limit_price, '2500');
  assert.equal(post.body.bracket_stop_loss_price, '2462.5');
  assert.equal(post.body.bracket_take_profit_price, '2575');
  assert.equal(post.body.bracket_stop_trigger_method, 'mark_price');
});

test('pending Testnet Grid order cancellation is confirmed by a follow-up order lookup', async () => {
  const runtime = fakeRuntime({ orderState: 'open' });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database
  });
  await executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000, {
    strategy: 'GRID', clientOrderId: 'DDG-XAUTUSD-G07-CANCEL', orderType: 'limit_order'
  });
  const cancelled = await executor.cancelOrderById(123);
  assert.equal(cancelled.id, 123);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(runtime.httpCalls.some(call =>
    new URL(call.url).pathname === '/v2/orders' && call.init.method === 'DELETE'
  ));
  assert.ok(runtime.httpCalls.some(call =>
    new URL(call.url).pathname === '/v2/orders/123' && call.init.method === 'GET'
  ));
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
  const runtime = fakeRuntime({ timestamp: 1770000000000 });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => 1770000000000
  });
  await executor.placeOrder('XAUTUSD', 'BUY', 1, null);
  await executor.placeOrder('XAUTUSD', 'SELL', 1, 61000);
  const posts = runtime.httpCalls.filter(call => new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST');
  assert.equal(posts[0].body.order_type, 'market_order');
  assert.equal(posts[0].body.limit_price, undefined);
  assert.equal(posts[1].body.order_type, 'limit_order');
  assert.equal(posts[1].body.limit_price, '61000');
});

test('Emergency Stop blocks an entry before any exchange order is submitted', async () => {
  const runtime = fakeRuntime({ emergencyStop: true });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000), /Emergency Stop is active or unknown/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('unknown Emergency Stop state fails closed', async () => {
  const runtime = fakeRuntime({ emergencyStop: null });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000), /Emergency Stop is active or unknown/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('daily loss at or beyond 5 percent halts entries', async () => {
  const runtime = fakeRuntime({ closedRows: [{ realized_pnl: -50 }], equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000), /Daily P&L stop reached/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('unknown realized P&L fails closed instead of treating it as zero', async () => {
  const runtime = fakeRuntime({ closedRows: [{ realized_pnl: null }], equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000), /Daily realized P&L is incomplete/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('20 already-open symbols hit the global position cap', async () => {
  const positions = Array.from({ length: 20 }, (_, index) => ({
    product_id: index + 1, product_symbol: 'SYM' + index + 'USD', size: 1,
    entry_price: 10, mark_price: 10, unrealized_pnl: 0
  }));
  const runtime = fakeRuntime({ positions, equity: 1000 });
  const executor = createDeltaExecutor({ env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database });
  await assert.rejects(executor.placeBracketOrder('XAUTUSD', 'BUY', 1, 60000, 59000, 62000), /cap reached/);
  assert.equal(runtime.httpCalls.some(call => call.init.method === 'POST'), false);
});

test('close-fill lookup correlates to this entry and ignores later same-symbol closes', async () => {
  const clockMs = Date.parse('2026-10-29T08:00:00.000Z');
  const openedAt = '2026-10-29T07:00:00.000Z';
  const runtime = fakeRuntime({
    fills: [
      {
        id: 'entry-fill-1', product_id: 27, product_symbol: 'BTCUSD',
        order_id: '8001', client_order_id: 'DDM-BTCUSD-entry-001',
        side: 'buy', size: '2', price: '60000', commission: '0.03', commission_currency: 'USD',
        settling_asset_symbol: 'USD', created_at: String((clockMs - 60 * 60_000 - 1000) * 1000),
        meta_data: { new_position: { size: 2, realized_pnl: '0' } }
      },
      {
        id: 'target-close-fill', product_id: 27, product_symbol: 'BTCUSD',
        order_id: '9001', side: 'sell', size: '2', price: '61005',
        commission: '0.05', commission_currency: 'USD', settling_asset_symbol: 'USD',
        fill_type: 'normal', created_at: String((clockMs - 30 * 60_000) * 1000),
        meta_data: { new_position: { size: 0, realized_pnl: '4.5' }, order_type: 'market_order' }
      },
      {
        id: 'later-unrelated-close-fill', product_id: 27, product_symbol: 'BTCUSD',
        order_id: '9002', side: 'sell', size: '1', price: '62000',
        commission: '0.25', commission_currency: 'USD', settling_asset_symbol: 'USD',
        fill_type: 'normal', created_at: String((clockMs - 10 * 60_000) * 1000),
        meta_data: { new_position: { size: 0, realized_pnl: '99' }, order_type: 'market_order' }
      }
    ],
    orderHistory: [
      {
        id: 9001, product_symbol: 'BTCUSD', stop_order_type: 'stop_loss_order',
        client_order_id: 'DDX-X-BTCUSD-target-close', reduce_only: true, state: 'closed'
      },
      {
        id: 9002, product_symbol: 'BTCUSD', stop_order_type: null,
        client_order_id: 'manual-later-close', reduce_only: true, state: 'closed'
      }
    ]
  });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: '8001',
    client_order_id: 'DDM-BTCUSD-entry-001',
    side: 'BUY'
  });
  assert.equal(details.exit_price, 61005);
  assert.equal(details.fees, 0.05);
  assert.equal(details.fee_currency, 'USD');
  assert.equal(details.realized_pnl, 4.5);
  assert.equal(details.close_order_id, '9001');
  assert.equal(details.stop_order_type, 'stop_loss_order');
  assert.equal(details.close_fill_history_complete, true);

  const fillCall = runtime.httpCalls.find(call => new URL(call.url).pathname === '/v2/fills');
  const params = new URL(fillCall.url).searchParams;
  assert.equal(Number(params.get('start_time')), (Date.parse(openedAt) - 30_000) * 1000);
  assert.equal(Number(params.get('end_time')), clockMs * 1000);
  assert.equal(fillCall.init.method, 'GET');
});
 
test('close-fill lookup resolves a missing entry order ID through the Delta client-order endpoint', async () => {
  const clockMs = Date.parse('2026-10-29T08:00:00.000Z');
  const openedAt = '2026-10-29T07:00:00.000Z';
  const clientOrderId = 'DDM-BTCUSD-entry-no-exchange-id';
  const runtime = fakeRuntime({
    fills: [
      {
        id: 'entry-fill-without-client-id', product_id: 27, product_symbol: 'BTCUSD',
        order_id: '8001', side: 'buy', size: '2', price: '60000', commission: '0.03',
        settling_asset_symbol: 'USD',
        created_at: String((clockMs - 60 * 60_000 - 1000) * 1000),
        meta_data: { new_position: { size: 2, realized_pnl: '0' } }
      },
      {
        id: 'target-close-fill', product_id: 27, product_symbol: 'BTCUSD',
        order_id: '9001', side: 'sell', size: '2', price: '61005',
        commission: '0.05', settling_asset_symbol: 'USD',
        created_at: String((clockMs - 30 * 60_000) * 1000),
        meta_data: { new_position: { size: 0, realized_pnl: '4.5' }, order_type: 'market_order' }
      }
    ],
    orderHistory: [{
      id: 9001, product_symbol: 'BTCUSD', stop_order_type: 'take_profit_order',
      client_order_id: 'DDX-X-BTCUSD-target-close', reduce_only: true, state: 'closed'
    }],
    orderByClientOrderId: {
      id: 8001,
      product_id: 27,
      product_symbol: 'BTCUSD',
      side: 'buy',
      client_order_id: clientOrderId,
      state: 'closed'
    }
  });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: null,
    client_order_id: clientOrderId,
    side: 'BUY'
  });

  assert.equal(details.exit_price, 61005);
  assert.equal(details.fees, 0.05);
  assert.equal(details.realized_pnl, 4.5);
  assert.equal(details.close_order_id, '9001');
  assert.equal(details.close_fill_history_complete, true);

  const lookup = runtime.httpCalls.find(call =>
    new URL(call.url).pathname === '/v2/orders/client_order_id/' + clientOrderId
  );
  assert.ok(lookup);
  assert.equal(lookup.init.method, 'GET');
  assert.ok(runtime.logs.some(row =>
    row.message === '[Executor] Entry fill identity recovered from client order ID' &&
    row.data.entryOrderId === '8001'
  ));
});


test('historical close-fill backfill skips client-order lookup after three days and records unresolved identity at INFO', async () => {
  const clockMs = Date.parse('2026-11-06T00:00:00.000Z');
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const openedAt = new Date(clockMs - threeDaysMs - 1000).toISOString();
  const clientOrderId = 'DDS-BTCUSD-historical-entry';
  const runtime = fakeRuntime({ timestamp: clockMs, fills: [] });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: null,
    client_order_id: clientOrderId,
    side: 'BUY'
  });
  const repeatedDetails = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: null,
    client_order_id: clientOrderId,
    side: 'BUY'
  });

  assert.equal(details, null);
  assert.equal(repeatedDetails, null);
  assert.ok(runtime.httpCalls.some(call => new URL(call.url).pathname === '/v2/fills'));
  assert.ok(!runtime.httpCalls.some(call =>
    new URL(call.url).pathname === '/v2/orders/client_order_id/' + clientOrderId
  ));
  const unresolvedLogs = runtime.logs.filter(row =>
    row.message.includes('client-order lookup skipped after 3 days') &&
    row.data?.fillResolution === 'UNRESOLVED'
  );
  assert.equal(unresolvedLogs.length, 1, 'repeated reconciliation must not repeat the same INFO record');
  assert.equal(unresolvedLogs[0].level, 'INFO');
  assert.equal(unresolvedLogs[0].data.clientOrderLookupSkipped, true);
  assert.ok(!runtime.logs.some(row =>
    row.level === 'WARN' && /Entry fill identity was not found|Entry order lookup by client ID failed/.test(row.message)
  ));
});

test('order_not_found returned after the position crosses the three-day cutoff is INFO and UNRESOLVED', async () => {
  let clockMs = Date.parse('2026-11-06T00:00:00.000Z');
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const openedAtMs = clockMs - threeDaysMs + 1000;
  const openedAt = new Date(openedAtMs).toISOString();
  const clientOrderId = 'DDS-BTCUSD-crossed-cutoff';
  const runtime = fakeRuntime({ timestamp: clockMs, fills: [] });
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.startsWith('/v2/orders/client_order_id/')) {
      clockMs = openedAtMs + threeDaysMs + 1000;
    }
    return runtime.fetchImpl(url, init);
  };
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: null,
    client_order_id: clientOrderId,
    side: 'BUY'
  });

  assert.equal(details, null);
  assert.ok(runtime.httpCalls.some(call =>
    new URL(call.url).pathname === '/v2/orders/client_order_id/' + clientOrderId
  ));
  assert.ok(runtime.logs.some(row =>
    row.level === 'INFO' &&
    row.message.includes('Historical entry order not found') &&
    row.data?.fillResolution === 'UNRESOLVED'
  ));
  assert.ok(!runtime.logs.some(row =>
    row.level === 'WARN' && row.message.includes('Entry order lookup by client ID failed')
  ));
});

test('recent order_not_found remains a warning for investigation', async () => {
  const clockMs = Date.parse('2026-11-06T00:00:00.000Z');
  const openedAt = new Date(clockMs - 60 * 60 * 1000).toISOString();
  const clientOrderId = 'DDS-BTCUSD-recent-entry';
  const runtime = fakeRuntime({ timestamp: clockMs, fills: [] });
  const executor = createDeltaExecutor({
    env: demoEnv(), fetchImpl: runtime.fetchImpl, database: runtime.database,
    now: () => clockMs
  });

  const details = await executor.getRecentCloseDetails('BTCUSD', openedAt, {
    entry_order_id: null,
    client_order_id: clientOrderId,
    side: 'BUY'
  });

  assert.equal(details, null);
  assert.ok(runtime.logs.some(row =>
    row.level === 'WARN' &&
    row.message === '[Executor] Entry order lookup by client ID failed; close details remain unverified' &&
    /order_not_found/.test(row.data?.error || '')
  ));
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
  assert.equal(closePatch.exit_reason, 'TP');
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
    executor.placeBracketOrder('XAUTUSD', 'SELL', 1, 60000, 61000, 59000, {
      strategy: 'MOMENTUM', clientOrderId: 'DDM-XAUTUSD-CROSSED'
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
      product_symbol: 'XAUTUSD',
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

  const order = await executor.placeBracketOrder('XAUTUSD', 'SELL', 1, 60000, 61000, 59000, {
    strategy: 'MOMENTUM', clientOrderId: 'DDM-XAUTUSD-RESTFILL'
  });

  assert.equal(order.state, 'closed');
  assert.equal(runtime.persistedPositions.length, 1);
  const position = runtime.persistedPositions[0];
  assert.equal(position.symbol, 'XAUTUSD');
  assert.equal(position.side, 'SELL');
  assert.equal(position.qty, 1);
  assert.equal(position.status, 'OPEN');
  assert.equal(position.entry_price, 60010);
  assert.equal(position.order_id, '123');
  assert.equal(position.client_order_id, 'DDM-XAUTUSD-RESTFILL');
  assert.ok(runtime.logs.some(row =>
    row.message.includes('REST fill confirmation persisted to dd_delta_positions')
  ));
  assert.ok(runtime.logs.some(row =>
    row.message.includes('order acknowledgement and fill confirmation status') &&
    row.data.fillConfirmedByRest === true &&
    row.data.positionSnapshotConfirmedByRest === true
  ));
});


test('concurrent bracket metadata syncs are coalesced per symbol and use the filled parent-order detail', async () => {
  let parentOrderCalls = 0;
  let resolveParentOrder;
  const parentOrderPromise = new Promise(resolve => { resolveParentOrder = resolve; });
  let openOrdersCalls = 0;
  const updates = [];
  const logs = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') {
        return [{ id: 'position-1', symbol: 'BTCUSD', status: 'OPEN', entry_order_id: '123' }];
      }
      return [];
    },
    async update(table, query, patch) { updates.push({ table, query, patch }); return []; },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(),
    database,
    executor: {
      async getOrderById(id) {
        parentOrderCalls += 1;
        assert.equal(String(id), '123');
        return parentOrderPromise;
      },
      async getOpenOrders() { openOrdersCalls += 1; return []; }
    },
    WebSocketImpl: class {}
  });
  tracker.stopped = false;

  const first = tracker.syncBracketMetadata('BTCUSD');
  await new Promise(resolve => setImmediate(resolve));
  const second = tracker.syncBracketMetadata('BTCUSD');
  assert.equal(parentOrderCalls, 1, 'only one parent-order detail request should be in flight for BTCUSD');

  resolveParentOrder({
    id: 123,
    product_symbol: 'BTCUSD',
    bracket_stop_loss_price: '59000',
    bracket_take_profit_price: '62000'
  });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(parentOrderCalls, 1);
  assert.equal(openOrdersCalls, 0);
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
    commission: '0.12', settling_asset_symbol: 'USD',
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
  assert.equal(fill.commission_currency, 'USD');
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
    commission: '0.01', commission_currency: 'USD',
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

test('wallet transaction normalization preserves signed funding and fee amounts', () => {
  const row = normalizeDeltaWalletTransaction({
    id: 987, transaction_type: 'funding', amount: '-0.0125', balance: '99.98',
    product_id: 27, asset_id: 1, asset_symbol: 'USD',
    created_at: '2026-11-05T10:00:00.123456Z', meta_data: { funding_rate: '0.0001' }
  });
  assert.equal(row.id, '987');
  assert.equal(row.transaction_type, 'funding');
  assert.equal(row.amount, -0.0125);
  assert.equal(row.product_id, 27);
  assert.equal(row.asset_symbol, 'USD');
  assert.equal(row.created_at, '2026-11-05T10:00:00.123456Z');
  assert.deepEqual(row.meta_data, { funding_rate: '0.0001' });
  assert.equal(row.source, 'rest');
  assert.equal(normalizeDeltaWalletTransaction({ id: 1, transaction_type: 'commission', amount: null }), null);
});

test('wallet transaction endpoint uses signed Demo REST pagination and a 200-row cap', async () => {
  const calls = [];
  const executor = createDeltaExecutor({
    env: demoEnv(),
    database: { async select() { return []; }, async log() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return response({
        success: true,
        result: [{ id: 987, transaction_type: 'funding', amount: '-0.01', asset_symbol: 'USD' }],
        meta: { after: 'wallet-next', before: null }
      });
    },
    now: () => 1770000000000
  });
  const page = await executor.getWalletTransactionsPage({
    startTime: 1769990000000000, endTime: 1770000000000000,
    after: 'wallet-cursor', pageSize: 500
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v2/wallet/transactions');
  assert.equal(calls[0].url.searchParams.get('start_time'), '1769990000000000');
  assert.equal(calls[0].url.searchParams.get('end_time'), '1770000000000000');
  assert.equal(calls[0].url.searchParams.get('page_size'), '200');
  assert.equal(calls[0].url.searchParams.get('after'), 'wallet-cursor');
  assert.match(calls[0].init.headers.signature, /^[0-9a-f]{64}$/);
  assert.equal(page.rows[0].id, 987);
  assert.equal(page.after, 'wallet-next');
});

test('wallet transaction sync upserts idempotently and advances its cursor checkpoint', async () => {
  const batches = [];
  let state = null;
  let calls = 0;
  const database = {
    async select(table) {
      if (table === 'dd_wallet_transaction_sync_state') return state ? [{ ...state }] : [];
      if (table === 'dd_delta_positions') return [];
      return [];
    },
    async upsert(table, row) {
      if (table === 'dd_wallet_transaction_sync_state') state = { ...row };
    },
    async upsertMany(table, values, conflict) {
      batches.push({ table, values: values.map(value => ({ ...value })), conflict });
    },
    async log() {}
  };
  const executor = {
    async getWalletTransactionsPage({ after }) {
      calls += 1;
      if (after === null) return {
        rows: [{ id: 987, transaction_type: 'funding', amount: '-0.01',
          product_id: 27, asset_id: 1, asset_symbol: 'USD', created_at: '2026-11-05T10:00:00Z' }],
        after: 'wallet-next'
      };
      assert.equal(after, 'wallet-next');
      return {
        rows: [{ id: 988, transaction_type: 'commission', amount: '-0.02',
          product_id: 27, asset_id: 1, asset_symbol: 'USD', created_at: '2026-11-05T10:01:00Z' }],
        after: null
      };
    }
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor, WebSocketImpl: class {} });
  tracker.stopped = false;
  const result = await tracker.syncRecentWalletTransactions();
  assert.equal(calls, 2);
  assert.equal(result.completedWindow, true);
  assert.equal(result.transactionsUpserted, 2);
  const walletBatches = batches.filter(row => row.table === 'dd_wallet_transactions');
  assert.equal(walletBatches.length, 2);
  assert.ok(walletBatches.every(batch => batch.conflict === 'id'));
  assert.deepEqual(walletBatches.flatMap(batch => batch.values.map(row => row.id)), ['987', '988']);
  assert.ok(state.last_synced_through_us > 0);
  assert.ok(state.history_start_us > 0);
  assert.equal(state.window_start_us, null);
  assert.equal(state.window_end_us, null);
  assert.equal(state.after_cursor, null);
  assert.equal(state.rows_ingested, 2);
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
          side: 'buy', size: '1', price: '60000', commission: '0.1', commission_currency: 'USD',
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

test('closed-trade backfill resolves missing entry_order_id from client_order_id before legacy order_id', async () => {
  const clientOrderId = 'DDM-BTCUSD-entry-backfill';
  const closedPosition = {
    id: 46,
    symbol: 'BTCUSD',
    status: 'CLOSED',
    close_source: 'rest_reconcile',
    realized_pnl_verified: false,
    strategy: 'MOMENTUM',
    side: 'BUY',
    qty: '1',
    entry_order_id: null,
    // This generic field can contain bracket/exit metadata, not the entry ID.
    order_id: '9001',
    client_order_id: clientOrderId,
    realized_pnl: null,
    exit_reason: 'TP',
    opened_at: new Date(Date.now() - 15 * 60_000).toISOString(),
    closed_at: new Date(Date.now() - 5 * 60_000).toISOString()
  };
  const fills = [
    {
      id: 'entry-fill-no-client-id',
      symbol: 'BTCUSD',
      order_id: '8001',
      side: 'BUY',
      size: '1',
      price: '60000',
      commission: '0.01',
      commission_currency: 'USD',
      created_at: new Date(Date.now() - 15 * 60_000 + 1000).toISOString()
    },
    {
      id: 'exit-fill-flat',
      symbol: 'BTCUSD',
      order_id: '9001',
      side: 'SELL',
      size: '1',
      price: '60100',
      commission: '0.01',
      commission_currency: 'USD',
      created_at: new Date(Date.now() - 5 * 60_000 + 1000).toISOString(),
      raw: { meta_data: { new_position: { size: 0, realized_pnl: '0.15' }, order_type: 'market_order' } }
    }
  ];
  const updates = [];
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [closedPosition];
      if (table === 'dd_fills') return fills;
      if (table === 'dd_market_cache') {
        return [{ symbol: 'BTCUSD', contract_value: '0.001', notional_type: 'vanilla' }];
      }
      return [];
    },
    async update(table, query, patch) {
      updates.push({ table, query, patch: { ...patch } });
      Object.assign(closedPosition, patch);
    },
    async upsertMany(table, values, conflict) {
      materialized.push({ table, values, conflict });
    },
    async log() {}
  };
  const lookupCalls = [];
  const executor = {
    async getOrderByClientOrderId(value) {
      lookupCalls.push(value);
      return {
        id: 8001,
        product_id: 27,
        product_symbol: 'BTCUSD',
        side: 'buy',
        client_order_id: value,
        state: 'closed'
      };
    }
  };
  const tracker = new DeltaTestnetTracker({
    env: demoEnv(), database, executor, WebSocketImpl: class {}
  });
  tracker.stopped = false;

  const result = await tracker.materializeVerifiedClosedTrades();

  assert.equal(result.materialized, 1);
  assert.deepEqual(lookupCalls, [clientOrderId]);
  assert.ok(updates.some(row =>
    row.table === 'dd_delta_positions' && row.patch.entry_order_id === '8001'
  ));
  assert.ok(updates.some(row =>
    row.table === 'dd_delta_positions' &&
    row.patch.realized_pnl === 0.15 &&
    row.patch.realized_pnl_verified === true
  ));
  const trade = materialized.find(row => row.table === 'dd_trades').values[0];
  assert.equal(trade.entry_price, 60000);
  assert.equal(trade.exit_price, 60100);
  assert.equal(trade.exchange_realized_pnl, 0.15);
  assert.equal(trade.fees, 0.02);
  assert.equal(trade.fees_verified, false);
  assert.equal(trade.funding_verified, false);
  assert.equal(trade.net_pnl, null);
  assert.equal(trade.net_pnl_verified, false);
});

test('tracker backfill skips entry client-order lookup after three days and logs UNRESOLVED once', async () => {
  const now = Date.now();
  const openedAt = new Date(now - DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS - 60 * 60_000).toISOString();
  const closedAt = new Date(now - DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS - 5 * 60_000).toISOString();
  const position = {
    id: 146,
    symbol: 'BTCUSD',
    status: 'CLOSED',
    close_source: 'rest_reconcile',
    realized_pnl_verified: false,
    strategy: 'MOMENTUM',
    side: 'BUY',
    qty: '1',
    entry_order_id: null,
    order_id: 'exit-146',
    client_order_id: 'DDM-BTCUSD-older-than-three-days',
    opened_at: openedAt,
    closed_at: closedAt
  };
  const logs = [];
  const lookupCalls = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [position];
      if (table === 'dd_fills') return [{
        id: 'exit-146-fill',
        symbol: 'BTCUSD',
        order_id: 'exit-146',
        side: 'SELL',
        size: '1',
        price: '60100',
        commission: '0.01',
        created_at: new Date(Date.parse(closedAt) - 1000).toISOString()
      }];
      return [];
    },
    async upsertMany() {},
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const executor = {
    async getOrderByClientOrderId(value) {
      lookupCalls.push(value);
      const error = new Error('order_not_found');
      error.code = 'order_not_found';
      throw error;
    }
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor, WebSocketImpl: class {} });
  tracker.stopped = false;

  await tracker.materializeVerifiedClosedTrades();
  await tracker.materializeVerifiedClosedTrades();

  assert.deepEqual(lookupCalls, []);
  const unresolved = logs.filter(row =>
    row.message.includes('client-order lookup skipped after 3 days') &&
    row.data?.fillResolution === 'UNRESOLVED'
  );
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].level, 'INFO');
  assert.equal(unresolved[0].data.clientOrderLookupSkipped, true);
  assert.equal(logs.some(row => row.level === 'WARN'), false);
});

test('tracker keeps recent order_not_found backfill failures at WARN', async () => {
  const now = Date.now();
  const openedAt = new Date(now - 60 * 60_000).toISOString();
  const closedAt = new Date(now - 5 * 60_000).toISOString();
  const position = {
    id: 147,
    symbol: 'BTCUSD',
    status: 'CLOSED',
    close_source: 'rest_reconcile',
    realized_pnl_verified: false,
    strategy: 'MOMENTUM',
    side: 'BUY',
    qty: '1',
    entry_order_id: null,
    order_id: 'exit-147',
    client_order_id: 'DDM-BTCUSD-recent',
    opened_at: openedAt,
    closed_at: closedAt
  };
  const logs = [];
  const lookupCalls = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [position];
      if (table === 'dd_fills') return [{
        id: 'exit-147-fill',
        symbol: 'BTCUSD',
        order_id: 'exit-147',
        side: 'SELL',
        size: '1',
        price: '60100',
        commission: '0.01',
        created_at: new Date(Date.parse(closedAt) - 1000).toISOString()
      }];
      return [];
    },
    async upsertMany() {},
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const executor = {
    async getOrderByClientOrderId(value) {
      lookupCalls.push(value);
      const error = new Error('order_not_found');
      error.code = 'order_not_found';
      throw error;
    }
  };
  const tracker = new DeltaTestnetTracker({ env: demoEnv(), database, executor, WebSocketImpl: class {} });
  tracker.stopped = false;

  await tracker.materializeVerifiedClosedTrades();

  assert.deepEqual(lookupCalls, ['DDM-BTCUSD-recent']);
  assert.ok(logs.some(row =>
    row.level === 'WARN' &&
    row.message === 'Delta entry fill backfill lookup by client order ID failed; P&L remains unverified' &&
    /order_not_found/.test(row.data.error)
  ));
});

test('closed trade projection requires matching entry order, exit side and full quantity', async () => {
  const closedPosition = {
    id: 42, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket', realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    qty: '2', entry_order_id: '123', order_id: 'bracket-stop-900', entry_price: '60000', realized_pnl: '0.2',
    opened_at: '2026-10-29T10:00:00.000Z', closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-1', symbol: 'BTCUSD', order_id: '123', side: 'BUY', size: '1', price: '59990', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'entry-2', symbol: 'BTCUSD', order_id: '123', side: 'BUY', size: '1', price: '60010', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:00:02.000Z' },
    { id: 'exit-1', symbol: 'BTCUSD', order_id: '456', side: 'SELL', size: '2', price: '60120', commission: '0.02', commission_currency: 'USD', created_at: '2026-10-29T10:29:59.000Z' }
  ];
  const materialized = [];
  const database = {
    async select(table) {
      if (table === 'dd_delta_positions') return [closedPosition];
      if (table === 'dd_fills') return fills;
      if (table === 'dd_market_cache') return [{ symbol: 'BTCUSD', product_id: 27, contract_value: '0.001', notional_type: 'vanilla' }];
      if (table === 'dd_wallet_transaction_sync_state') return [{
        id: 1,
        last_synced_through_us: Date.parse(closedPosition.closed_at) * 1000 + 1,
        history_start_us: Date.parse(closedPosition.opened_at) * 1000 - 1
      }];
      if (table === 'dd_wallet_transactions') return [
        { id: 'cashflow-42', transaction_type: 'cashflow', amount: '99', product_id: 27, asset_symbol: 'USD' },
        { id: 'commission-42', transaction_type: 'commission', amount: '-0.04', product_id: 27, asset_symbol: 'USD' },
        { id: 'rebate-42', transaction_type: 'commission_rebate', amount: '0.01', product_id: 27, asset_symbol: 'USD' },
        { id: 'funding-42', transaction_type: 'funding', amount: '-0.01', product_id: 27, asset_symbol: 'USD' }
      ];
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
  assert.ok(Math.abs(trade.fees - 0.03) < 1e-9);
  assert.equal(trade.exchange_realized_pnl, 0.2);
  assert.equal(trade.realized_funding, -0.01);
  assert.equal(trade.funding_verified, true);
  assert.equal(trade.net_pnl, 0.16);
  assert.equal(trade.fees_verified, true);
  assert.equal(trade.gross_pnl_verified, true);
  assert.equal(trade.net_pnl_verified, true);
  assert.ok(Math.abs(trade.gross_pnl - 0.2) < 1e-9);
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
    { id: 'entry-partial-1', symbol: 'BTCUSD', order_id: 'entry-partial', client_order_id: 'DDM-BTCUSD-partial', side: 'BUY', size: '2', price: '60000', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'entry-partial-2', symbol: 'BTCUSD', order_id: 'entry-partial', client_order_id: 'DDM-BTCUSD-partial', side: 'BUY', size: '2', price: '60020', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:00:02.000Z' },
    { id: 'exit-partial-1', symbol: 'BTCUSD', order_id: 'exit-partial-1', side: 'SELL', size: '2', price: '60050', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:15:00.000Z' },
    { id: 'exit-partial-2', symbol: 'BTCUSD', order_id: 'exit-partial-2', side: 'SELL', size: '2', price: '60100', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:29:59.000Z' }
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
  assert.equal(trade.exchange_realized_pnl, 0.26);
  assert.equal(trade.funding_verified, false);
  assert.equal(trade.net_pnl, null);
  assert.equal(trade.net_pnl_verified, false);
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
        { id: 'entry-2', symbol: 'ETHUSD', order_id: 'entry-2', side: 'SELL', size: 3, price: 2500, commission: 0.2, commission_currency: 'USD', created_at: '2026-10-29T10:00:01Z' },
        { id: 'partial-exit', symbol: 'ETHUSD', order_id: 'exit-2', side: 'BUY', size: 2, price: 2490, commission: 0.2, commission_currency: 'USD', created_at: '2026-10-29T10:29:59Z' }
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


test('historical synthetic-close rows withhold exchange P&L when the close is unverified', async () => {
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
        { id: 'entry-3', symbol: 'BTCUSD', order_id: 'entry-3', side: 'BUY', size: 1, price: 60000, commission: 0.01, commission_currency: 'USD', created_at: '2026-10-29T10:00:01Z' },
        { id: 'exit-3', symbol: 'BTCUSD', order_id: 'exit-3', side: 'SELL', size: 1, price: 60100, commission: 0.01, commission_currency: 'USD', created_at: '2026-10-29T10:29:59Z' }
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
  assert.equal(materialized[0].values[0].gross_pnl, null);
  assert.equal(materialized[0].values[0].exchange_realized_pnl, null);
  assert.equal(materialized[0].values[0].fees, 0.02);
  assert.equal(materialized[0].values[0].net_pnl, null);
  assert.equal(materialized[0].values[0].result, 'EXCHANGE P&L UNVERIFIED');
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
    executor.placeBracketOrder('XAUTUSD', 'SELL', 1, 2310.75, 2332.9, 2256, {
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

  const order = await executor.closePosition('BTCUSD', 1, {
    positionId: 'known-engine-position',
    closeReason: 'TIMEOUT',
    expectedSide: 'BUY',
    expectedProductId: 27,
    strategy: 'MOMENTUM'
  });
  assert.equal(order.id, 123);
  const post = runtime.httpCalls.find(call =>
    new URL(call.url).pathname === '/v2/orders' && call.init.method === 'POST'
  );
  assert.ok(post);
  assert.equal(post.body.reduce_only, true);
  assert.equal(post.body.side, 'sell');
  assert.ok(!runtime.logs.some(row => row.message.includes('Emergency Stop is active')));
});


test('keeps exchange realized P&L but withholds net when commissions or funding are incomplete', async () => {
  const closedPosition = {
    id: 46, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket',
    realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    qty: '1', order_id: 'entry-unknown-fee', entry_order_id: 'entry-unknown-fee',
    realized_pnl: '0.1', opened_at: '2026-10-29T10:00:00.000Z',
    closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-unknown-fee', symbol: 'BTCUSD', order_id: 'entry-unknown-fee', side: 'BUY', size: '1', price: '60000', commission: '0.01', commission_currency: 'USD', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'exit-unknown-fee', symbol: 'BTCUSD', order_id: 'exit-unknown-fee', side: 'SELL', size: '1', price: '60100', commission: null, commission_currency: 'USD', created_at: '2026-10-29T10:29:59.000Z' }
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
  assert.equal(trade.fees_verified, false);
  assert.ok(Math.abs(trade.gross_pnl - 0.1) < 1e-9);
  assert.equal(trade.exchange_realized_pnl, 0.1);
  assert.equal(trade.gross_pnl_verified, true);
  assert.equal(trade.net_pnl, null);
  assert.equal(trade.net_pnl_verified, false);
  assert.equal(trade.funding_verified, false);
  assert.equal(trade.result, 'EXCHANGE P&L · COSTS UNVERIFIED');
  assert.equal(materialized.find(row => row.table === 'dd_rotation_ledger'), undefined);
});



test('withholds all-in net when fill settlement currency and wallet attribution are unknown', async () => {
  const closedPosition = {
    id: 47, symbol: 'BTCUSD', status: 'CLOSED', close_source: 'private_websocket',
    realized_pnl_verified: true, strategy: 'MOMENTUM', side: 'BUY',
    qty: '1', entry_order_id: 'entry-currency-unknown', order_id: 'exit-currency-unknown',
    realized_pnl: '0.1', opened_at: '2026-10-29T10:00:00.000Z',
    closed_at: '2026-10-29T10:30:00.000Z'
  };
  const fills = [
    { id: 'entry-currency-unknown', symbol: 'BTCUSD', order_id: 'entry-currency-unknown', side: 'BUY', size: '1', price: '60000', commission: '0.01', created_at: '2026-10-29T10:00:01.000Z' },
    { id: 'exit-currency-unknown', symbol: 'BTCUSD', order_id: 'exit-currency-unknown', side: 'SELL', size: '1', price: '60100', commission: '0.01', created_at: '2026-10-29T10:29:59.000Z' }
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
  assert.equal(trade.fees_verified, false);
  assert.equal(trade.exchange_realized_pnl, 0.1);
  assert.equal(trade.net_pnl, null);
  assert.equal(trade.net_pnl_verified, false);
  assert.equal(trade.result, 'EXCHANGE P&L · COSTS UNVERIFIED');
  assert.equal(materialized.find(row => row.table === 'dd_rotation_ledger'), undefined);
});

