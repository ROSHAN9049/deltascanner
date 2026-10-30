import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeDeltaGridEntry } from '../worker/execution/delta-grid-engine.mjs';

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
