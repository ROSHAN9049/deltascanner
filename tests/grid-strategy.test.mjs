import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGridLevels, createGridState, detectOneWayMomentum, evaluateGridTick, normalizeGridConfig
} from '../worker/grid-strategy.mjs';

const baseSettings = {
  grid_enabled: true,
  grid_symbol: 'ETHUSD',
  grid_lower_price: 80,
  grid_upper_price: 110,
  grid_levels_count: 8,
  grid_max_positions: 3,
  grid_risk_per_trade_pct: 1,
  grid_daily_loss_pct: 2,
  grid_max_drawdown_pct: 5,
  grid_momentum_pause_pct: 2.5,
  grid_reduce_after_losses: true
};

test('grid levels include bounds with equal spacing and only lower levels are entry-enabled', () => {
  const levels = buildGridLevels(80, 110, 8);
  assert.equal(levels.length, 8);
  assert.equal(levels[0].price, 80);
  assert.equal(levels[7].price, 110);
  assert.ok(Math.abs((levels[1].price - levels[0].price) - (levels[2].price - levels[1].price)) < 1e-8);
  assert.equal(levels[6].targetIndex, 7);
  assert.equal(levels[7].entryEnabled, false);
});

test('grid configuration fails closed for invalid range and clamps user inputs', () => {
  assert.equal(normalizeGridConfig({ ...baseSettings, grid_upper_price: 70 }).valid, false);
  const cfg = normalizeGridConfig({ ...baseSettings, grid_levels_count: 30, grid_max_positions: 99 });
  assert.equal(cfg.levelCount, 12);
  assert.equal(cfg.maxPositions, 4);
});

