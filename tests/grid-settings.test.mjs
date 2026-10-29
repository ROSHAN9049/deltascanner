import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_BRIDGE_MAX_POSITIONS,
  GRID_MAX_POSITION_CHOICES,
  GRID_RISK_PER_TRADE_CHOICES,
  GRID_DAILY_LOSS_CHOICES,
  GRID_MOMENTUM_PAUSE_CHOICES,
  isAllowedGridRiskPerTradePct,
  normalizeGridRiskPerTradePct
} from '../shared/grid-settings.js';

test('Grid simulator respects the single-slot netting limit', () => {
  assert.equal(GRID_BRIDGE_MAX_POSITIONS, 1);
  assert.ok(GRID_MAX_POSITION_CHOICES.includes(GRID_BRIDGE_MAX_POSITIONS));
});

test('all visible Grid risk choices are accepted by shared validation', () => {
  for (const value of [0.3, 0.5, 0.75, 1]) assert.equal(isAllowedGridRiskPerTradePct(value), true);
  for (const value of [0, 0.25, 1.25, 1.5, NaN]) assert.equal(isAllowedGridRiskPerTradePct(value), false);
  assert.deepEqual(GRID_DAILY_LOSS_CHOICES, [2, 2.25, 2.5]);
  assert.deepEqual(GRID_MOMENTUM_PAUSE_CHOICES, [2.5, 2.75, 3]);
});

test('legacy Grid risk values normalize to a supported option', () => {
  assert.equal(normalizeGridRiskPerTradePct(undefined), 0.3);
  assert.equal(normalizeGridRiskPerTradePct(1.25), 1);
  assert.equal(normalizeGridRiskPerTradePct(1.5), 1);
  assert.equal(normalizeGridRiskPerTradePct(0.8), 0.75);
});
