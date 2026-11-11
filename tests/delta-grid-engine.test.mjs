import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeDeltaGridEntry, assessDeltaGridEntryFill, hasVerifiedGridBracket, cancelAndVerifyGridOrder, cancelUnverifiedGridEntry, calculateTrailingGridRange, getTrailingGridBreakoutDirection, pruneTrailingGridShiftTimestamps, executeTrailingGridShift, retryGridPnlRead, manageDeltaTestnetGrid } from '../worker/execution/delta-grid-engine.mjs';
import { applyGlobalGridProtectionHalt, manageDeltaTestnetMultiGrid } from '../worker/execution/delta-multi-grid-engine.mjs';

const candidate = {
  levelIndex: 6,
  entryPrice: 100,
  stopPrice: 99,
  targetPrice: 102,
  qty: 50,
  riskUsd: 50
};
const product = { contract_value: 1, tick_size: 0.01, taker_commission_rate: 0.0005 };

test('Testnet Grid widens a rung stop to the 1.50% floor and recomputes whole-contract risk', () => {
  const result = sizeDeltaGridEntry({
    candidate,
    settings: { grid_risk_per_trade_pct: 1, grid_daily_loss_pct: 2, grid_max_positions: 1, max_leverage: 3 },
    account: { equity: 10000, available: 10000 },
    product,
    riskEquity: 10000,
    remainingDailyRisk: 200
  });
  assert.equal(result.ok, true);
  assert.ok(result.stopPrice <= 98.5);
  assert.ok(result.stopDistancePct >= 1.5);
  assert.ok(result.qty >= 1);
  assert.ok(result.riskUsd <= 100 + 1e-8);
  assert.ok(result.rewardRiskRatio >= 1);
});

