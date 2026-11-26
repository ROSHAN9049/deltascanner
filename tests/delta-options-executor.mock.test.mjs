import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsExecution } from '../worker/execution/delta-options-execution.mjs';

const NOW = Date.UTC(2026, 10, 4, 4, 0, 0);
const SHORT = 'C-BTC-80000-311226';
const HEDGE = 'C-BTC-82000-311226';

function harness({
  enabled = true, shortState = 'open', hedgeFilled = true, hedgePartial = false,
  strategy = 'OPTIONS_SELL', manualOverrideEnabled = false, candidatePatch = {}, settingsPatch = {},
  closedOptionPositions = [], openOptionPositions = [], bracketEcho = true, bracketChildren = true,
  noPositionForReduceOnly = false, getRecentCloseDetails = null,
  liveQuoteMismatchPct = 0, contractSymbol = SHORT, contractUnderlying = 'BTC', contractStrike = 80000
} = {}) {
  const env = {
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_ENVIRONMENT: 'TESTNET',
    OPTIONS_EXECUTION_MODE: 'demo',
    OPTIONS_EXIT_MONITOR_ENABLED: 'true',
    OPTIONS_EXECUTION_ALLOWED: enabled ? 'true' : 'false',
    ALLOW_MANUAL_OVERRIDE_FOR_TEST: manualOverrideEnabled ? 'true' : 'false',
    DELTA_DEMO_API_KEY: 'demo-test-key',
    DELTA_DEMO_API_SECRET: 'demo-test-secret'
  };
  const products = [
    { id: 101, symbol: contractSymbol, contract_type: 'call_options', state: 'live',
      contract_value: 0.001, tick_size: 0.01, taker_commission_rate: 0.001 },
    { id: 102, symbol: HEDGE, contract_type: 'call_options', state: 'live',
      contract_value: 0.001, tick_size: 0.01, taker_commission_rate: 0.001 }
  ];
  const candidate = {
    symbol: contractSymbol, strategy, score: 95, stage: 'CONFIRMED',
    cached_at: new Date(NOW).toISOString(),
    market_regime: strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS',
    iv_rank: strategy === 'OPTIONS_BUY' ? 30 : 60,
    iv_percentile: strategy === 'OPTIONS_BUY' ? 10 : 90,
    details: {
      analysisReady: true, ivRank: strategy === 'OPTIONS_BUY' ? 30 : 60,
      ivPercentile: strategy === 'OPTIONS_BUY' ? 10 : 90,
      optionType: 'CALL', strike: contractStrike,
      delta: strategy === 'OPTIONS_BUY' ? 0.55 : 0.30,
      dte: 57, underlyingSymbol: contractUnderlying + 'USD',
      hedgeSymbol: HEDGE, hedgeStrike: 82000, hedgeDelta: 0.1
    }
  };
  const baselineDetails = { ...candidate.details };
  const patchDetails = candidatePatch.details || {};
  Object.assign(candidate, candidatePatch);
  candidate.details = { ...baselineDetails, ...patchDetails };
  const storedOrders = [];
  const optionRows = [...openOptionPositions];
  const canonicalRows = [];
  const demoPositions = [];
  const requestOrders = new Map();
  const appliedPositionOrders = new Set();
  let nextCanonicalId = 700;
  const apiCalls = [];
  let hedgeCanceled = false;
  const logs = [];

  const database = {
    async select(table, query = '') {
      if (table === 'dd_option_cache') return [candidate];
      if (table === 'dd_settings') return [{
        options_enabled: true,
        options_buy_enabled: true,
        options_sell_enabled: true,
        options_max_risk_pct: 0.30,
        max_options_positions: 4,
        options_max_open_positions: 1,
        options_min_oi: 50,
        options_min_volume: 1,
        options_max_spread_pct: 1.5,
        options_buy_min_delta: 0.45,
        options_buy_max_delta: 0.65,
        options_sell_min_delta: 0.20,
        options_sell_max_delta: 0.35,
        options_min_days_to_expiry: 2,
        options_max_days_to_expiry: 120,
        enabled: true,
        auto_trade: true,
        emergency_stop: false,
        options_execution_enabled: true,
        last_tick_at: new Date(NOW).toISOString(),
        ...settingsPatch
      }];
      if (table === 'dd_delta_positions') {
        if (query.includes('status=eq.OPEN')) return canonicalRows.filter(row => row.status === 'OPEN');
        const idMatch = query.match(/id=eq.(\d+)/);
        if (idMatch) return canonicalRows.filter(row => row.id === Number(idMatch[1]));
        return canonicalRows;
      }
      if (table === 'dd_option_positions') {
        const key = query.match(/position_key=eq.([^&]+)/)?.[1];
        if (key) {
          const decoded = decodeURIComponent(key);
          return [...optionRows, ...closedOptionPositions].filter(row => row.position_key === decoded);
        }
        if (query.includes('status=eq.CLOSED')) return closedOptionPositions;
        if (query.includes('status=in.(')) {
          return optionRows.filter(row =>
            ['ENTRY_PENDING','OPEN','HEDGE_CLOSE_PENDING','RECONCILIATION_REQUIRED'].includes(row.status)
          );
        }
        return optionRows;
      }
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
    async insert(table, row) {
      if (table === 'dd_option_positions') {
        optionRows.push({ ...row });
        return [row];
      }
      if (table !== 'dd_delta_positions') throw new Error('unexpected insert table ' + table);
      canonicalRows.push({ id: nextCanonicalId++, ...row });
      return null;
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
      if (table === 'dd_option_positions') {
        const key = query.match(/position_key=eq.([^&]+)/)?.[1];
        const row = [...optionRows, ...closedOptionPositions].find(item => item.position_key === decodeURIComponent(key || '') &&
          (!query.includes('status=eq.ENTRY_PENDING') || item.status === 'ENTRY_PENDING') &&
          (!query.includes('status=eq.OPEN') || item.status === 'OPEN') &&
          (!query.includes('status=eq.CLOSED') || item.status === 'CLOSED') &&
          (!query.includes('realized_pnl_verified=eq.false') || item.realized_pnl_verified === false));
        if (row) Object.assign(row, patch);
        return row ? [{ ...row }] : [];
      }
      if (table === 'dd_delta_positions') {
        const id = Number(query.match(/id=eq.(\d+)/)?.[1]);
        const row = canonicalRows.find(item => item.id === id && (!query.includes('status=eq.OPEN') || item.status === 'OPEN'));
        if (row) Object.assign(row, patch);
        return row ? [row] : [];
      }
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
      const bidAsk = symbol === SHORT ? { bid: 900, ask: 910 } : { bid: 249, ask: 250 };
      return { result: [{
        symbol,
        quotes: { best_bid: bidAsk.bid, best_ask: bidAsk.ask },
        mark_price: (bidAsk.bid + bidAsk.ask) / 2
      }] };
    }
    if (method === 'GET' && path === '/v2/positions/margined') {
      return { result: demoPositions.map(row => ({ ...row })) };
    }
    if (method === 'GET' && path === '/v2/orders') {
      if (!bracketChildren) return { result: [] };
      const children = [];
      for (const [id, order] of requestOrders.entries()) {
        if (!order.bracket_stop_loss_price || !appliedPositionOrders.has(id)) continue;
        const product = products.find(row => row.id === Number(order.product_id));
        const closeSide = order.side === 'buy' ? 'sell' : 'buy';
        children.push({
          id: id + 1000,
          product_id: product.id,
          side: closeSide,
          reduce_only: true,
          size: Number(order.size),
          state: 'open',
          stop_order_type: 'stop_loss_order',
          stop_price: Number(order.bracket_stop_loss_price)
        }, {
          id: id + 2000,
          product_id: product.id,
          side: closeSide,
          reduce_only: true,
          size: Number(order.size),
          state: 'open',
          stop_order_type: 'take_profit_order',
          stop_price: Number(order.bracket_take_profit_price)
        });
      }
      return { result: children };
    }
    if (method === 'POST' && path === '/v2/orders') {
      if (noPositionForReduceOnly && body.reduce_only === true) {
        const error = new Error('no_position_for_reduce_only');
        error.code = 'no_position_for_reduce_only';
        error.status = 400;
        throw error;
      }
      const id = body.reduce_only === true ? 102 : body.side === 'buy' ? 100 : 101;
      const state = body.reduce_only === true ? 'open' : body.side === 'buy' ? 'open' : shortState;
      requestOrders.set(id, { ...body });
      return { result: {
        id,
        state,
        size: body.size,
        unfilled_size: body.size
      } };
    }
    const applyFilledOrder = (id, averageFillPrice) => {
      if (appliedPositionOrders.has(id)) return;
      const order = requestOrders.get(id);
      if (!order) return;
      appliedPositionOrders.add(id);
      const product = products.find(row => row.id === Number(order.product_id));
      if (!product) return;
      const signed = (order.side === 'sell' ? -1 : 1) * Number(order.size);
      if (order.reduce_only === true) {
        const existing = demoPositions.find(row => row.product_id === product.id);
        if (existing) existing.size += signed;
        for (let index = demoPositions.length - 1; index >= 0; index -= 1) {
          if (Math.abs(demoPositions[index].size) < 1e-9) demoPositions.splice(index, 1);
        }
      } else {
        demoPositions.push({
          product_id: product.id,
          product_symbol: product.symbol,
          contract_type: product.contract_type,
          size: signed,
          entry_price: averageFillPrice
        });
      }
    };
    if (method === 'GET' && path === '/v2/orders/100') {
      if (hedgeCanceled && (!hedgeFilled || hedgePartial)) {
        return { result: {
          id: 100, state: 'cancelled', size: 1,
          unfilled_size: hedgePartial ? 0 : 1
        } };
      }
      if (!hedgeFilled) return { result: {
        id: 100, state: 'open', size: 1, unfilled_size: 1,
        ...(bracketEcho && requestOrders.get(100)?.bracket_stop_loss_price ? {
          bracket_stop_loss_price: requestOrders.get(100).bracket_stop_loss_price,
          bracket_take_profit_price: requestOrders.get(100).bracket_take_profit_price,
          bracket_stop_trigger_method: requestOrders.get(100).bracket_stop_trigger_method
        } : {})
      } };
      if (hedgePartial) return { result: {
        id: 100, state: 'open', size: 1, unfilled_size: 0,
        ...(requestOrders.get(100)?.bracket_stop_loss_price ? {
          bracket_stop_loss_price: requestOrders.get(100).bracket_stop_loss_price,
          bracket_take_profit_price: requestOrders.get(100).bracket_take_profit_price,
          bracket_stop_trigger_method: requestOrders.get(100).bracket_stop_trigger_method
        } : {})
      } };
      const currentOrder = requestOrders.get(100) || {};
      const averageFillPrice = Number(currentOrder.product_id) === 101 ? 910 : 250;
      applyFilledOrder(100, averageFillPrice);
      return { result: {
        id: 100, state: 'filled', size: 1, unfilled_size: 0,
        average_fill_price: averageFillPrice,
        ...(bracketEcho && currentOrder.bracket_stop_loss_price ? {
          bracket_stop_loss_price: currentOrder.bracket_stop_loss_price,
          bracket_take_profit_price: currentOrder.bracket_take_profit_price,
          bracket_stop_trigger_method: currentOrder.bracket_stop_trigger_method
        } : {})
      } };
    }
    if (method === 'GET' && path === '/v2/orders/101') {
      if (shortState === 'rejected') {
        return { result: { id: 101, state: 'rejected', size: 1, unfilled_size: 1 } };
      }
      const currentOrder = requestOrders.get(101) || {};
      applyFilledOrder(101, 900);
      return { result: {
        id: 101, state: 'filled', size: 1, unfilled_size: 0,
        average_fill_price: 900,
        ...(currentOrder.bracket_stop_loss_price ? {
          bracket_stop_loss_price: currentOrder.bracket_stop_loss_price,
          bracket_take_profit_price: currentOrder.bracket_take_profit_price,
          bracket_stop_trigger_method: currentOrder.bracket_stop_trigger_method
        } : {})
      } };
    }
    if (method === 'GET' && path === '/v2/orders/102') {
      applyFilledOrder(102, 240);
      return { result: { id: 102, state: 'filled', size: 1, unfilled_size: 0, average_fill_price: 240 } };
    }
    if (method === 'DELETE' && path === '/v2/orders') {
      hedgeCanceled = true;
      return { success: true };
    }
    throw new Error('unexpected mock Delta request ' + method + ' ' + path);
  };

  const requestLive = async (method, path, params = {}) => {
    const response = await request(method, path, params, null);
    const scale = 1 + Number(liveQuoteMismatchPct || 0) / 100;
    return {
      ...response,
      result: Array.isArray(response?.result) ? response.result.map(row => ({
        ...row,
        quotes: {
          ...row.quotes,
          best_bid: Number(row?.quotes?.best_bid) * scale,
          best_ask: Number(row?.quotes?.best_ask) * scale
        },
        mark_price: Number(row.mark_price) * scale
      })) : response.result
    };
  };

  const executor = createDeltaOptionsExecution({
    env,
    request,
    requestLive,
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
    isMarketTickFresh: () => true,
    getRecentCloseDetails
  });
  return { executor, apiCalls, storedOrders, optionRows, logs };
}

test('Demo BUY limit entry with no fill is canceled and never leaves a resting order', async () => {
  const { executor, apiCalls, optionRows } = harness({
    strategy: 'OPTIONS_BUY',
    hedgeFilled: false
  });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1 });
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, quoteToken: preview.quoteToken
    }),
    error => error?.code === 'OPTIONS_ENTRY_NOT_FILLED'
  );
  assert.ok(apiCalls.some(call => call.method === 'DELETE' && call.path === '/v2/orders'));
  assert.equal(optionRows[0].status, 'CLOSED');
});

