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

test('two-symbol Testnet Grid permits at most one position per symbol and two total', () => {
  assert.equal(GRID_BRIDGE_MAX_POSITIONS, 2);
  assert.deepEqual(GRID_MAX_POSITION_CHOICES, [2]);
});

test('all visible Grid risk choices are accepted by shared validation', () => {
  for (const value of [0.3, 0.5, 0.75, 1]) assert.equal(isAllowedGridRiskPerTradePct(value), true);
  for (const value of [0, 0.25, 1.25, 1.5, NaN]) assert.equal(isAllowedGridRiskPerTradePct(value), false);
  assert.deepEqual(GRID_DAILY_LOSS_CHOICES, [2]);
  assert.deepEqual(GRID_MOMENTUM_PAUSE_CHOICES, [2.5, 2.75, 3]);
});

test('legacy Grid risk values normalize to a supported option', () => {
  assert.equal(normalizeGridRiskPerTradePct(undefined), 0.3);
  assert.equal(normalizeGridRiskPerTradePct(1.25), 1);
  assert.equal(normalizeGridRiskPerTradePct(1.5), 1);
  assert.equal(normalizeGridRiskPerTradePct(0.8), 0.75);
});


test('Testnet Grid stays execution-disabled unless the explicit opt-in is present', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: true,
    gridState: { status: 'ACTIVE', executionMode: 'DELTA_TESTNET' },
    testnetDiagnostics: { gridExecutionAllowed: false }
  });
  assert.equal(status.label, 'TESTNET GRID · EXECUTION DISABLED');
  assert.match(status.detail, /GRID_EXECUTION_ALLOWED/);
});

test('enabled two-symbol Grid status reports independent exchange protection', () => {
  const status = getGridDisplayStatus({
    executionMode: 'testnet',
    gridEnabled: true,
    gridExecutionAllowed: true,
    gridState: { status: 'ACTIVE', executionMode: 'DELTA_TESTNET' },
    testnetDiagnostics: { gridExecutionAllowed: true }
  });
  assert.equal(status.label, 'TESTNET GRID · ACTIVE');
  assert.match(status.detail, /independent exchange-side SL\/TP/);
});

test('Testnet Grid shows pending limit entries and halted state distinctly', () => {
  const pending = getGridDisplayStatus({
    executionMode: 'testnet', gridExecutionAllowed: true, gridEnabled: true,
    gridState: { status: 'ENTRY_PENDING', executionMode: 'DELTA_TESTNET' }
  });
  assert.equal(pending.label, 'TESTNET GRID · LIMIT ENTRY PENDING');
  const halted = getGridDisplayStatus({
    executionMode: 'testnet', gridExecutionAllowed: true, gridEnabled: true,
    gridState: { status: 'HALTED', pausedReason: 'EMERGENCY_STOP', executionMode: 'DELTA_TESTNET' }
  });
  assert.equal(halted.label, 'TESTNET GRID · HALTED');
  assert.match(halted.detail, /no new entries/i);
});
