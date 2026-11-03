import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_BRIDGE_MAX_POSITIONS,
  GRID_MAX_POSITION_CHOICES,
  GRID_RISK_PER_TRADE_CHOICES,
  GRID_DAILY_LOSS_CHOICES,
  GRID_MOMENTUM_PAUSE_CHOICES,
  getGridDisplayStatus,
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


test('Testnet diagnostics remain visible while the persisted Grid strategy is hard-halted', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: true,
    gridState: {
      status: 'HALTED',
      pausedReason: 'EMERGENCY_STOP',
      executionMode: 'DELTA_TESTNET'
    },
    testnetDiagnostics: { testnetProductAvailable: false }
  });

  assert.equal(status.label, 'DIAGNOSTICS ACTIVE · GRID HALTED');
  assert.match(status.detail, /EMERGENCY STOP/);
  assert.match(status.detail, /order routing remains locked/i);
  assert.match(status.detail, /no exchange orders or reservations/i);
});

test('Testnet diagnostics do not label an enabled strategy ACTIVE while waiting for products', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: true,
    gridState: { status: 'ACTIVE', executionMode: 'DELTA_TESTNET' },
    testnetDiagnostics: { testnetProductAvailable: false }
  });

  assert.equal(status.label, 'DIAGNOSTICS ACTIVE · WAITING FOR TESTNET PRODUCTS');
});

test('Testnet diagnostics distinguish a disabled persisted Grid strategy', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: false,
    gridState: { status: 'OFF', executionMode: 'DELTA_TESTNET' },
    testnetDiagnostics: { testnetProductAvailable: false }
  });

  assert.equal(status.label, 'DIAGNOSTICS ACTIVE · GRID OFF');
});

test('Testnet diagnostics keep order routing locked even when a product is reported available', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: true,
    gridState: { status: 'ACTIVE', executionMode: 'DELTA_TESTNET' },
    testnetDiagnostics: { testnetProductAvailable: true }
  });

  assert.equal(status.label, 'DIAGNOSTICS ACTIVE · ORDERS LOCKED');
  assert.match(status.detail, /reviewed execution lifecycle/i);
});
