import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeDeltaGridEntry, assessDeltaGridEntryFill, hasVerifiedGridBracket, cancelAndVerifyGridOrder, cancelUnverifiedGridEntry } from '../worker/execution/delta-grid-engine.mjs';

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
  const executor = {
    async cancelOrderById() { throw new Error('exchange timeout'); },
    async getOrderById(id) { return { id, state: 'OPEN' }; },
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
});
