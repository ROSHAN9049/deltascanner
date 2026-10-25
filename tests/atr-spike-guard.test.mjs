import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAtrSpike } from '../worker/atr-spike-guard.mjs';

test('rejects ATR increases of three times or more', () => {
  assert.deepEqual(detectAtrSpike(10, 30), { previousAtr: 10, candidateAtr: 30, ratio: 3 });
  assert.equal(detectAtrSpike(4, 12.01)?.ratio, 12.01 / 4);
});

test('allows normal ATR movement below the three-times threshold', () => {
  assert.equal(detectAtrSpike(10, 29.999), null);
  assert.equal(detectAtrSpike(10, 15), null);
});

test('does not treat ATR decreases or invalid baselines as spikes', () => {
  assert.equal(detectAtrSpike(10, 3), null);
  assert.equal(detectAtrSpike(0, 30), null);
  assert.equal(detectAtrSpike(-1, 30), null);
  assert.equal(detectAtrSpike(10, 0), null);
  assert.equal(detectAtrSpike(10, Number.NaN), null);
});
