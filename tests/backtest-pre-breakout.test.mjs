import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBacktestMetrics } from '../scripts/backtest-pre-breakout.mjs';

test('backtest metrics calculate win rate and expectancy from net R multiples', () => {
  const metrics = calculateBacktestMetrics([
    { result: 'TP1', rMultiple: 1.45, entryTime: 1, exitTime: 2 },
    { result: 'SL', rMultiple: -1.05, entryTime: 3, exitTime: 4 }
  ]);
  assert.equal(metrics.totalTrades, 2);
  assert.equal(metrics.winRatePct, 50);
  assert.equal(metrics.avgWinR, 1.45);
  assert.equal(metrics.avgLossR, 1.05);
  assert.ok(Math.abs(metrics.expectancyR - 0.2) < 1e-12);
  assert.ok(Math.abs(metrics.profitFactor - (1.45 / 1.05)) < 1e-12);
});

test('backtest metrics apply compounding risk and track a consecutive-loss sequence', () => {
  const metrics = calculateBacktestMetrics([
    { result: 'SL', rMultiple: -1, entryTime: 1, exitTime: 2 },
    { result: 'SL', rMultiple: -1, entryTime: 3, exitTime: 4 },
    { result: 'TP1', rMultiple: 1.5, entryTime: 5, exitTime: 6 }
  ]);
  assert.equal(metrics.maxConsecutiveLosses, 2);
  assert.ok(metrics.maxDrawdownPct > 1.9 && metrics.maxDrawdownPct < 2.1);
});