test('Demo bracket protection is verified through exchange reduce-only child orders when parent detail does not echo it', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    bracketEcho: false,
    bracketChildren: true
  });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1 });
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, quoteToken: preview.quoteToken
  });
  assert.equal(result.success, true);
  const activeOrderChecks = apiCalls.filter(call =>
    call.method === 'GET' && call.path === '/v2/orders'
  );
  assert.equal(activeOrderChecks.length, 1);
  assert.equal(result.positionVerification.verified, true);
});

test('Demo entry is reduced-only unwound if neither parent nor exchange child orders confirm SL/TP', async () => {
  const { executor, apiCalls, optionRows } = harness({
    strategy: 'OPTIONS_BUY',
    bracketEcho: false,
    bracketChildren: false
  });
  const preview = await executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1 });
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, quoteToken: preview.quoteToken
    }),
    error => error?.code === 'OPTIONS_EXCHANGE_BRACKET_UNVERIFIED'
  );
  const orderCalls = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders');
  assert.deepEqual(orderCalls.map(call => call.body.side), ['buy', 'sell']);
  assert.equal(orderCalls[1].body.reduce_only, true);
  assert.equal(optionRows[0].status, 'CLOSED');
  assert.ok(apiCalls.some(call => call.method === 'GET' && call.path === '/v2/positions/margined'));
});

