import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDLE_RESOLUTIONS,
  CANDLE_WARMUP_BATCH_SIZE,
  CANDLE_WARMUP_RETRY_MS,
  MIN_RAW_CANDLES,
  candleNeedsWarmup,
  planCandleWarmup
} from '../worker/candle-warmup.mjs';

test('candle warmup batches cover 24 symbols and request the missing three timeframes', () => {
  const ranked = Array.from({ length: 231 }, (_, i) => 'COIN' + i + 'USD');
  const plan = planCandleWarmup(ranked, new Map(), new Map(), 0, undefined, 1_000_000);

  assert.equal(CANDLE_WARMUP_BATCH_SIZE, 24);
  assert.equal(plan.symbols.length, 24);
  assert.equal(plan.work.length, 24 * CANDLE_RESOLUTIONS.length);
  assert.equal(plan.nextCursor, 24);
  assert.deepEqual(plan.symbols.slice(0, 2), ['COIN0USD', 'COIN1USD']);
});

test('warmup rotates onward while earlier deficient candles are in their retry cooldown', () => {
  const ranked = Array.from({ length: 72 }, (_, i) => 'COIN' + i + 'USD');
  const fetchedAt = new Map();
  const now = 2_000_000;
  for (const symbol of ranked.slice(0, 24)) {
    for (const resolution of CANDLE_RESOLUTIONS) fetchedAt.set(resolution + ':' + symbol, now);
  }

  const plan = planCandleWarmup(ranked, new Map(), fetchedAt, 0, 24, now + 1_000);
  assert.equal(plan.symbols.length, 24);
  assert.deepEqual(plan.symbols, ranked.slice(24, 48));
  assert.equal(plan.nextCursor, 48);
});

test('short or empty candle responses can be retried after the cooldown', () => {
  const now = 5_000_000;
  const key = '5m:BTCUSD';
  const candles = new Map([[key, Array.from({ length: 8 }, () => ({ close: 1 }))]]);

  assert.equal(candleNeedsWarmup(candles.get(key), '5m', now, now + 10_000), false);
  assert.equal(candleNeedsWarmup(candles.get(key), '5m', now, now + CANDLE_WARMUP_RETRY_MS), true);
  assert.equal(candleNeedsWarmup(Array.from({ length: MIN_RAW_CANDLES['5m'] }, () => ({})), '5m', 0, now), false);
});

test('only deficient resolutions are queued when a symbol has partial history', () => {
  const ranked = ['BTCUSD', 'ETHUSD'];
  const candles = new Map([
    ['1m:BTCUSD', Array.from({ length: MIN_RAW_CANDLES['1m'] }, () => ({}))],
    ['5m:BTCUSD', Array.from({ length: MIN_RAW_CANDLES['5m'] }, () => ({}))],
    ['15m:BTCUSD', Array.from({ length: MIN_RAW_CANDLES['15m'] }, () => ({}))],
    ['1m:ETHUSD', Array.from({ length: MIN_RAW_CANDLES['1m'] }, () => ({}))]
  ]);
  const plan = planCandleWarmup(ranked, candles, new Map(), 0, 2, Date.now());

  assert.deepEqual(plan.symbols, ['ETHUSD']);
  assert.deepEqual(plan.work, [['ETHUSD', '5m'], ['ETHUSD', '15m']]);
});

test('fully warmed symbols create no repeated candle API work', () => {
  const ranked = ['BTCUSD', 'ETHUSD'];
  const candles = new Map();
  for (const symbol of ranked) {
    for (const resolution of CANDLE_RESOLUTIONS) {
      candles.set(resolution + ':' + symbol, Array.from({ length: MIN_RAW_CANDLES[resolution] }, () => ({})));
    }
  }

  const plan = planCandleWarmup(ranked, candles, new Map(), 0, 2, Date.now());
  assert.deepEqual(plan.symbols, []);
  assert.deepEqual(plan.work, []);
});