test('first enabled tick establishes a baseline; a later downward cross enters one level', () => {
  const first = evaluateGridTick({
    settings: baseSettings, state: createGridState(), price: 111, equity: 5000,
    available: 5000, contractValue: 1, timestamp: Date.parse('2026-10-09T05:00:00Z')
  });
  assert.equal(first.entered.length, 0);

  const next = evaluateGridTick({
    settings: baseSettings, state: first.state, price: 104, equity: 5000,
    available: 5000, contractValue: 1, timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(next.entered.length, 1);
  assert.equal(next.entered[0].levelIndex, 6);
  assert.equal(next.entered[0].targetPrice, 110);
  assert.ok(next.entered[0].qty >= 1);
});

test('position exits at the next higher grid level and frees the level for a new entry', () => {
  const openedAt = '2026-10-09T05:00:15.000Z';
  const prior = {
    ...createGridState(),
    strategyStartEquity: 5000, highWaterEquity: 5000, dayStartEquity: 5000,
    tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 104,
    positions: [{ id: 'test-position', levelIndex: 6, entryPrice: 105.714285714,
      targetPrice: 110, qty: 1, riskUsd: 26, openedAt }]
  };
  const exited = evaluateGridTick({
    settings: baseSettings, state: prior, price: 111, equity: 5000,
    available: 5000, contractValue: 1, timestamp: Date.parse('2026-10-09T05:01:00Z')
  });
  assert.equal(exited.exited.length, 1);
  assert.equal(exited.exited[0].reason, 'NEXT_GRID_LEVEL');
  assert.equal(exited.exited[0].exitPrice, 110);
  assert.equal(exited.state.positions.length, 0);

  const reentered = evaluateGridTick({
    settings: baseSettings, state: exited.state, price: 104, equity: 5000,
    available: 5000, contractValue: 1, timestamp: Date.parse('2026-10-09T05:01:15Z')
  });
  assert.equal(reentered.entered.length, 1);
  assert.equal(reentered.entered[0].levelIndex, 6);
});

test('grid range break closes all simulated positions and halts new entries', () => {
  const prior = {
    ...createGridState(), strategyStartEquity: 5000, highWaterEquity: 5000,
    dayStartEquity: 5000, tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 82,
    positions: [{ id: 'p1', levelIndex: 0, entryPrice: 80, targetPrice: 84.285714,
      qty: 1, riskUsd: 1, openedAt: '2026-10-09T05:00:00.000Z' }]
  };
  const result = evaluateGridTick({
    settings: baseSettings, state: prior, price: 79,
    equity: 5000, available: 5000, contractValue: 0.001,
    timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.pausedReason, 'GRID_RANGE_BREAK');
  assert.equal(result.state.status, 'HALTED');
});

test('daily loss guard closes positions and blocks entries even if price remains inside range', () => {
  const prior = {
    ...createGridState(), strategyStartEquity: 1000, highWaterEquity: 1000,
    dayStartEquity: 1000, tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 100,
    positions: [{ id: 'large-risk', levelIndex: 4, entryPrice: 100, targetPrice: 104,
      qty: 100, riskUsd: 10, openedAt: '2026-10-09T05:00:00.000Z' }]
  };
  const result = evaluateGridTick({
    settings: { ...baseSettings, grid_daily_loss_pct: 2, grid_max_positions: 4 },
    state: prior, price: 95, equity: 1000, available: 1000, contractValue: 1,
    timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.pausedReason, 'DAILY_LOSS_LIMIT');
});

test('overall drawdown stop remains independent of the tighter daily loss guard', () => {
  const prior = {
    ...createGridState(), strategyStartEquity: 1000, realizedPnl: -60, dayPnl: 0,
    highWaterEquity: 1000, dayStartEquity: 940, tradeDate: '2026-10-09',
    wasEnabled: true, lastPrice: 100,
    positions: [{ id: 'p1', levelIndex: 4, entryPrice: 100, targetPrice: 104,
      qty: 1, riskUsd: 1, openedAt: '2026-10-09T05:00:00.000Z' }]
  };
  const result = evaluateGridTick({
    settings: baseSettings, state: prior, price: 100, equity: 1000,
    available: 1000, contractValue: 0.001, timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.state.pausedReason, 'OVERALL_DRAWDOWN_STOP');
  assert.equal(result.state.positions.length, 0);
});

test('strong one-way momentum pauses new entries, not the live data scanner', () => {
  const candles = Array.from({ length: 16 }, (_, index) => ({
    close: 97 + index * 0.2, high: 97.05 + index * 0.2, low: 96.98 + index * 0.2
  }));
  const momentum = detectOneWayMomentum(candles, 2.5, 0.75);
  assert.equal(momentum.paused, true);
  const prior = { ...createGridState(), strategyStartEquity: 5000, highWaterEquity: 5000,
    dayStartEquity: 5000, tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 100.5 };
  const result = evaluateGridTick({
    settings: baseSettings, state: prior, price: 97, equity: 5000, available: 5000,
    contractValue: 1, candles, timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.entered.length, 0);
  assert.equal(result.state.status, 'MOMENTUM_PAUSE');
});

test('emergency stop closes grid simulator positions and remains locked until reset', () => {
  const prior = { ...createGridState(), strategyStartEquity: 5000, highWaterEquity: 5000,
    dayStartEquity: 5000, tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 100,
    positions: [{ id: 'p1', levelIndex: 4, entryPrice: 100, targetPrice: 104, qty: 1,
      riskUsd: 1, openedAt: '2026-10-09T05:00:00.000Z' }] };
  const result = evaluateGridTick({
    settings: baseSettings, state: prior, price: 101, equity: 5000,
    available: 5000, contractValue: 0.001, emergencyStop: true,
    timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.pausedReason, 'EMERGENCY_STOP');
});

test('minimum lot size blocks any entry that would exceed its risk budget', () => {
  const prior = { ...createGridState(), strategyStartEquity: 10, highWaterEquity: 10,
    dayStartEquity: 10, tradeDate: '2026-10-09', wasEnabled: true, lastPrice: 111 };
  const result = evaluateGridTick({
    settings: baseSettings, state: prior, price: 104, equity: 10, available: 10,
    contractValue: 1, timestamp: Date.parse('2026-10-09T05:00:15Z')
  });
  assert.equal(result.entered.length, 0);
  assert.ok(result.state.events.some(event => event.reason === 'RISK_BUDGET_BELOW_MINIMUM' || event.reason === 'MINIMUM_CONTRACT_SIZE'));
});
