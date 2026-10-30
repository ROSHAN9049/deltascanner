import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeDeltaGridEntry, assessDeltaGridEntryFill } from '../worker/execution/delta-grid-engine.mjs';

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
