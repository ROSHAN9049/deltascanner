import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELTA_TESTNET_MIN_SL_DISTANCE_PCT,
  resolveMinimumStopDistancePct,
  roundStopLossAwayFromEntry
} from '../shared/delta-risk-policy.js';

test('Delta Testnet stop-distance floor is shared and cannot be configured below 1.50%', () => {
  assert.equal(DELTA_TESTNET_MIN_SL_DISTANCE_PCT, 1.5);
  for (const configured of [undefined, null, '', 0, 0.75, 0.95, 1.49, '0.95', 'invalid']) {
    assert.equal(resolveMinimumStopDistancePct(configured), 1.5);
  }
});

test('a configured stop-distance floor above 1.50% is preserved', () => {
  assert.equal(resolveMinimumStopDistancePct(1.8), 1.8);
  assert.equal(resolveMinimumStopDistancePct('2.25'), 2.25);
});

test('BUY stop tick rounding keeps the full minimum distance after quantization', () => {
  const entry = 0.02124212;
  const requestedStop = entry * (1 - DELTA_TESTNET_MIN_SL_DISTANCE_PCT / 100);
  const roundedStop = roundStopLossAwayFromEntry(requestedStop, 0.0000005, 'BUY');

  assert.ok(roundedStop <= requestedStop);
  assert.ok(((entry - roundedStop) / entry) * 100 >= DELTA_TESTNET_MIN_SL_DISTANCE_PCT);
});

test('SELL stop tick rounding keeps the full minimum distance after quantization', () => {
  const entry = 105.03;
  const requestedStop = entry * (1 + DELTA_TESTNET_MIN_SL_DISTANCE_PCT / 100);
  const roundedStop = roundStopLossAwayFromEntry(requestedStop, 0.01, 'SELL');

  assert.ok(roundedStop >= requestedStop);
  assert.ok(((roundedStop - entry) / entry) * 100 >= DELTA_TESTNET_MIN_SL_DISTANCE_PCT);
});

test('missing tick metadata leaves the unquantized protective stop unchanged', () => {
  const stop = 98.5;
  assert.equal(roundStopLossAwayFromEntry(stop, 0, 'BUY'), stop);
});
