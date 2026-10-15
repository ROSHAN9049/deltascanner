import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMACD,
  calculateBollingerBands,
  calculateZScore,
  computeStats
} from '../src/indicators/ta.mjs';
import { atr, ema, rsi } from '../worker/strategy.mjs';

// Realistic, time-ordered OHLC fixtures. The final entry represents a forming
// candle; the existing worker indicators deliberately exclude that last row.
const realisticBullishCandles = [
  { time: 1, open: 100.0, high: 101.4, low: 99.7, close: 101.0, volume: 1250 },
  { time: 2, open: 101.0, high: 102.1, low: 100.6, close: 101.8, volume: 1410 },
  { time: 3, open: 101.8, high: 102.5, low: 101.1, close: 102.2, volume: 1320 },
  { time: 4, open: 102.2, high: 103.7, low: 101.9, close: 103.4, volume: 1690 },
  { time: 5, open: 103.4, high: 104.2, low: 102.8, close: 103.9, volume: 1580 },
  { time: 6, open: 103.9, high: 105.0, low: 103.5, close: 104.6, volume: 1810 },
  { time: 7, open: 104.6, high: 105.3, low: 104.0, close: 104.9, volume: 1750 },
  { time: 8, open: 104.9, high: 106.2, low: 104.7, close: 105.8, volume: 2030 },
  { time: 9, open: 105.8, high: 106.5, low: 105.1, close: 106.1, volume: 1900 },
  { time: 10, open: 106.1, high: 107.1, low: 105.8, close: 106.8, volume: 2200 },
  { time: 11, open: 106.8, high: 107.6, low: 106.3, close: 107.2, volume: 2150 },
  { time: 12, open: 107.2, high: 108.4, low: 107.0, close: 108.0, volume: 2450 }
];
const realisticVolatileCandles = [
  { time: 1, open: 200.0, high: 206.0, low: 197.0, close: 202.0, volume: 5100 },
  { time: 2, open: 202.0, high: 205.0, low: 194.0, close: 196.0, volume: 6900 },
  { time: 3, open: 196.0, high: 200.0, low: 189.0, close: 198.0, volume: 7400 },
  { time: 4, open: 198.0, high: 209.0, low: 196.0, close: 207.0, volume: 8100 },
  { time: 5, open: 207.0, high: 211.0, low: 199.0, close: 201.0, volume: 9200 },
  { time: 6, open: 201.0, high: 204.0, low: 187.0, close: 191.0, volume: 10500 },
  { time: 7, open: 191.0, high: 197.0, low: 185.0, close: 194.0, volume: 8700 },
  { time: 8, open: 194.0, high: 207.0, low: 191.0, close: 205.0, volume: 11400 },
  { time: 9, open: 205.0, high: 212.0, low: 198.0, close: 200.0, volume: 11900 },
  { time: 10, open: 200.0, high: 204.0, low: 183.0, close: 189.0, volume: 13700 },
  { time: 11, open: 189.0, high: 195.0, low: 180.0, close: 193.0, volume: 12800 },
  { time: 12, open: 193.0, high: 210.0, low: 190.0, close: 207.0, volume: 15100 }
];

const near = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};

describe('existing worker EMA / ATR / RSI functions', () => {
  test('EMA matches the current worker implementation on a known series', () => {
    const candles = [10, 11, 12, 13, 14, 999].map((close, index) => ({
      time: index, high: close + 1, low: close - 1, close
    }));
    // The worker drops the last (forming) candle and seeds EMA from its first
    // close, then applies k = 2 / (3 + 1) across the remaining closed prices.
    near(ema(candles, 3), 13.0625);
  });

  test('EMA returns zero for insufficient closed candles in the existing worker API', () => {
    assert.strictEqual(ema([{ close: 10 }, { close: 11 }, { close: 12 }], 3), 0);
  });

  test('EMA moves toward the last value on an increasing candle series', () => {
    const closes = Array.from({ length: 30 }, (_, index) => 100 + index);
    const candles = [...closes, 500].map((close, index) => ({ time: index, high: close + 1, low: close - 1, close }));
    const value = ema(candles, 9);
    assert.ok(value > closes[10]);
    assert.ok(value < closes[closes.length - 1]);
  });

  test('ATR matches the existing rolling true-range average', () => {
    const candles = [
      { high: 12, low: 8, close: 10 },
      { high: 14, low: 9, close: 13 },
      { high: 15, low: 11, close: 14 },
      { high: 13, low: 10, close: 11 },
      { high: 900, low: 800, close: 850 } // ignored forming candle
    ];
    near(atr(candles, 2), 4);
  });

  test('RSI returns 100 for all gains and 0 for all losses', () => {
    const rising = [10, 11, 12, 13, 14, 999].map(close => ({ close }));
    const falling = [14, 13, 12, 11, 10, 999].map(close => ({ close }));
    assert.strictEqual(rsi(rising, 4), 100);
    assert.strictEqual(rsi(falling, 4), 0);
  });

  test('RSI returns the existing neutral fallback when data is insufficient', () => {
    assert.strictEqual(rsi([{ close: 10 }, { close: 11 }, { close: 12 }], 14), 50);
  });

  test('two real-world-style OHLC arrays produce finite, positive indicator readings', () => {
    for (const candles of [realisticBullishCandles, realisticVolatileCandles]) {
      assert.ok(Number.isFinite(ema(candles, 5)) && ema(candles, 5) > 0);
      assert.ok(Number.isFinite(atr(candles, 5)) && atr(candles, 5) > 0);
      assert.ok(Number.isFinite(rsi(candles, 5)));
    }
  });
});