test('Testnet Grid normalizes a prior-rung stop to the 1.50% floor so symmetric grid rungs retain net 1R', () => {
  const result = sizeDeltaGridEntry({
    candidate: { ...candidate, stopPrice: 98 },
    settings: { grid_risk_per_trade_pct: 1, grid_daily_loss_pct: 2, grid_max_positions: 1, max_leverage: 3 },
    account: { equity: 10000, available: 10000 },
    product,
    riskEquity: 10000,
    remainingDailyRisk: 200
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopPrice, 98.5);
  assert.ok(result.rewardRiskRatio >= 1);
});

test('Testnet Grid caps each entry at 25% of available margin', () => {
  const result = sizeDeltaGridEntry({
    candidate,
    settings: { grid_risk_per_trade_pct: 1, grid_daily_loss_pct: 2, grid_max_positions: 1, max_leverage: 3 },
    account: { equity: 10000, available: 1000 },
    product,
    riskEquity: 10000,
    remainingDailyRisk: 200
  });
  assert.equal(result.ok, true);
  assert.ok(result.qty <= Math.floor((1000 * 0.25 * 3) / 100));
});

test('Testnet Grid skips a narrow rung when the widened stop removes its reward/risk edge', () => {
  const result = sizeDeltaGridEntry({
    candidate: { ...candidate, targetPrice: 101.2 },
    settings: { grid_risk_per_trade_pct: 1, grid_daily_loss_pct: 2, grid_max_positions: 1 },
    account: { equity: 10000, available: 10000 },
    product,
    riskEquity: 10000,
    remainingDailyRisk: 200
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GRID_REWARD_RISK_BELOW_MINIMUM');
});

test('Testnet Grid fails closed when the minimum contract exceeds remaining risk or margin', () => {
  const result = sizeDeltaGridEntry({
    candidate,
    settings: { grid_risk_per_trade_pct: 0.3, grid_daily_loss_pct: 2, grid_max_positions: 1, max_leverage: 1 },
    account: { equity: 100, available: 1 },
    product,
    riskEquity: 100,
    remainingDailyRisk: 0.2
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GRID_MINIMUM_CONTRACT_EXCEEDS_RISK_BUDGET');
});


test('Testnet Grid revalidates the actual market fill against its hard stop floor and risk budget', () => {
  const accepted = assessDeltaGridEntryFill({
    entryPrice: 100,
    stopPrice: 98.5,
    targetPrice: 102,
    qty: 10,
    product,
    riskBudget: 200,
    feeRate: 0.0005,
    slippageRate: 0.0002
  });
  assert.equal(accepted.ok, true);
  const stopTooClose = assessDeltaGridEntryFill({
    entryPrice: 99,
    stopPrice: 98.5,
    targetPrice: 102,
    qty: 10,
    product,
    riskBudget: 200
  });
  assert.equal(stopTooClose.ok, false);
  assert.equal(stopTooClose.reason, 'GRID_FILLED_STOP_BELOW_DELTA_MINIMUM');
  const riskExceeded = assessDeltaGridEntryFill({
    entryPrice: 101,
    stopPrice: 98.5,
    targetPrice: 105,
    qty: 100,
    product,
    riskBudget: 100
  });
  assert.equal(riskExceeded.ok, false);
  assert.equal(riskExceeded.reason, 'GRID_FILLED_RISK_BUDGET_EXCEEDED');
});


test('Grid bracket verification rejects a missing or mismatched exchange SL/TP', () => {
  assert.equal(hasVerifiedGridBracket({
    bracket_stop_loss_price: '98.50', bracket_take_profit_price: '102.00'
  }, 98.5, 102, 0.01), true);
  assert.equal(hasVerifiedGridBracket({
    bracket_stop_loss_price: '98.49', bracket_take_profit_price: '102.00'
  }, 98.5, 102, 0.01), false);
  assert.equal(hasVerifiedGridBracket({
    bracket_stop_loss_price: '98.50'
  }, 98.5, 102, 0.01), false);
});

test('Grid bracket verification failure cancels the exact exchange order and confirms CANCELLED by a fresh read', async () => {
  const calls = [];
  const executor = {
    async cancelOrderById(id) {
      calls.push(['cancel', id]);
      return { id, state: 'CANCELLED' };
    },
    async getOrderById(id) {
      calls.push(['get', id]);
      return { id, state: 'CANCELLED', unfilled_size: 10 };
    }
  };
  const failedOrder = { id: 987, state: 'OPEN', bracket_stop_loss_price: null, bracket_take_profit_price: '102' };
  assert.equal(hasVerifiedGridBracket(failedOrder, 98.5, 102, 0.01), false);
  const result = await cancelAndVerifyGridOrder({ executor, orderId: failedOrder.id });
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.orderId, 987);
  assert.deepEqual(calls, [['cancel', 987], ['get', 987]]);
});

test('Grid cancellation does not accept a FILLED or still-OPEN response as CANCELLED', async () => {
  const executor = {
    async cancelOrderById(id) { return { id, state: 'FILLED' }; },
    async getOrderById(id) { return { id, state: 'FILLED' }; }
  };
  await assert.rejects(
    cancelAndVerifyGridOrder({ executor, orderId: 987 }),
    /cancellation is unconfirmed/
  );
});

test('Grid releases the reservation only after cancellation is confirmed and halts the strategy', async () => {
  const updates = [];
  const logs = [];
  const state = {
    status: 'ENTRY_PENDING',
    pendingEntries: [{ symbol: 'PAXGUSD', exchangeOrderId: '987', clientOrderId: 'DDG-PAXGUSD-X' }],
    positions: [], events: []
  };
  const executor = {
    async cancelOrderById(id) { return { id, state: 'CANCELLED' }; },
    async getOrderById(id) { return { id, state: 'CANCELLED', unfilled_size: 10 }; },
    async getOpenPositions() { return []; }
  };
  const database = {
    async update(table, query, patch) { updates.push({ table, query, patch }); },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const result = await cancelUnverifiedGridEntry({
    executor, database, state, symbol: 'PAXGUSD', orderId: 987,
    clientOrderId: 'DDG-PAXGUSD-X', expectedStop: 98.5, expectedTarget: 102,
    raw: { reservation: true, stop_price: 98.5, tp_price: 102 },
    now: () => Date.parse('2026-11-06T07:00:00Z')
  });
  assert.equal(result.cancelled, true);
  assert.equal(state.status, 'HALTED');
  assert.equal(state.pausedReason, 'GRID_BRACKET_UNVERIFIED_CANCELLED');
  assert.deepEqual(state.pendingEntries, []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.state, 'CANCELLED');
  assert.equal(updates[0].patch.raw.reservation, false);
  assert.equal(logs[0].level, 'WARN');
});

test('Grid preserves reservation and emits CRITICAL when exchange cancellation cannot be confirmed', async () => {
  const updates = [];
  const logs = [];
  const state = {
    status: 'ENTRY_PENDING',
    pendingEntries: [{ symbol: 'NVDAXUSD', exchangeOrderId: '654', clientOrderId: 'DDG-NVDAXUSD-X' }],
    positions: [], events: []
  };
  const calls = [];
  const executor = {
    async cancelOrderById(id) { calls.push(['cancel', id]); throw new Error('exchange timeout'); },
    async getOrderById(id) { calls.push(['get', id]); return { id, state: 'OPEN' }; },
    async getOpenPositions() { return []; }
  };
  const database = {
    async update(...args) { updates.push(args); },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const result = await cancelUnverifiedGridEntry({
    executor, database, state, symbol: 'NVDAXUSD', orderId: 654,
    clientOrderId: 'DDG-NVDAXUSD-X', expectedStop: 180, expectedTarget: 190,
    raw: { reservation: true, stop_price: 180, tp_price: 190 },
    now: () => Date.parse('2026-11-06T07:00:00Z')
  });
  assert.equal(result.cancelled, false);
  assert.equal(state.status, 'HALTED');
  assert.equal(state.pausedReason, 'GRID_BRACKET_CANCEL_UNCONFIRMED');
  assert.equal(state.pendingEntries.length, 1);
  assert.equal(updates.length, 0);
  assert.equal(logs[0].level, 'CRITICAL');
  assert.equal(logs[0].data.reservationReleased, false);
  assert.deepEqual(calls, [['cancel', 654], ['get', 654]]);
});

test('Grid accepts a read-after-timeout only when Delta confirms the order is CANCELLED', async () => {
  const calls = [];
  const executor = {
    async cancelOrderById(id) { calls.push(['cancel', id]); throw new Error('response timeout after DELETE'); },
    async getOrderById(id) { calls.push(['get', id]); return { id, state: 'CANCELLED' }; }
  };
  const result = await cancelAndVerifyGridOrder({ executor, orderId: 321 });
  assert.equal(result.state, 'CANCELLED');
  assert.deepEqual(calls, [['cancel', 321], ['get', 321]]);
});


test('Grid protection failure halts both configured symbols immediately in the same multi-symbol cycle', () => {
  const states = {
    PAXGUSD: { status: 'ENTRY_PENDING', pendingEntries: [{ symbol: 'PAXGUSD' }], events: [] },
    NVDAXUSD: { status: 'HALTED', pausedReason: 'GRID_BRACKET_CANCEL_UNCONFIRMED', events: [] }
  };
  const halted = applyGlobalGridProtectionHalt(
    states, ['PAXGUSD', 'NVDAXUSD'], 'GRID_BRACKET_CANCEL_UNCONFIRMED',
    '2026-11-06T08:20:00.000Z'
  );
  assert.equal(halted.PAXGUSD.status, 'HALTED');
  assert.equal(halted.PAXGUSD.pausedReason, 'GRID_BRACKET_CANCEL_UNCONFIRMED');
  assert.equal(halted.NVDAXUSD.status, 'HALTED');
  assert.equal(halted.NVDAXUSD.pausedReason, 'GRID_BRACKET_CANCEL_UNCONFIRMED');
  assert.equal(halted.PAXGUSD.pendingEntries.length, 1);
});


test('Trailing Grid shifts the breached range outward by the configured 10% bands', () => {
  const up = calculateTrailingGridRange({
    direction: 'UP', lowerPrice: 90, upperPrice: 100, breakoutExitPct: 1.2, maxRangePct: 50
  });
  assert.equal(up.ok, true);
  assert.equal(up.lowerPrice, 90);
  assert.ok(up.upperPrice > 111.31 && up.upperPrice < 111.33);

  const down = calculateTrailingGridRange({
    direction: 'DOWN', lowerPrice: 90, upperPrice: 100, breakoutExitPct: 1.2, maxRangePct: 50
  });
  assert.equal(down.ok, true);
  assert.ok(down.lowerPrice > 80.02 && down.lowerPrice < 80.04);
  assert.equal(down.upperPrice, 99);
  assert.ok(down.upperPrice > down.lowerPrice);
});

test('Trailing Grid breakout triggers at the configured 1.2% upper and lower thresholds', () => {
  const config = { lowerPrice: 100, upperPrice: 200, breakoutExitPct: 1.2 };
  assert.equal(getTrailingGridBreakoutDirection(202.4, config), 'UP');
  assert.equal(getTrailingGridBreakoutDirection(98.8, config), 'DOWN');
  assert.equal(getTrailingGridBreakoutDirection(201, config), null);
  assert.equal(getTrailingGridBreakoutDirection(99, config), null);
});

test('Trailing Grid counts only distinct shifts inside the preceding rolling hour', () => {
  const now = Date.parse('2026-11-07T06:00:00.000Z');
  const retained = pruneTrailingGridShiftTimestamps([
    '2026-11-07T04:59:59.999Z',
    '2026-11-07T05:00:00.000Z',
    '2026-11-07T05:30:00.000Z',
    '2026-11-07T05:30:00.000Z',
    '2026-11-07T06:00:01.000Z'
  ], now);
  assert.deepEqual(retained, ['2026-11-07T05:30:00.000Z']);
});

test('Trailing Grid market shift cancels pending Grid entries and verifies all Grid positions flat before saving new bounds', async () => {
  const calls = [];
  const updates = [];
  const logs = [];
  const state = {
    version: 2, executionMode: 'DELTA_TESTNET', status: 'ACTIVE',
    positions: [{ symbol: 'PAXGUSD', qty: 1 }], pendingEntries: [],
    trailingShiftTimestamps: [], events: []
  };
  const orderStates = new Map([[101, 'OPEN'], [202, 'OPEN']]);
  const orders = [
    { id: 1, strategy: 'GRID', role: 'ENTRY', symbol: 'PAXGUSD',
      client_order_id: 'DDG-PAXGUSD-A', state: 'OPEN',
      raw: { testnet_order_id: 101, reservation: true } },
    { id: 2, strategy: 'GRID', role: 'ENTRY', symbol: 'NVDAXUSD',
      client_order_id: 'DDG-NVDAXUSD-B', state: 'OPEN',
      raw: { testnet_order_id: 202, reservation: true } }
  ];
  let positions = [
    { symbol: 'PAXGUSD', side: 'BUY', qty: 2, entry_price: 4000, client_order_id: 'DDG-PAXGUSD-A' },
    { symbol: 'NVDAXUSD', side: 'BUY', qty: 3, entry_price: 180, client_order_id: 'DDG-NVDAXUSD-B' }
  ];
  const executor = {
    async getOrderById(id) {
      calls.push(['getOrder', id]);
      return { id, state: orderStates.get(id) || 'UNKNOWN' };
    },
    async cancelOrderById(id) {
      calls.push(['cancelOrder', id]);
      orderStates.set(id, 'CANCELLED');
      return { id, state: 'CANCELLED' };
    },
    async getOpenPositions() {
      calls.push(['positions']);
      return positions.map(row => ({ ...row }));
    },
    async closePosition(symbol, qty) {
      calls.push(['closeMarket', symbol, qty]);
      positions = positions.filter(row => row.symbol !== symbol);
      return { id: 'close-' + symbol, state: 'FILLED', order_type: 'market_order', reduce_only: true };
    }
  };
  const database = {
    async select(table, query) {
      calls.push(['select', table, query]);
      const symbol = query.includes('PAXGUSD') ? 'PAXGUSD' : 'NVDAXUSD';
      return [{
        id: 'db-' + symbol, symbol, strategy: 'GRID',
        qty: symbol === 'PAXGUSD' ? 2 : 3, side: 'BUY',
        entry_price: symbol === 'PAXGUSD' ? 4000 : 180,
        client_order_id: symbol === 'PAXGUSD' ? 'DDG-PAXGUSD-A' : 'DDG-NVDAXUSD-B'
      }];
    },
    async update(table, query, patch) { updates.push({ table, query, patch }); },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const result = await executeTrailingGridShift({
    executor, database, state,
    settings: {
      grid_symbol_configs: {
        PAXGUSD: { lowerPrice: 4000, upperPrice: 4200, levelsCount: 10 },
        NVDAXUSD: { lowerPrice: 175, upperPrice: 190, levelsCount: 10 }
      },
      gridGlobalTrailingShiftTimestamps: [],
      grid_min_range_pct: 2, grid_max_range_pct: 50
    },
    symbol: 'PAXGUSD',
    configuredSymbols: ['PAXGUSD', 'NVDAXUSD'],
    currentConfig: { lowerPrice: 4000, upperPrice: 4200, levelsCount: 10, breakoutExitPct: 1.2 },
    markPrice: 4250.4,
    direction: 'UP',
    dbOpenGridRows: [
      { symbol: 'PAXGUSD', strategy: 'GRID' },
      { symbol: 'NVDAXUSD', strategy: 'GRID' }
    ],
    gridOrders: orders,
    now: () => Date.parse('2026-11-07T06:00:00.000Z')
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter(row => row[0] === 'cancelOrder').map(row => row[1]), [101, 202]);
  assert.deepEqual(calls.filter(row => row[0] === 'closeMarket').map(row => row.slice(1)), [
    ['PAXGUSD', 2], ['NVDAXUSD', 3]
  ]);
  assert.equal(positions.length, 0);
  const settingsUpdate = updates.find(row => row.table === 'dd_settings');
  assert.equal(settingsUpdate.patch.grid_symbol_configs.PAXGUSD.lowerPrice, 3780);
  assert.ok(settingsUpdate.patch.grid_symbol_configs.PAXGUSD.upperPrice > 4660);
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.pendingEntries.length, 0);
  assert.equal(result.state.events.at(-1).type, 'SHIFT');
  assert.equal(result.state.events.at(-1).pnlPendingReconciliation, true);
  assert.ok(logs.some(row => row.message.includes('Shifted Grid UP')));
});

test('Trailing Grid halts before a fourth shift in the rolling hour', async () => {
  const now = Date.parse('2026-11-07T06:00:00.000Z');
  const updates = [];
  const logs = [];
  const result = await executeTrailingGridShift({
    executor: { async getOpenPositions() { throw new Error('must not reach exchange'); } },
    database: {
      async update(table, query, patch) { updates.push(patch); },
      async log(level, message, data) { logs.push({ level, message, data }); }
    },
    state: { status: 'ACTIVE', positions: [], pendingEntries: [], events: [] },
    settings: { gridGlobalTrailingShiftTimestamps: [
      '2026-11-07T05:10:00.000Z',
      '2026-11-07T05:20:00.000Z',
      '2026-11-07T05:40:00.000Z'
    ] },
    symbol: 'PAXGUSD', configuredSymbols: ['PAXGUSD', 'NVDAXUSD'],
    currentConfig: { lowerPrice: 100, upperPrice: 120, breakoutExitPct: 1.2 },
    markPrice: 122, direction: 'UP',
    now: () => now
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GRID_TRAILING_SHIFT_LIMIT');
  assert.equal(result.state.status, 'HALTED');
  assert.equal(result.state.pausedReason, 'GRID_TRAILING_SHIFT_LIMIT');
  assert.equal(updates.length, 1);
  assert.equal(logs[0].level, 'CRITICAL');
});


test('Trailing Grid refuses to close exchange exposure without a matching Grid-owned database identity', async () => {
  const updates = [];
  const logs = [];
  let cancelCalls = 0;
  const result = await executeTrailingGridShift({
    executor: {
      async getOpenPositions() {
        return [{
          symbol: 'PAXGUSD', side: 'BUY', qty: 2, entry_price: 4000,
          client_order_id: 'SCALP-ENTRY-1'
        }];
      },
      async getOrderById() { return { id: 5, state: 'OPEN' }; },
      async cancelOrderById() { cancelCalls += 1; }
    },
    database: {
      async select(table, query) {
        if (query.includes('NVDAXUSD')) return [];
        return [{
          id: 'db-paxg', symbol: 'PAXGUSD', strategy: 'SCALPING',
          qty: 2, side: 'BUY', entry_price: 4000, client_order_id: 'SCALP-ENTRY-1'
        }];
      },
      async update(table, query, patch) { updates.push(patch); },
      async log(level, message, data) { logs.push({ level, message, data }); }
    },
    state: { status: 'ACTIVE', positions: [], pendingEntries: [], events: [] },
    settings: {},
    symbol: 'PAXGUSD', configuredSymbols: ['PAXGUSD', 'NVDAXUSD'],
    currentConfig: { lowerPrice: 100, upperPrice: 120, breakoutExitPct: 1.2 },
    markPrice: 122, direction: 'UP',
    now: () => Date.parse('2026-11-07T06:00:00.000Z')
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GRID_TRAILING_SHIFT_UNCONFIRMED');
  assert.equal(cancelCalls, 0);
  assert.equal(updates.length, 1);
  assert.equal(logs[0].level, 'CRITICAL');
});


test('Trailing shift on the active symbol ignores a separately paused PAXGUSD Futures position', async () => {
  const queries = [];
  const updates = [];
  const positionQueries = [];
  const paxgPosition = {
    symbol: 'PAXGUSD', side: 'SELL', qty: 61, entry_price: 4089.23,
    client_order_id: 'SCALP-PAXGUSD-OPEN',
    sl_price: 4150.5, tp_price: 3935.8
  };
  const configs = {
    PAXGUSD: {
      lowerPrice: 4023.41985362, upperPrice: 4186.4787822,
      levelsCount: 10, paused: true
    },
    NVDAXUSD: {
      lowerPrice: 171.845378743, upperPrice: 193.109664457,
      levelsCount: 10, paused: false
    }
  };
  const result = await executeTrailingGridShift({
    executor: {
      async getOpenPositions({ symbols } = {}) {
        positionQueries.push(symbols);
        assert.deepEqual(symbols, ['NVDAXUSD']);
        // The API product_ids filter keeps PAXG's exchange position and
        // brackets out of this Grid snapshot altogether.
        return [];
      },
      async getOrderById() { throw new Error('No pending Grid order should be read'); },
      async cancelOrderById() { throw new Error('No PAXG or NVDAX order should be cancelled'); },
      async closePosition() { throw new Error('No position should be closed during this flat NVDAX shift'); }
    },
    database: {
      async select(table, query) {
        queries.push({ table, query });
        assert.match(query, /NVDAXUSD/);
        assert.doesNotMatch(query, /PAXGUSD/);
        return [];
      },
      async update(table, query, patch) { updates.push({ table, query, patch }); },
      async log() {}
    },
    state: { status: 'ACTIVE', pausedReason: null, positions: [], pendingEntries: [], events: [] },
    settings: {
      grid_symbol_configs: configs,
      gridGlobalTrailingShiftTimestamps: [],
      grid_min_range_pct: 2,
      grid_max_range_pct: 20
    },
    symbol: 'NVDAXUSD',
    configuredSymbols: ['NVDAXUSD'],
    currentConfig: {
      lowerPrice: configs.NVDAXUSD.lowerPrice,
      upperPrice: configs.NVDAXUSD.upperPrice,
      levelsCount: 10,
      breakoutExitPct: 1.2
    },
    markPrice: 169.43844471,
    direction: 'DOWN',
    dbOpenGridRows: [],
    gridOrders: [],
    now: () => Date.parse('2026-11-11T03:00:00.000Z')
  });
  assert.equal(result.ok, true);
  assert.equal(result.shifted, true);
  assert.equal(updates.length, 1);
  const savedConfigs = updates[0].patch.grid_symbol_configs;
  assert.equal(savedConfigs.PAXGUSD.paused, true);
  assert.equal(savedConfigs.PAXGUSD.lowerPrice, configs.PAXGUSD.lowerPrice);
  assert.ok(savedConfigs.NVDAXUSD.lowerPrice < configs.NVDAXUSD.lowerPrice);
  assert.equal(paxgPosition.qty, 61);
  assert.equal(paxgPosition.side, 'SELL');
  assert.equal(queries.length, 1);
  assert.equal(positionQueries.length, 3);
  assert.deepEqual(positionQueries, [['NVDAXUSD'], ['NVDAXUSD'], ['NVDAXUSD']]);
  assert.equal(paxgPosition.sl_price, 4150.5);
  assert.equal(paxgPosition.tp_price, 3935.8);
});

test('Trailing Grid shifts retain the 10% shift but clamp width to configured ATR limits', () => {
  const narrow = calculateTrailingGridRange({
    direction: 'UP', lowerPrice: 100, upperPrice: 101,
    breakoutExitPct: 1.2, shiftPct: 10, minRangePct: 2, maxRangePct: 20
  });
  assert.equal(narrow.ok, true);
  assert.equal(narrow.clamped, true);
  assert.ok(narrow.widthPct >= 2 && narrow.widthPct <= 20);
  const wide = calculateTrailingGridRange({
    direction: 'UP', lowerPrice: 100, upperPrice: 140,
    breakoutExitPct: 1.2, shiftPct: 10, minRangePct: 2, maxRangePct: 20
  });
  assert.equal(wide.ok, true);
  assert.equal(wide.clamped, true);
  assert.ok(wide.widthPct <= 20 + 1e-8);
});

test('global 1.2% Grid range break halts every configured symbol', () => {
  const states = {
    PAXGUSD: { status: 'ACTIVE', positions: [{ symbol: 'PAXGUSD', qty: 1 }] },
    NVDAXUSD: { status: 'ACTIVE', positions: [{ symbol: 'NVDAXUSD', qty: 1 }] }
  };
  const halted = applyGlobalGridProtectionHalt(states, ['PAXGUSD', 'NVDAXUSD'], 'GRID_RANGE_BREAK', '2026-11-10T00:00:00.000Z');
  assert.equal(halted.PAXGUSD.status, 'HALTED');
  assert.equal(halted.NVDAXUSD.status, 'HALTED');
  assert.equal(halted.PAXGUSD.pausedReason, 'GRID_RANGE_BREAK');
});


test('Grid P&L verifier retries a transient read failure and succeeds without persisting a halt', async () => {
  let calls = 0;
  const delays = [];
  const logs = [];
  const result = await retryGridPnlRead({
    request: 'closed_positions',
    read: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary fetch failed');
      return [];
    },
    validate: Array.isArray,
    sleepFn: async ms => delays.push(ms),
    database: { async log(...args) { logs.push(args); } }
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(logs.length, 0);
});

test('Grid P&L verifier fails closed and logs the exact request after bounded retries', async () => {
  let calls = 0;
  const delays = [];
  const logs = [];
  await assert.rejects(
    retryGridPnlRead({
      request: 'grid_trades_count',
      read: async () => {
        calls += 1;
        throw new Error('count endpoint unavailable');
      },
      validate: value => Number.isInteger(value) && value >= 0,
      sleepFn: async ms => delays.push(ms),
      database: { async log(...args) { logs.push(args); } }
    }),
    error => error.request === 'grid_trades_count' && /failed after 4 attempts/.test(error.message)
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].event, 'grid_pnl_verify_failed');
  assert.equal(logs[0][2].request, 'grid_trades_count');
  assert.match(logs[0][2].error, /count endpoint unavailable/);
});

function makeGridPnlRecoveryFixture({ exchangePositions = [], dbOpenGridRows = [], gridOrders = [] } = {}) {
  const now = Date.parse('2026-11-10T08:00:00.000Z');
  const updates = [];
  const logs = [];
  const database = {
    async select(table, query) {
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=in.')) return [];
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=eq.OPEN')) return dbOpenGridRows;
      if (table === 'dd_delta_positions' && query.startsWith('symbol=eq.')) return [];
      if (table === 'dd_trades') return [];
      if (table === 'dd_orders') return gridOrders;
      return [];
    },
    async count() { return 0; },
    async update(table, query, patch) { updates.push({ table, query, patch }); },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const executor = {
    async getOpenPositions() { return exchangePositions; }
  };
  const state = {
    version: 2,
    executionMode: 'DELTA_TESTNET',
    symbol: 'PAXGUSD',
    status: 'HALTED',
    pausedReason: 'GRID_PNL_UNVERIFIED',
    positions: [{ symbol: 'PAXGUSD', qty: 1, riskUsd: 5 }],
    pendingEntries: [],
    trades: [],
    events: [],
    realizedPnl: null,
    dayPnl: null,
    strategyStartEquity: 1000,
    dayStartEquity: 1000,
    currentEquity: 1000,
    highWaterEquity: 1000,
    tradeDate: '2026-11-10',
    wasEnabled: false,
    lastPrice: 0
  };
  const settings = {
    grid_symbol: 'PAXGUSD',
    grid_lower_price: 100,
    grid_upper_price: 110,
    grid_levels_count: 10,
    grid_max_positions: 1,
    grid_risk_per_trade_pct: 0.3,
    grid_enabled: true,
    auto_trade: true,
    enabled: true,
    continuous_mode: true,
    max_leverage: 3,
    grid_state: state,
    gridSymbols: ['PAXGUSD', 'NVDAXUSD'],
    // Multi-symbol manager propagates a per-symbol P&L pause through this field.
    gridGlobalPauseReason: 'GRID_PNL_UNVERIFIED'
  };
  return {
    now, database, executor, state, settings, updates, logs,
    input: {
      settings,
      account: { privateApiAvailable: true, equity: 1000, available: 1000 },
      ticker: { mark_price: 105 },
      product: { contract_value: 1, tick_size: 0.01, taker_commission_rate: 0.0005 },
      candles: Array.from({ length: 6 }, () => ({ open: 105, high: 105, low: 105, close: 105 })),
      dataFresh: true,
      database,
      executor,
      now: () => now
    }
  };
}

test('Grid automatically resumes after P&L verification succeeds and all configured symbols are flat', async () => {
  const fixture = makeGridPnlRecoveryFixture();
  const result = await manageDeltaTestnetGrid(fixture.input);
  assert.equal(result.state.pausedReason, null);
  assert.equal(result.state.status, 'ACTIVE');
  assert.deepEqual(result.state.positions, []);
  assert.deepEqual(result.state.pendingEntries, []);
  assert.equal(result.safety.blocked, false);
  assert.ok(fixture.logs.some(row =>
    row.message === '[GRID] P&L verification recovered; resuming Grid cycle'
  ));
});

test('Grid P&L recovery remains blocked when an exchange position is still open', async () => {
  const fixture = makeGridPnlRecoveryFixture({
    exchangePositions: [{
      symbol: 'PAXGUSD', side: 'BUY', qty: 1, entry_price: 104,
      client_order_id: 'DDG-PAXGUSD-OPEN'
    }]
  });
  const result = await manageDeltaTestnetGrid(fixture.input);
  assert.equal(result.state.pausedReason, 'GRID_PNL_UNVERIFIED');
  assert.equal(result.state.status, 'HALTED');
  assert.equal(result.safety.blocked, true);
  assert.equal(result.safety.reason, 'GRID_PNL_UNVERIFIED');
  assert.equal(fixture.logs.some(row =>
    row.message === '[GRID] P&L verification recovered; resuming Grid cycle'
  ), false);
});

test('Grid P&L recovery remains blocked when an active Grid order or reservation remains', async () => {
  const fixture = makeGridPnlRecoveryFixture({
    gridOrders: [{
      id: 'grid-entry-1', symbol: 'NVDAXUSD', strategy: 'GRID',
      role: 'ENTRY', state: 'OPEN', client_order_id: 'DDG-NVDAXUSD-OPEN'
    }]
  });
  const result = await manageDeltaTestnetGrid(fixture.input);
  assert.equal(result.state.pausedReason, 'GRID_PNL_UNVERIFIED');
  assert.equal(result.state.status, 'HALTED');
  assert.equal(result.safety.blocked, true);
  assert.equal(fixture.logs.some(row =>
    row.message === '[GRID] P&L verification recovered; resuming Grid cycle'
  ), false);
});


test('Grid remains fail-closed when the P&L database request fails persistently', async () => {
  const fixture = makeGridPnlRecoveryFixture();
  let failedReadCalls = 0;
  fixture.database.select = async (table, query) => {
    if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=in.')) {
      failedReadCalls += 1;
      throw new Error('persistent Supabase fetch failure');
    }
    if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=eq.OPEN')) return [];
    if (table === 'dd_delta_positions' && query.startsWith('symbol=eq.')) return [];
    if (table === 'dd_trades') return [];
    if (table === 'dd_orders') return [];
    return [];
  };
  fixture.input.sleepFn = async () => {};
  const result = await manageDeltaTestnetGrid(fixture.input);
  assert.equal(failedReadCalls, 4);
  assert.equal(result.state.pausedReason, 'GRID_PNL_UNVERIFIED');
  assert.equal(result.state.status, 'HALTED');
  assert.equal(result.safety.blocked, true);
  assert.equal(result.safety.reason, 'GRID_PNL_UNVERIFIED');
  assert.ok(fixture.logs.some(row =>
    row.data?.event === 'grid_pnl_verify_failed' &&
    row.data?.request === 'closed_positions'
  ));
});


test('multi-symbol manager accepts one active symbol after the other is paused in DB config', async () => {
  const now = Date.parse('2026-11-11T03:00:00.000Z');
  const updates = [];
  const database = {
    async select(table, query) {
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=in.')) return [];
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=eq.OPEN')) return [];
      if (table === 'dd_delta_positions' && query.startsWith('symbol=eq.NVDAXUSD')) return [];
      if (table === 'dd_trades' || table === 'dd_orders') return [];
      return [];
    },
    async count() { return 0; },
    async update(table, query, patch) { updates.push({ table, query, patch }); },
    async log() {}
  };
  const executor = { async getOpenPositions() { return []; } };
  const nvdaxState = {
    version: 2, executionMode: 'DELTA_TESTNET', symbol: 'NVDAXUSD',
    status: 'PAUSED', pausedReason: null, positions: [], pendingEntries: [],
    trades: [], events: [], realizedPnl: 0, dayPnl: 0,
    strategyStartEquity: 50000, dayStartEquity: 50000,
    currentEquity: 50000, highWaterEquity: 50000,
    tradeDate: '2026-11-11', wasEnabled: true, lastPrice: 0
  };
  const result = await manageDeltaTestnetMultiGrid({
    settings: {
      grid_enabled: true,
      auto_trade: false,
      enabled: true,
      continuous_mode: true,
      max_leverage: 3,
      grid_risk_per_trade_pct: 0.3,
      grid_state: {
        version: 3, executionMode: 'DELTA_TESTNET',
        symbolStates: {
          PAXGUSD: { status: 'HALTED', pausedReason: 'GRID_TRAILING_SHIFT_UNCONFIRMED', positions: [], pendingEntries: [] },
          NVDAXUSD: nvdaxState
        }
      },
      grid_symbol_configs: {
        PAXGUSD: { paused: true, lowerPrice: 4023, upperPrice: 4186, levelsCount: 10 },
        NVDAXUSD: { paused: false, lowerPrice: 171, upperPrice: 193, levelsCount: 10, atr_14d: 2, atr_pct: 1.1, atr_snapshot_status: 'READY' }
      },
      gridTrailingEnvironmentEnabled: true,
      grid_trailing_enabled: true
    },
    account: { privateApiAvailable: true, equity: 50000, available: 1000 },
    symbols: ['NVDAXUSD'],
    tickers: { NVDAXUSD: { mark_price: 180 } },
    products: { NVDAXUSD: { contract_value: 1, tick_size: 0.01, taker_commission_rate: 0.0005 } },
    candlesBySymbol: {
      NVDAXUSD: Array.from({ length: 6 }, () => ({ open: 180, high: 180, low: 180, close: 180 }))
    },
    freshnessBySymbol: { NVDAXUSD: true },
    database,
    executor,
    now: () => now
  });
  assert.equal(result.safety.blocked, true);
  assert.equal(result.safety.reason, 'AUTO_TRADE_DISABLED');
  assert.equal(result.safety.symbols?.length ?? 0, 1);
  assert.equal(result.safety.symbols[0].symbol, 'NVDAXUSD');
  assert.deepEqual(Object.keys(result.state.symbolSummaries), ['NVDAXUSD']);
  assert.ok(updates.length > 0);
});


function makeDynamicGridPoolFixture({
  symbols = ['PAXGUSD', 'NVDAXUSD', 'XAUTUSD'],
  exchangePositions = [],
  databasePositions = [],
  previousGridState = {},
  maxConcurrentSymbols = 2,
  tickerOverrides = {},
  autoTrade = false,
  pausedSymbols = [],
  logs: initialLogs = []
} = {}) {
  const now = Date.parse('2026-11-11T03:00:00.000Z');
  const updates = [];
  const logs = [...initialLogs];
  const gridOrders = [];
  const configs = Object.fromEntries(symbols.map(symbol => [symbol, {
    lowerPrice: 100, upperPrice: 110, levelsCount: 10,
    atr_14d: 2, atr_pct: 1.9, atr_snapshot_status: 'READY',
    atr: 2, atrPct: 1.9, widthPct: 4,
    paused: pausedSymbols.includes(symbol)
  }]));
  const tickers = Object.fromEntries(symbols.map((symbol, index) => [symbol, {
    mark_price: 105,
    turnover_usd: 1000 - index * 100,
    quotes: { best_bid: 104.99, best_ask: 105.01 },
    ...(tickerOverrides[symbol] || {})
  }]));
  const products = Object.fromEntries(symbols.map(symbol => [symbol, {
    id: 100 + symbols.indexOf(symbol),
    symbol,
    contract_value: 1,
    tick_size: 0.01,
    taker_commission_rate: 0.0005
  }]));
  const candlesBySymbol = Object.fromEntries(symbols.map(symbol => [symbol,
    Array.from({ length: 6 }, () => ({ open: 105, high: 105, low: 105, close: 105 }))
  ]));
  const database = {
    async select(table, query) {
      if (table === 'dd_delta_positions' && query.startsWith('symbol=in.(')) {
        const filter = query.slice('symbol=in.('.length).split(')')[0].split(',');
        return databasePositions.filter(row => filter.includes(String(row.symbol).toUpperCase()));
      }
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=in.')) return [];
      if (table === 'dd_delta_positions' && query.startsWith('strategy=eq.GRID&status=eq.OPEN')) {
        return databasePositions.filter(row => String(row.strategy).toUpperCase() === 'GRID');
      }
      if (table === 'dd_delta_positions' && query.startsWith('symbol=eq.')) {
        const symbol = decodeURIComponent(query.slice('symbol=eq.'.length).split('&')[0]);
        return databasePositions.filter(row => row.symbol === symbol);
      }
      if (table === 'dd_orders' && query.startsWith('symbol=in.(')) {
        const filter = query.slice('symbol=in.('.length).split(')')[0].split(',');
        return gridOrders.filter(row => filter.includes(String(row.symbol).toUpperCase()));
      }
      if (table === 'dd_orders' && query.startsWith('strategy=eq.GRID')) return gridOrders;
      if (table === 'dd_trades') return [];
      if (table === 'dd_engine_logs') return [];
      return [];
    },
    async count() { return 0; },
    async update(table, query, patch) { updates.push({ table, query, patch }); },
    async log(level, message, data) { logs.push({ level, message, data }); }
  };
  const executor = {
    async getOpenPositions({ symbols: scopedSymbols } = {}) {
      return Array.isArray(scopedSymbols)
        ? exchangePositions.filter(row => scopedSymbols.includes(String(row.symbol).toUpperCase()))
        : exchangePositions;
    },
    async getOpenOrders({ symbols: scopedSymbols } = {}) {
      return Array.isArray(scopedSymbols) ? [] : [];
    }
  };
  const input = {
    settings: {
      grid_enabled: true,
      auto_trade: autoTrade,
      enabled: true,
      continuous_mode: true,
      emergency_stop: false,
      max_leverage: 3,
      grid_risk_per_trade_pct: 0.3,
      grid_daily_loss_pct: 2,
      grid_max_drawdown_pct: 5,
      grid_state: previousGridState,
      grid_symbol_configs: configs,
      grid_trailing_enabled: false,
      max_grid_positions: maxConcurrentSymbols,
      gridMaxConcurrentSymbols: maxConcurrentSymbols
    },
    account: { privateApiAvailable: true, equity: 50000, available: 10000 },
    symbols,
    maxConcurrentSymbols,
    tickers,
    products,
    candlesBySymbol,
    freshnessBySymbol: Object.fromEntries(symbols.map(symbol => [symbol, true])),
    database,
    executor,
    now: () => now
  };
  return { input, database, executor, updates, logs, configs, tickers, products };
}

test('Dynamic Grid skips Futures-owned PAXG and continues with the best two eligible symbols', async () => {
  const fixture = makeDynamicGridPoolFixture({
    exchangePositions: [{
      id: 119, symbol: 'PAXGUSD', side: 'SELL', qty: 61, entry_price: 4089.23,
      client_order_id: 'SCALP-PAXGUSD-OPEN', order_id: '2177855282'
    }],
    databasePositions: [{
      id: 119, symbol: 'PAXGUSD', strategy: 'SCALPING', side: 'SELL',
      qty: 61, entry_price: 4089.23, entry_order_id: '2177855282',
      client_order_id: 'SCALP-PAXGUSD-OPEN'
    }],
    tickerOverrides: {
      NVDAXUSD: { turnover_usd: 1000, quotes: { best_bid: 104.99, best_ask: 105.02 } },
      XAUTUSD: { turnover_usd: 2000, quotes: { best_bid: 104.99, best_ask: 105.005 } }
    }
  });
  const result = await manageDeltaTestnetMultiGrid(fixture.input);
  assert.deepEqual(result.activeSymbols, ['XAUTUSD', 'NVDAXUSD']);
  assert.ok(result.skippedSymbols.includes('PAXGUSD'));
  assert.equal(result.symbolStatuses.PAXGUSD.status, 'SKIPPED');
  assert.equal(result.symbolStatuses.PAXGUSD.blockingPosition.id, 119);
  assert.equal(result.symbolStatuses.PAXGUSD.blockingPosition.orderId, '2177855282');
  assert.ok(fixture.logs.some(row =>
    row.message === '[GRID] Symbol PAXGUSD skipped: Futures position detected (id=119). Continuing with XAUTUSD.'
  ));
  assert.equal(result.safety.reason, 'AUTO_TRADE_DISABLED');
  assert.equal(result.safety.symbols.some(row => row.symbol === 'PAXGUSD'), false);
});

test('Dynamic Grid automatically re-admits PAXG after the Futures position closes', async () => {
  const first = makeDynamicGridPoolFixture({
    symbols: ['PAXGUSD', 'NVDAXUSD'],
    exchangePositions: [{
      id: 119, symbol: 'PAXGUSD', side: 'SELL', qty: 61, entry_price: 4089.23,
      client_order_id: 'SCALP-PAXGUSD-OPEN'
    }],
    databasePositions: [{
      id: 119, symbol: 'PAXGUSD', strategy: 'SCALPING', side: 'SELL',
      qty: 61, entry_price: 4089.23, entry_order_id: '2177855282',
      client_order_id: 'SCALP-PAXGUSD-OPEN'
    }],
    maxConcurrentSymbols: 1
  });
  const skipped = await manageDeltaTestnetMultiGrid(first.input);
  assert.equal(skipped.symbolStatuses.PAXGUSD.status, 'SKIPPED');
  const second = makeDynamicGridPoolFixture({
    symbols: ['PAXGUSD', 'NVDAXUSD'],
    previousGridState: skipped.state,
    maxConcurrentSymbols: 1,
    tickerOverrides: {
      PAXGUSD: { turnover_usd: 2000 },
      NVDAXUSD: { turnover_usd: 1000 }
    }
  });
  const resumed = await manageDeltaTestnetMultiGrid(second.input);
  assert.deepEqual(resumed.activeSymbols, ['PAXGUSD']);
  // The ownership handoff is complete and PAXG is selected again. This
  // test intentionally keeps Auto Trade off, so final execution status can
  // remain PAUSED/PENDING under the global execution gate.
  assert.ok(['PENDING', 'PAUSED'].includes(resumed.symbolStatuses.PAXGUSD.status));
  assert.ok(second.logs.some(row =>
    row.message === '[GRID] Symbol PAXGUSD re-eligible: Futures position closed. Resuming Grid on this symbol.'
  ));
});

test('Dynamic Grid waits without halting when every pool symbol is owned by Futures', async () => {
  const symbols = ['PAXGUSD', 'NVDAXUSD'];
  const exchangePositions = symbols.map((symbol, index) => ({
    id: 119 + index, symbol, side: 'SELL', qty: 1, entry_price: 100,
    client_order_id: 'SCALP-' + symbol,
    order_id: String(2000 + index)
  }));
  const databasePositions = symbols.map((symbol, index) => ({
    id: 119 + index, symbol, strategy: 'SCALPING', side: 'SELL', qty: 1,
    entry_price: 100, entry_order_id: String(2000 + index),
    client_order_id: 'SCALP-' + symbol
  }));
  const fixture = makeDynamicGridPoolFixture({ symbols, exchangePositions, databasePositions });
  const result = await manageDeltaTestnetMultiGrid(fixture.input);
  assert.deepEqual(result.activeSymbols, []);
  assert.deepEqual(result.skippedSymbols.sort(), [...symbols].sort());
  assert.equal(result.waitingForFutures, true);
  assert.equal(result.state.status, 'WAITING');
  assert.equal(result.safety.blocked, false);
  assert.ok(fixture.logs.some(row =>
    row.message === '[GRID] All pool symbols blocked by Futures; waiting'
  ));
});