test('XAUT options are accepted only when the exact gold contract exists in the Testnet product catalogue', async () => {
  const symbol = 'C-XAUT-4000-311226';
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    contractSymbol: symbol,
    contractUnderlying: 'XAUT',
    contractStrike: 4000
  });
  const preview = await executor.previewOptionsOrder({
    symbol, strategy: 'OPTIONS_BUY', qty: 1
  });
  assert.equal(preview.symbol, symbol);
  assert.equal(preview.contractId, 101);
  assert.ok(apiCalls.some(call => call.method === 'GET' && call.path === '/v2/products'));
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false,
    'preview must not submit an exchange order');
});

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
  assert.equal(Number(orderCalls[0].body.bracket_stop_loss_price), 637);
  assert.equal(Number(orderCalls[0].body.bracket_take_profit_price), 1365);
  assert.equal(result.fill.averageFillPrice, 910);
  assert.equal(result.positionVerification.verified, true);
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
  assert.equal(orderCalls[0].body.bracket_stop_loss_price, undefined);
  assert.ok(orderCalls[1].body.bracket_stop_loss_price);
  assert.ok(orderCalls[1].body.bracket_take_profit_price);
  assert.equal(result.positionVerification.verified, true);
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
    /Options execution is disabled by default|OPTIONS_EXECUTION_ALLOWED=true/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('manual Demo override previews and executes a score-qualified unconfirmed BUY without changing risk gates', async () => {
  const { executor, apiCalls, storedOrders } = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false } }
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
  });
  assert.equal(preview.manualTestOverride, true);
  assert.equal(preview.executionAllowed, true);
  assert.ok(preview.maxLossUsd <= preview.maxAllowedLossUsd);
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1,
    quoteToken: preview.quoteToken, manualTestOverride: true
  });
  assert.equal(result.success, true);
  assert.equal(apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders').length, 1);
  assert.equal(storedOrders[0].raw.manual_test_override, true);
});

