import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAtrSpike, replaceOutlierCandleWithPrevious } from '../worker/atr-spike-guard.mjs';

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


test('replaces an outlier tail candle with previous valid OHLCV while retaining its timestamp', () => {
  const candles = [
    { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 20, res: '5m' },
    { time: 400, open: 11, high: 13, low: 10, close: 12, volume: 22, res: '5m' },
    { time: 700, open: 12, high: 100, low: 1, close: 90, volume: 999, res: '5m' }
  ];
  assert.deepEqual(replaceOutlierCandleWithPrevious(candles), [
    candles[0],
    candles[1],
    { ...candles[1], time: 700, res: '5m' }
  ]);
  assert.equal(replaceOutlierCandleWithPrevious([]), null);
});
