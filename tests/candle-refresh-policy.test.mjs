import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCandleRetryAfterMs,
  shouldRefreshGridCandle
} from '../worker/candle-refresh-policy.mjs';

test('grid candles refresh on the normal 15-second cadence after a successful read', () => {
  assert.equal(shouldRefreshGridCandle(30_000, 15_000, 0), true);
  assert.equal(shouldRefreshGridCandle(29_999, 15_000, 0), false);
});

test('failed grid candle reads respect the retry deadline without faking a successful refresh', () => {
  const lastSuccessAt = 10_000;
  const retryAfterAt = 310_000;
  assert.equal(shouldRefreshGridCandle(30_000, lastSuccessAt, retryAfterAt), false);
  assert.equal(shouldRefreshGridCandle(309_999, lastSuccessAt, retryAfterAt), false);
  assert.equal(shouldRefreshGridCandle(310_000, lastSuccessAt, retryAfterAt), true);
});

test('explicit retryAfterMs from a rejected candle batch takes precedence', () => {
  assert.equal(resolveCandleRetryAfterMs({ retryAfterMs: 300_000 }, 60_000), 300_000);
});

test('missing or invalid retry metadata uses the safe configured fallback', () => {
  assert.equal(resolveCandleRetryAfterMs(new Error('network failure'), 300_000), 300_000);
  assert.equal(resolveCandleRetryAfterMs({ retryAfterMs: -1 }, 300_000), 300_000);
  assert.equal(resolveCandleRetryAfterMs({}, 0), 60_000);
});