test('manual Testnet override remains blocked when the dedicated flag is off', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    candidatePatch: { stage: 'SETUP', score: 42, details: { analysisReady: false } }
  });
  await assert.rejects(
    executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
    }),
    /OPTIONS_DEMO_LOG_ONLY_QUALITY_FILTERS=true/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('manual Testnet override keeps Delta and expiry qualification mandatory', async () => {
  const deltaCase = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false, delta: 0.99 } },
    settingsPatch: { options_buy_min_delta: 0.01, options_buy_max_delta: 0.99 }
  });
  await assert.rejects(
    deltaCase.executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
    }),
    /hard 0.05–0.95 validity band/
  );
  const configuredDeltaCase = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false, delta: 0.80 } }
  });
  await assert.rejects(
    configuredDeltaCase.executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
    }),
    /outside the configured BUY band/
  );
  const dteCase = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false } },
    settingsPatch: { options_max_days_to_expiry: 30 }
  });
  await assert.rejects(
    dteCase.executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
    }),
    /expiry is outside the configured DTE range/
  );
  assert.equal(deltaCase.apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
  assert.equal(configuredDeltaCase.apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
  assert.equal(dteCase.apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('manual Testnet override still enforces the configured maximum-loss budget', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false } },
    settingsPatch: { options_max_risk_pct: 0.001 }
  });
  await assert.rejects(
    executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
    }),
    /exceeds the permitted/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('manual Testnet SELL override still requires and executes its protective hedge first', async () => {
  const { executor, apiCalls, storedOrders } = harness({
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false } }
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, manualTestOverride: true
  });
  assert.equal(preview.manualTestOverride, true);
  assert.equal(preview.hedgeSymbol, HEDGE);
  const result = await executor.placeOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1,
    quoteToken: preview.quoteToken, manualTestOverride: true
  });
  assert.equal(result.success, true);
  const orders = apiCalls.filter(call => call.method === 'POST' && call.path === '/v2/orders');
  assert.deepEqual(orders.map(call => call.body.side), ['buy', 'sell']);
  assert.ok(storedOrders.every(row => row.raw.manual_test_override === true));
});

