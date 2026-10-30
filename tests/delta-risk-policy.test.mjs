import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELTA_TESTNET_MIN_SL_DISTANCE_PCT,
  resolveMinimumStopDistancePct
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
