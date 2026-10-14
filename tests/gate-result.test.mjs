import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockersDisplay,
  gateTooltip,
  gateResult,
  GATE_PASS,
  GATE_BLOCK,
  GATE_UNKNOWN
} from '../src/gate-result.js';

test('missing or empty gate data is explicitly unknown', () => {
  assert.equal(blockersDisplay(null), 'UNKNOWN — NO GATE DATA');
  assert.equal(blockersDisplay([]), 'UNKNOWN — NO GATE DATA');
  assert.equal(blockersDisplay(undefined), 'UNKNOWN — NO GATE DATA');
});

test('PASS is shown only when all gate records are valid PASS', () => {
  const allPass = [
    gateResult({ gate: 'SPREAD', result: GATE_PASS, observedValue: 0.042, unit: '%', threshold: 0.35, thresholdUnit: '%' }),
    gateResult({ gate: 'VOLUME', result: GATE_PASS, observedValue: 1.8, unit: 'x', threshold: 0.75, thresholdUnit: 'x' })
  ];
  assert.equal(blockersDisplay(allPass), 'PASS — NO BLOCKERS');
});

test('specific blockers include observed values, limits and block reasons', () => {
  const mixed = [
    gateResult({ gate: 'SPREAD', result: GATE_PASS }),
    gateResult({ gate: 'ATR_RANGE', result: GATE_BLOCK, observedValue: 5.2, unit: 'x', threshold: 4.0, thresholdUnit: 'x', blockReason: 'CANDLE_TOO_WIDE' })
  ];
  const display = blockersDisplay(mixed);
  assert.ok(display.includes('ATR_RANGE'));
  assert.ok(display.includes('5.2'));
  assert.ok(display.includes('4'));
  assert.ok(display.includes('CANDLE_TOO_WIDE'));
  assert.ok(!display.includes('SPREAD'));
});

test('unknown gates make the result partial and are named', () => {
  const partial = [
    gateResult({ gate: 'SPREAD', result: GATE_PASS }),
    gateResult({ gate: 'VOLUME', result: GATE_UNKNOWN })
  ];
  const display = blockersDisplay(partial);
  assert.ok(display.startsWith('PARTIAL'));
  assert.ok(display.includes('VOLUME'));
});

test('blocking and unknown gates are both displayed', () => {
  const display = blockersDisplay([
    { gate: 'SPREAD', result: GATE_BLOCK, observedValue: 0.8, threshold: 0.35, unit: '%' },
    { gate: 'VOLUME', result: GATE_UNKNOWN }
  ]);
  assert.ok(display.startsWith('BLOCKED:'));
  assert.ok(display.includes('INCOMPLETE:'));
  assert.ok(display.includes('SPREAD'));
  assert.ok(display.includes('VOLUME'));
});

test('malformed or unrecognized results never become PASS and never crash', () => {
  assert.notEqual(blockersDisplay([{ gate: 'RISK', result: 'SKIP' }]), 'PASS — NO BLOCKERS');
  assert.notEqual(blockersDisplay([null]), 'PASS — NO BLOCKERS');
  assert.match(gateTooltip(null), /UNKNOWN_GATE/);
});