test('manual Testnet SELL override rejects a missing protective hedge', async () => {
  const { executor, apiCalls } = harness({
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false, hedgeSymbol: '' } }
  });
  await assert.rejects(
    executor.previewOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_SELL', qty: 1, manualTestOverride: true
    }),
    /protective hedge/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('manual override mode is cryptographically bound to the preview confirmation', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    manualOverrideEnabled: true,
    candidatePatch: { stage: 'SETUP', score: 95, details: { analysisReady: false } }
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
  });
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1,
      quoteToken: preview.quoteToken, manualTestOverride: false
    }),
    /manual-test mode/
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


test('Options preview fails closed when auto_trade is false', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    settingsPatch: { auto_trade: false }
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1
  });
  assert.equal(preview.executionAllowed, false);
  assert.match(preview.executionLockReason, /Auto Trade is off or unknown/);
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('Options final entry-safety recheck blocks when auto_trade turns off after preview', async () => {
  const settingsPatch = { auto_trade: true };
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    settingsPatch
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1
  });
  assert.equal(preview.executionAllowed, true);

  settingsPatch.auto_trade = false;
  await assert.rejects(
    executor.placeOptionsOrder({
      symbol: SHORT,
      strategy: 'OPTIONS_BUY',
      qty: 1,
      quoteToken: preview.quoteToken
    }),
    /Auto Trade is off or unknown/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});


test('Options daily loss at or beyond 2% of equity blocks new entries', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    closedOptionPositions: [{
      status: 'CLOSED',
      realized_pnl: -200,
      realized_pnl_verified: true
    }]
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1
  });
  assert.equal(preview.executionAllowed, false);
  assert.match(preview.executionLockReason, /daily loss limit reached/i);
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});

test('Demo manual quality override logs missing daily IV Percentile but keeps the candidate execution-safe', async () => {
  const { executor, apiCalls, logs } = harness({
    strategy: 'OPTIONS_BUY',
    candidatePatch: {
      iv_percentile: null,
      details: { ivPercentile: null }
    },
    manualOverrideEnabled: true
  });
  const preview = await executor.previewOptionsOrder({
    symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1, manualTestOverride: true
  });
  assert.equal(preview.executionAllowed, true);
  assert.ok(logs.some(args => args[2]?.qualityFiltersObserved?.some(filter => filter.code === 'IV_PCTL_UNAVAILABLE_DEMO_LOG_ONLY')));
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});


