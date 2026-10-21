import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedScoreFromView,
  originalScoreFromView,
  visibleScoreFrom,
  passesScoreFilter,
  normalizedScoreTooltip,
  showAllPreferenceKey,
  readShowAllPreference,
  writeShowAllPreference
} from '../src/normalized-score-view.js';

test('dashboard score falls back to original score when normalizedScore is missing', () => {
  const signal = { symbol: 'BTCUSD', score: 91, details: {} };
  assert.equal(normalizedScoreFromView(signal), null);
  assert.equal(originalScoreFromView(signal), 91);
  assert.equal(visibleScoreFrom(signal), 91);
  assert.equal(normalizedScoreTooltip(signal), 'Normalized: — (Original: 91.00)');
});

test('dashboard threshold is inclusive at 80 and prefers normalized score over original', () => {
  assert.equal(passesScoreFilter({ score: 65, details: { normalizedScore: 80 } }), true);
  assert.equal(passesScoreFilter({ score: 95, details: { normalizedScore: 79.99 } }), false);
  assert.equal(passesScoreFilter({ score: 80 }), true);
  assert.equal(passesScoreFilter({ score: 79.99 }), false);
});

test('Show all bypasses the score filter including rows with no score', () => {
  assert.equal(passesScoreFilter({ score: 20, details: { normalizedScore: 10 } }, false), false);
  assert.equal(passesScoreFilter({ score: 20, details: { normalizedScore: 10 } }, true), true);
  assert.equal(passesScoreFilter({ score: null }, true), true);
});

test('Show all preferences default off and persist separately for Momentum and Scalping', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  const momentumKey = showAllPreferenceKey('MOMENTUM');
  const scalpingKey = showAllPreferenceKey('SCALPING');
  assert.notEqual(momentumKey, scalpingKey);
  assert.equal(readShowAllPreference(storage, momentumKey), false);
  assert.equal(readShowAllPreference(storage, scalpingKey), false);
  assert.equal(writeShowAllPreference(storage, momentumKey, true), true);
  assert.equal(readShowAllPreference(storage, momentumKey), true);
  assert.equal(readShowAllPreference(storage, scalpingKey), false);
  assert.equal(writeShowAllPreference(storage, momentumKey, false), true);
  assert.equal(readShowAllPreference(storage, momentumKey), false);
});

test('storage exceptions do not break dashboard filter defaults', () => {
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };
  assert.equal(readShowAllPreference(storage, 'x'), false);
  assert.equal(writeShowAllPreference(storage, 'x', true), false);
});
