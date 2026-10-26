import test from 'node:test';
import assert from 'node:assert/strict';
import { atr } from '../worker/strategy.mjs';
import {
  MIN_RAW_CANDLES_FOR_ATR,
  candleMaxAgeIntervals,
  candleBucketSeconds,
  mergeCandleUpdate,
  normalizeCandle,
  normalizeCandleBatch,
  normalizeEpochSeconds
} from '../worker/candle-normalization.mjs';

const BASE = 1_800_000_000; // aligned to 1m, 5m and 15m bucket boundaries
const NOW_MS = (BASE + 16 * 300 + 10) * 1000;

function candle(time, i = 0, extra = {}) {
  const open = 100 + i;
  return {
    time,
    open,
    high: open + 4,
    low: open - 1,
    close: open + 2,
    volume: 10,
    ...extra
  };
}

function rawBatch(count = 16, resolution = '5m') {
  const interval = resolution === '1m' ? 60 : resolution === '15m' ? 900 : resolution === '1h' ? 3600 : 300;
  return Array.from({ length: count }, (_, i) => candle(BASE + i * interval, i)).reverse();
}

test('WebSocket microseconds normalize to their candle timeframe bucket', () => {
  const cst = (BASE + 600) * 1_000_000;
  const publishTs = (BASE + 625) * 1_000_000;
  assert.equal(normalizeEpochSeconds(cst), BASE + 600);
  assert.equal(normalizeEpochSeconds(publishTs), BASE + 625);
  assert.equal(candleBucketSeconds(cst, '5m'), BASE + 600);
  // cst is the stable candle-start value; ts fallback still rounds to its bucket.
  const fromCst = normalizeCandle({ ...candle(cst), ts: publishTs }, '5m');
  const fromTs = normalizeCandle({ ...candle(publishTs) }, '5m');
  assert.equal(fromCst.ok, true);
  assert.equal(fromCst.candle.time, BASE + 600);
  assert.equal(fromTs.candle.time, BASE + 600);
});

test('REST seconds and millisecond timestamps map to the same bucket', () => {
  assert.equal(candleBucketSeconds(BASE + 599, '5m'), BASE + 300);
  assert.equal(candleBucketSeconds((BASE + 599) * 1000, '5m'), BASE + 300);
  assert.equal(candleBucketSeconds((BASE + 599) * 1_000_000, '5m'), BASE + 300);
});

test('same WebSocket candle bucket is replaced instead of duplicated', () => {
  const batch = normalizeCandleBatch(rawBatch(), '5m', { nowMs: NOW_MS });
  assert.equal(batch.ok, true);
  const previousLength = batch.candles.length;
  const lastTime = batch.candles.at(-1).time;
  const update = mergeCandleUpdate(batch.candles, candle(lastTime + 75, 15, { close: 116 }), '5m', { nowMs: NOW_MS });
  assert.equal(update.ok, true);
  assert.equal(update.action, 'replaced');
  assert.equal(update.candles.length, previousLength);
  assert.equal(update.candles.at(-1).time, lastTime);
  assert.equal(update.candles.at(-1).close, 116);
});

test('out-of-order WebSocket candle bucket is rejected', () => {
  const batch = normalizeCandleBatch(rawBatch(), '5m', { nowMs: NOW_MS });
  assert.equal(batch.ok, true);
  const update = mergeCandleUpdate(batch.candles, candle(batch.candles.at(-1).time - 300, 14), '5m', { nowMs: NOW_MS });
  assert.equal(update.ok, false);
  assert.equal(update.reason, 'out_of_order');
});

test('invalid OHLC relationships are rejected', () => {
  const result = normalizeCandle(candle(BASE, 0, { high: 99, low: 100, close: 101 }), '5m');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_ohlc_relationship');
});

test('newest-first REST response is sorted and duplicate buckets reject the entire batch', () => {
  const batch = normalizeCandleBatch(rawBatch(), '5m', { nowMs: NOW_MS });
  assert.equal(batch.ok, true);
  assert.equal(batch.candles.length, MIN_RAW_CANDLES_FOR_ATR);
  for (let i = 1; i < batch.candles.length; i++) {
    assert.ok(batch.candles[i].time > batch.candles[i - 1].time);
  }
  const duplicate = [...rawBatch(), candle(BASE + 15 * 300, 15)];
  const rejected = normalizeCandleBatch(duplicate, '5m', { nowMs: NOW_MS });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'duplicate_bucket');
});

test('Testnet 1m candles tolerate a four-minute API delay while other modes stay strict', () => {
  const rows = rawBatch(21, '1m');
  const latestStart = BASE + 20 * 60;
  const delayedNow = (latestStart + 240) * 1000;

  assert.equal(candleMaxAgeIntervals('1m', true), 5);
  assert.equal(candleMaxAgeIntervals('1m', false), 3);
  assert.equal(candleMaxAgeIntervals('5m', true), 3);
  assert.equal(normalizeCandleBatch(rows, '1m', { nowMs: delayedNow }).reason, 'stale_series');

  const accepted = normalizeCandleBatch(rows, '1m', {
    nowMs: delayedNow,
    maxAgeIntervals: candleMaxAgeIntervals('1m', true)
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.candles.length, 21);
});

test('Testnet 1m WebSocket candle update accepts a delayed bucket only within five intervals', () => {
  const nowMs = (BASE + 250) * 1000;
  const delayed = candle(BASE, 0);

  assert.equal(mergeCandleUpdate([], delayed, '1m', { nowMs }).reason, 'stale_candle');
  const accepted = mergeCandleUpdate([], delayed, '1m', {
    nowMs,
    maxAgeIntervals: candleMaxAgeIntervals('1m', true)
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.candles[0].time, BASE);
});

test('15 closed candles provide a valid 14-period ATR without changing strategy logic', () => {
  const batch = normalizeCandleBatch(rawBatch(16), '5m', { nowMs: NOW_MS });
  assert.equal(batch.ok, true);
  assert.equal(batch.candles.length - 1, 15); // strategy drops the current, forming candle
  assert.equal(atr(batch.candles, 14), 5);
});

test('repeated updates to the same bucket keep ATR variance under 20%', () => {
  const batch = normalizeCandleBatch(rawBatch(16), '5m', { nowMs: NOW_MS });
  assert.equal(batch.ok, true);
  const before = atr(batch.candles, 14);
  let current = batch.candles;
  for (let i = 0; i < 25; i++) {
    const lastTime = current.at(-1).time;
    const update = mergeCandleUpdate(current, candle(lastTime + i, 15, {
      high: 120,
      low: 114,
      close: 117 + (i % 2) * 0.1
    }), '5m', { nowMs: NOW_MS });
    assert.equal(update.ok, true);
    assert.equal(update.action, 'replaced');
    current = update.candles;
  }
  const after = atr(current, 14);
  const variancePct = Math.abs(after - before) / before * 100;
  assert.ok(variancePct < 20, 'variance was ' + variancePct + '%');
});
