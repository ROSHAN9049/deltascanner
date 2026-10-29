import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessOptionsCacheFreshness,
  OPTIONS_CACHE_MAX_AGE_MS
} from '../src/options-cache-freshness.js';

const NOW = Date.parse('2026-10-29T16:30:00.000Z');

test('options cache is fresh only when all candidates are timestamped within the freshness window', () => {
  const result = assessOptionsCacheFreshness([
    { symbol: 'C-BTC-80000-311026', cached_at: new Date(NOW - 60_000).toISOString() },
    { symbol: 'P-ETH-2400-311026', cached_at: new Date(NOW - 120_000).toISOString() }
  ], { now: () => NOW });
  assert.equal(result.fresh, true);
  assert.equal(result.status, 'FRESH');
  assert.equal(result.rowCount, 2);
  assert.equal(result.ageMs, 120_000);
});

test('stale option snapshots are rejected as a batch even if candidate scores are high', () => {
  const result = assessOptionsCacheFreshness([
    { symbol: 'C-BTC-80000-311026', score: 100, cached_at: '2026-10-26T04:12:09.220Z' }
  ], { now: () => NOW });
  assert.equal(result.fresh, false);
  assert.equal(result.status, 'STALE');
  assert.ok(result.ageMs > OPTIONS_CACHE_MAX_AGE_MS);
});

test('unknown or missing timestamps fail closed', () => {
  assert.equal(assessOptionsCacheFreshness([{ symbol: 'C-BTC-80000-311026' }], { now: () => NOW }).status, 'UNKNOWN_TIMESTAMP');
  assert.equal(assessOptionsCacheFreshness([{ cached_at: 'not-a-date' }], { now: () => NOW }).status, 'UNKNOWN_TIMESTAMP');
});

test('future-dated options snapshots fail closed', () => {
  const result = assessOptionsCacheFreshness([
    { symbol: 'C-BTC-80000-311026', cached_at: new Date(NOW + 120_000).toISOString() }
  ], { now: () => NOW });
  assert.equal(result.fresh, false);
  assert.equal(result.status, 'FUTURE_TIMESTAMP');
});

test('empty options data reports NO_DATA rather than a zero-risk setup', () => {
  assert.deepEqual(assessOptionsCacheFreshness([], { now: () => NOW }), {
    fresh: false, status: 'NO_DATA', rowCount: 0, newestAt: null, oldestAt: null, ageMs: null
  });
});
