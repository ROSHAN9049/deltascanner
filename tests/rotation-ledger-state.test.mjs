import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRotationLedger } from '../src/rotation-ledger-state.js';

test('a completely loaded empty ledger is an empty state, not missing row data', () => {
  const summary = summarizeRotationLedger([], true);
  assert.equal(summary.hasEvents, false);
  assert.equal(summary.emptyConfirmed, true);
  assert.equal(summary.releasedComplete, null);
  assert.equal(summary.retainedComplete, null);
  assert.equal(summary.released, null);
  assert.equal(summary.retained, null);
});

test('an empty partial ledger is not reported as a confirmed empty state', () => {
  const summary = summarizeRotationLedger([], false);
  assert.equal(summary.hasEvents, false);
  assert.equal(summary.emptyConfirmed, false);
  assert.equal(summary.releasedComplete, null);
  assert.equal(summary.retainedComplete, null);
});

test('complete event rows produce sums when every amount is present', () => {
  const summary = summarizeRotationLedger([
    { released: '9.00', retained: '1.00' },
    { released: 4.5, retained: 0.5 }
  ], true);
  assert.equal(summary.hasEvents, true);
  assert.equal(summary.emptyConfirmed, false);
  assert.equal(summary.releasedComplete, true);
  assert.equal(summary.retainedComplete, true);
  assert.equal(summary.released, 13.5);
  assert.equal(summary.retained, 1.5);
});

test('missing amount fields preserve incomplete-data warnings', () => {
  const summary = summarizeRotationLedger([
    { released: 9, retained: null }
  ], true);
  assert.equal(summary.hasEvents, true);
  assert.equal(summary.releasedComplete, true);
  assert.equal(summary.retainedComplete, false);
  assert.equal(summary.released, 9);
  assert.equal(summary.retained, null);
});

test('event rows from an incomplete ledger are not marked complete', () => {
  const summary = summarizeRotationLedger([
    { released: 9, retained: 1 }
  ], false);
  assert.equal(summary.hasEvents, true);
  assert.equal(summary.releasedComplete, false);
  assert.equal(summary.retainedComplete, false);
  assert.equal(summary.released, null);
  assert.equal(summary.retained, null);
});
