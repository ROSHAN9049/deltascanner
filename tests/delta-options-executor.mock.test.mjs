import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsExecution } from '../worker/execution/delta-options-execution.mjs';

const NOW = Date.UTC(2026, 10, 4, 4, 0, 0);
const SHORT = 'C-BTC-80000-311226';
const HEDGE = 'C-BTC-82000-311226';

function harness({ enabled = true, shortState = 'open', hedgeFilled = true, hedgePartial = false, strategy = 'OPTIONS_SELL' } = {}) {
  const env = {
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_ENVIRONMENT: 'TESTNET',
    OPTIONS_EXECUTION_ALLOWED: enabled ? 'true' : 'false',
    DELTA_TESTNET_API_SECRET: 'testnet-secret'
  };
  const products = [
    { id: 101, symbol: SHORT, contract_type: 'call_options', state: 'live',
      contract_value: 0.001, tick_size: 0.01, taker_commission_rate: 0.001 },
    { id: 102, symbol: HEDGE, contract_type: 'call_options', state: 'live',
      contract_value: 0.001, tick_size: 0.01, taker_commission_rate: 0.001 }
  ];
  const candidate = {
    symbol: SHORT, strategy, score: 95, stage: 'CONFIRMED',
    cached_at: new Date(NOW).toISOString(),
    details: {
      analysisReady: true, optionType: 'CALL', strike: 80000,
      hedgeSymbol: HEDGE, hedgeStrike: 82000, hedgeDelta: 0.1
    }
  };
  const storedOrders = [];
  const apiCalls = [];
  let hedgeCanceled = false;
  const logs = [];

  const database = {
    async select(table, query = '') {
      if (table === 'dd_option_cache') return [candidate];
      if (table === 'dd_settings') return [{
        options_max_risk_pct: 0.30,
        max_options_positions: 4,
        enabled: true,
        emergency_stop: false,
        last_tick_at: new Date(NOW).toISOString()
      }];
      if (table === 'dd_delta_positions') return [];
      if (table === 'dd_orders') {
        const idMatch = query.match(/client_order_id=eq.([^&]+)/);
        if (idMatch) {
          const id = decodeURIComponent(idMatch[1]);
          return storedOrders.filter(row => row.client_order_id === id);
        }
        if (query.includes('state=eq.FILLED')) return storedOrders.filter(row => row.state === 'FILLED');
        if (query.includes('state=in.')) {
          return storedOrders.filter(row => ['PENDING','UNKNOWN','NEW','OPEN','PARTIALLY_FILLED'].includes(row.state));
        }
        return storedOrders;
      }
      return [];
    },
    async insertIgnore(table, row) {
      if (table !== 'dd_orders') throw new Error('unexpected table ' + table);
      if (storedOrders.some(item => item.client_order_id === row.client_order_id)) return [];
      storedOrders.push({ ...row });
      return [{ ...row }];
    },
    async upsert(table, row) {
      if (table !== 'dd_orders') throw new Error('unexpected table ' + table);
      storedOrders.push({ ...row });
      return [row];
    },
    async update(table, query, patch) {
      if (table !== 'dd_orders') throw new Error('unexpected table ' + table);
      const match = query.match(/client_order_id=eq.([^&]+)/);
      const id = match ? decodeURIComponent(match[1]) : '';
      const row = storedOrders.find(item => item.client_order_id === id);
      if (row) Object.assign(row, patch);
      return row ? [row] : [];
    }
  };

  const request = async (method, path, params = {}, body = null) => {
    apiCalls.push({ method, path, params, body });
    if (method === 'GET' && path === '/v2/products') return { result: products, meta: {} };
    if (method === 'GET' && path.startsWith('/v2/tickers/')) {
      const symbol = decodeURIComponent(path.slice('/v2/tickers/'.length));
      const bidAsk = symbol === SHORT ? { bid: 900, ask: 910 } : { bid: 240, ask: 250 };
      return { result: [{
        symbol,
        quotes: { best_bid: bidAsk.bid, best_ask: bidAsk.ask },
        mark_price: (bidAsk.bid + bidAsk.ask) / 2
      }] };
    }
    if (method === 'GET' && path === '/v2/positions/margined') return { result: [] };
    if (method === 'POST' && path === '/v2/orders') {
      const id = body.reduce_only === true ? 102 : body.side === 'buy' ? 100 : 101;
      const state = body.reduce_only === true ? 'open' : body.side === 'buy' ? 'open' : shortState;
      return { result: {
        id,
        state,
        size: body.size,
        unfilled_size: body.size
      } };
    }
    if (method === 'GET' && path === '/v2/orders/100') {
      if (hedgeCanceled && (!hedgeFilled || hedgePartial)) {
        return { result: {
          id: 100, state: 'cancelled', size: 1,
          unfilled_size: hedgePartial ? 0 : 1
        } };
      }
      if (!hedgeFilled) return { result: { id: 100, state: 'open', size: 1, unfilled_size: 1 } };
      if (hedgePartial) return { result: { id: 100, state: 'open', size: 1, unfilled_size: 0 } };
      return { result: { id: 100, state: 'filled', size: 1, unfilled_size: 0, average_fill_price: 250 } };
    }
    if (method === 'GET' && path === '/v2/orders/102') {
      return { result: { id: 102, state: 'filled', size: 1, unfilled_size: 0, average_fill_price: 240 } };
    }
    if (method === 'DELETE' && path === '/v2/orders') {
      hedgeCanceled = true;
      return { success: true };
    }
    throw new Error('unexpected mock Delta request ' + method + ' ' + path);
  };

  const executor = createDeltaOptionsExecution({
    env,
    request,
    database,
    getAccountSnapshot: async () => ({
      equity: 10000,
      available: 10000,
      raw: { meta: { net_equity: 10000, available_balance: 10000 } }
    }),
    logExecutor: async (...args) => logs.push(args),
    buildClientOrderId: (value, prefix, symbol) =>
      String(value || prefix + '-' + symbol).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32),
    now: () => NOW,
    isMarketTickFresh: () => true
  });
  return { executor, apiCalls, storedOrders, logs };
}

