import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKET_CACHE_WRITE_INTERVAL_MS,
  shouldWriteMarketCache
} from '../worker/market-cache-policy.mjs';

test('persists the market cache immediately on startup', () => {
  assert.equal(shouldWriteMarketCache(0, 1_000), true);
});

test('throttles full market-cache writes before the interval expires', () => {
  const lastWriteAt = 10_000;
  assert.equal(MARKET_CACHE_WRITE_INTERVAL_MS, 120_000);
  assert.equal(shouldWriteMarketCache(lastWriteAt, lastWriteAt + 119_999), false);
});

test('allows a market-cache write exactly when the interval expires', () => {
  const lastWriteAt = 10_000;
  assert.equal(shouldWriteMarketCache(lastWriteAt, lastWriteAt + 120_000), true);
});

test('does not treat a future last-write timestamp as due', () => {
  assert.equal(shouldWriteMarketCache(200_000, 100_000), false);
});

test('rejects invalid clock or interval inputs without forcing a write', () => {
  assert.equal(shouldWriteMarketCache(10_000, Number.NaN), false);
  assert.equal(shouldWriteMarketCache(10_000, 20_000, Number.NaN), false);
});
