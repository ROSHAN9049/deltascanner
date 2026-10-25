import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDLE_RESOLUTIONS,
  CANDLE_WARMUP_BATCH_SIZE,
  CANDLE_WARMUP_RETRY_MS,
  CANDLE_TESTNET_WARMUP_BATCH_SIZE,
  CANDLE_TESTNET_WARMUP_CONCURRENCY,
  CANDLE_TESTNET_WARMUP_RETRY_MS,
  candleSeriesIsFresh,
  MIN_RAW_CANDLES,
  candleNeedsWarmup,
  planCandleWarmup
} from '../worker/candle-warmup.mjs';

function validCandles(resolution, count, now = Date.now()) {
  const interval = ({ '1m': 60, '5m': 300, '15m': 900 })[resolution];
  const currentBucket = Math.floor(now / 1000 / interval) * interval;
  return Array.from({ length: count }, (_, index) => ({
    time: currentBucket - (count - index - 1) * interval,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10,
    res: resolution
  }));
}

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

test('Testnet warmup is smaller and uses a five-minute retry cooldown', () => {
  assert.equal(CANDLE_TESTNET_WARMUP_BATCH_SIZE, 6);
  assert.equal(CANDLE_TESTNET_WARMUP_CONCURRENCY, 2);
  assert.equal(CANDLE_TESTNET_WARMUP_RETRY_MS, 5 * 60_000);
});

test('a full but stale cached candle series is retried after the cooldown', () => {
  const now = 2_000_000_000_000;
  const stale = validCandles('5m', MIN_RAW_CANDLES['5m'], now - 60 * 60_000);
  assert.equal(candleSeriesIsFresh(stale, '5m', now), false);
  assert.equal(candleNeedsWarmup(stale, '5m', now - 1_000, now, CANDLE_TESTNET_WARMUP_RETRY_MS), false);
  assert.equal(candleNeedsWarmup(stale, '5m', now - CANDLE_TESTNET_WARMUP_RETRY_MS, now, CANDLE_TESTNET_WARMUP_RETRY_MS), true);
  assert.equal(candleSeriesIsFresh(validCandles('5m', 31, now), '5m', now), true);
});

test('only deficient resolutions are queued when a symbol has partial history', () => {
  const ranked = ['BTCUSD', 'ETHUSD'];
  const now = Date.now();
  const candles = new Map([
    ['1m:BTCUSD', validCandles('1m', MIN_RAW_CANDLES['1m'], now)],
    ['5m:BTCUSD', validCandles('5m', MIN_RAW_CANDLES['5m'], now)],
    ['15m:BTCUSD', validCandles('15m', MIN_RAW_CANDLES['15m'], now)],
    ['1m:ETHUSD', validCandles('1m', MIN_RAW_CANDLES['1m'], now)]
  ]);
  const plan = planCandleWarmup(ranked, candles, new Map(), 0, 2, now);

  assert.deepEqual(plan.symbols, ['ETHUSD']);
  assert.deepEqual(plan.work, [['ETHUSD', '5m'], ['ETHUSD', '15m']]);
});

test('fully warmed fresh symbols create no repeated candle API work', () => {
  const ranked = ['BTCUSD', 'ETHUSD'];
  const now = Date.now();
  const candles = new Map();
  for (const symbol of ranked) {
    for (const resolution of CANDLE_RESOLUTIONS) {
      candles.set(resolution + ':' + symbol, validCandles(resolution, MIN_RAW_CANDLES[resolution], now));
    }
  }

  const plan = planCandleWarmup(ranked, candles, new Map(), 0, 2, now);
  assert.deepEqual(plan.symbols, []);
  assert.deepEqual(plan.work, []);
});