describe('calculateMACD', () => {
  test('returns numeric MACD, signal and histogram values', () => {
    const prices = Array.from({ length: 60 }, (_, index) => 100 + index * 0.8 + Math.sin(index / 3));
    const result = calculateMACD(prices, 5, 12, 4);
    assert.deepStrictEqual(Object.keys(result), ['macd', 'signal', 'histogram']);
    for (const value of Object.values(result)) assert.strictEqual(typeof value, 'number');
    assert.ok(Object.values(result).every(Number.isFinite));
  });

  test('histogram equals MACD minus signal', () => {
    const prices = Array.from({ length: 50 }, (_, index) => 250 + Math.sin(index / 4) * 3 + index * 0.25);
    const result = calculateMACD(prices, 4, 10, 3);
    near(result.histogram, result.macd - result.signal);
  });

  test('rejects insufficient data and invalid periods', () => {
    assert.throws(() => calculateMACD([1, 2, 3, 4], 2, 4, 2), /Insufficient prices/);
    assert.throws(() => calculateMACD([1, 2, 3, 4], 4, 2, 1), /fast period must be less than slow period/);
    assert.throws(() => calculateMACD([1, 2, NaN, 4, 5, 6], 2, 3, 2), /finite number/);
  });
});

describe('calculateBollingerBands', () => {
  test('calculates bands from the population standard deviation of the final window', () => {
    const result = calculateBollingerBands([1, 2, 3, 4, 5], 5, 2);
    near(result.middle, 3);
    near(result.upper, 3 + 2 * Math.sqrt(2));
    near(result.lower, 3 - 2 * Math.sqrt(2));
  });

  test('validates price count and inputs', () => {
    assert.throws(() => calculateBollingerBands([], 20, 2), /insufficient prices/);
    assert.throws(() => calculateBollingerBands([1, 2, NaN], 3, 2), /finite number/);
    assert.throws(() => calculateBollingerBands([1, 2, 3], 3, -1), /stdDev/);
  });
});

describe('calculateZScore', () => {
  test('calculates a standard z-score', () => {
    near(calculateZScore(15, 10, 2.5), 2);
  });

  test('returns zero for zero standard deviation and rejects invalid inputs', () => {
    assert.strictEqual(calculateZScore(15, 10, 0), 0);
    assert.throws(() => calculateZScore(NaN, 10, 2), /finite number/);
  });
});

describe('computeStats', () => {
  test('calculates mean, population standard deviation, min, max and count', () => {
    const result = computeStats([1, 2, 3, 4, 5]);
    near(result.mean, 3);
    near(result.stddev, Math.sqrt(2));
    assert.strictEqual(result.min, 1);
    assert.strictEqual(result.max, 5);
    assert.strictEqual(result.count, 5);
  });

  test('ignores NaN values and throws on an empty usable sample', () => {
    const result = computeStats([1, NaN, 3]);
    near(result.mean, 2);
    assert.strictEqual(result.count, 2);
    assert.throws(() => computeStats([]), /no finite values/);
    assert.throws(() => computeStats([NaN]), /no finite values/);
  });

  test('rejects infinite values rather than silently returning invalid statistics', () => {
    assert.throws(() => computeStats([1, Infinity]), /finite number or NaN/);
  });
});