test('mock Delta Testnet API executes a long BTC call as a single limit BUY', async () => {
  const { executor, apiCalls } = harness({ strategy: 'OPTIONS_BUY' });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1 });
  assert.equal(preview.side, 'BUY');
  assert.equal(preview.contractId, 101);
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, quoteToken: preview.quoteToken
  });
  assert.equal(result.success, true);
  const orderCalls = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders');
  assert.equal(orderCalls.length, 1);
  assert.equal(orderCalls[0].body.side, 'buy');
  assert.equal(orderCalls[0].body.order_type, 'limit_order');
  assert.equal(orderCalls[0].body.product_id, 101);
});

test('mock Delta Testnet API confirms reduce-only unwind after a definitive short rejection', async () => {
  const { executor, apiCalls } = harness({ shortState: 'rejected' });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1 });
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
  });
  assert.equal(result.success, false);
  assert.equal(result.state, 'SHORT_REJECTED_HEDGE_UNWOUND');
  const orderCalls = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders');
  assert.deepEqual(orderCalls.map(call => call.body.side), ['buy','sell','sell']);
  assert.equal(orderCalls[2].body.reduce_only, true);
  assert.equal(orderCalls[2].body.order_type, 'market_order');
});

test('mock Delta Testnet API resolves exact option IDs and submits protective BUY before short SELL', async () => {
  const { executor, apiCalls, storedOrders, logs } = harness();
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1 });
  assert.equal(preview.contractId, 101);
  assert.equal(preview.hedgeContractId, 102);
  assert.ok(preview.maxLossUsd <= preview.maxAllowedLossUsd);
  assert.equal(preview.executionAllowed, true);

  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
  });
  assert.equal(result.success, true);
  assert.equal(result.state, 'SHORT_SUBMITTED');
  const orderCalls = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders');
  assert.deepEqual(orderCalls.map(call => call.body.side), ['buy','sell']);
  assert.equal(orderCalls[0].body.product_id, 102);
  assert.equal(orderCalls[1].body.product_id, 101);
  assert.equal(orderCalls[0].body.order_type, 'limit_order');
  assert.equal(orderCalls[1].body.order_type, 'limit_order');
  assert.ok(storedOrders.every(row => row.raw.contract_id > 0));
  assert.ok(logs.some(([, message, details]) =>
    String(message).includes('spread lifecycle result') &&
    details.hedge_order_id === 100 && details.contract_id === 101 &&
    details.max_loss > 0
  ));
});

test('mock Delta Testnet API never submits the short when protective BUY remains unfilled', async () => {
  const { executor, apiCalls } = harness({ hedgeFilled: false });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1 });
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
  });
  assert.equal(result.success, false);
  assert.notEqual(result.state, 'SHORT_SUBMITTED');
  assert.equal(apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders').length, 1);
});

test('mock Delta Testnet API keeps OPTIONS execution disabled when the env flag is false', async () => {
  const { executor, apiCalls } = harness({ enabled: false });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1 });
  assert.equal(preview.executionAllowed, false);
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
    }),
    /Options execution remains locked/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('mock Delta Testnet API prevents replay of a used confirmation token', async () => {
  const { executor, apiCalls } = harness();
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1 });
  await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
  });
  const before = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders').length;
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, quoteToken: preview.quoteToken
    }),
    /already exists|already been used/
  );
  const after = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders').length;
  assert.equal(after, before);
});