test('closed unverified Options positions reconcile exact exit fills from authenticated Demo history', async () => {
  const closed = {
    position_key: 'closed-option-1',
    symbol: SHORT,
    strategy: 'OPTIONS_BUY',
    side: 'BUY',
    qty: 1,
    contract_size: 0.001,
    entry_premium: 900,
    entry_order_id: '12345',
    opened_at: new Date(NOW - 60_000).toISOString(),
    closed_at: new Date(NOW).toISOString(),
    status: 'CLOSED',
    realized_pnl: null,
    realized_pnl_verified: false,
    raw: {}
  };
  let lookupArgs = null;
  const { executor, logs } = harness({
    strategy: 'OPTIONS_BUY',
    closedOptionPositions: [closed],
    getRecentCloseDetails: async (...args) => {
      lookupArgs = args;
      return {
        exit_price: 1100,
        realized_pnl: 0.2,
        fees: 0.001,
        fee_currency: 'USD',
        close_order_id: '98765',
        client_order_id: 'close-client-id',
        fill_type: 'normal',
        order_type: 'market_order',
        close_fill_history_complete: true
      };
    }
  });
  const result = await executor.monitorOptionsExits();
  assert.equal(result.closeFillReconciliation.scanned, 1);
  assert.equal(result.closeFillReconciliation.reconciled, 1);
  assert.equal(lookupArgs[0], SHORT);
  assert.equal(lookupArgs[2].product_id, 101);
  assert.equal(closed.short_exit_premium, 1100);
  assert.equal(closed.realized_pnl, 0.2);
  assert.equal(closed.realized_pnl_verified, true);
  assert.equal(closed.raw.exit_order_id, '98765');
  assert.ok(logs.some(row => row[1].includes('Externally closed Option fill reconciled')));
});


test('no_position_for_reduce_only stops repeat BUY exits and queues exact fill reconciliation', async () => {
  const position = {
    position_key: 'externally-flat-buy-1',
    symbol: SHORT,
    strategy: 'OPTIONS_BUY',
    side: 'BUY',
    qty: 1,
    contract_size: 0.001,
    entry_premium: 1500,
    current_premium: 1500,
    peak_premium: 1500,
    expiry_ms: NOW + 30 * 86_400_000,
    opened_at: new Date(NOW - 60_000).toISOString(),
    status: 'OPEN',
    realized_pnl: null,
    realized_pnl_verified: false,
    raw: {}
  };
  const { executor, apiCalls, logs } = harness({
    strategy: 'OPTIONS_BUY',
    openOptionPositions: [position],
    noPositionForReduceOnly: true
  });
  const first = await executor.monitorOptionsExits();
  assert.equal(first.monitored, 1);
  assert.equal(position.status, 'CLOSED');
  assert.equal(position.exit_reason, 'EXTERNAL_CLOSE_UNVERIFIED');
  assert.equal(position.realized_pnl, null);
  assert.equal(position.realized_pnl_verified, false);
  assert.equal(position.raw.external_close_confirmed_by_reduce_only_rejection, true);
  assert.equal(position.raw.exit_fill_reconciliation_pending, true);
  const firstExitAttempts = apiCalls.filter(call =>
    call.method === 'POST' && call.path === '/v2/orders' && call.body?.reduce_only === true
  ).length;
  assert.equal(firstExitAttempts, 1);
  await executor.monitorOptionsExits();
  const secondExitAttempts = apiCalls.filter(call =>
    call.method === 'POST' && call.path === '/v2/orders' && call.body?.reduce_only === true
  ).length;
  assert.equal(secondExitAttempts, 1);
  assert.ok(logs.some(row => row[1].includes('stopped repeat exit attempts')));
});


test('Hybrid Options preview blocks a large Live/Demo premium mismatch before any order', async () => {
  const { executor, apiCalls } = harness({
    strategy: 'OPTIONS_BUY',
    liveQuoteMismatchPct: 84
  });
  await assert.rejects(
    executor.previewOptionsOrder({ symbol: SHORT, strategy: 'OPTIONS_BUY', qty: 1 }),
    /Live\/Demo premium mismatch/
  );
  assert.equal(apiCalls.some(call => call.method === 'POST' && call.path === '/v2/orders'), false);
});
