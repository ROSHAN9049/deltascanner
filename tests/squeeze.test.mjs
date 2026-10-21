import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBollingerBands } from '../src/indicators/ta.mjs';
import {
  detectBollingerSqueeze,
  detectSqueezeSetup
} from '../worker/leading-indicators/squeeze.mjs';

function syntheticSqueezeCandles() {
  const candles = [];
  let previousClose = 100;
  for (let i = 0; i < 80; i++) {
    let close;
    let spread;
    if (i < 43) {
      close = i % 2 === 0 ? 90 : 110;
      spread = 5;
    } else {
      close = 100 + (i - 43) * 0.002;
      spread = i < 61 ? 2.5 : i < 67 ? 1.1 : i < 77 ? 0.18 : 0.03;
    }
    const upper = spread * 0.35;
    const lower = spread * 0.65;
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high: Math.max(previousClose, close) + upper,
      low: Math.min(previousClose, close) - lower,
      close,
      volume: 100 + i
    });
    previousClose = close;
  }
  return candles;
}

function trendingCandles(count = 80) {
  const candles = [];
  let previousClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.5;
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.35,
      low: Math.min(previousClose, close) - 0.35,
      close,
      volume: 1000 + i
    });
    previousClose = close;
  }
  return candles;
}

test('synthetic volatility contraction scores as a squeeze setup', () => {
  const result = detectSqueezeSetup(syntheticSqueezeCandles());
  assert.ok(result.squeezeScore >= 60, JSON.stringify(result));
  assert.equal(result.isSqueeze, true);
});

test('a directional trend is not classified as a squeeze', () => {
  const result = detectSqueezeSetup(trendingCandles());
  assert.ok(result.squeezeScore < 40, JSON.stringify(result));
  assert.equal(result.isSqueeze, false);
});

test('insufficient candle history returns a zero score', () => {
  const result = detectSqueezeSetup(trendingCandles(24));
  assert.equal(result.squeezeScore, 0);
  assert.equal(result.isSqueeze, false);
  assert.equal(result.reason, 'insufficient_data');
});

test('Bollinger bandwidth uses (upper - lower) / middle and a 20-width average', () => {
  const candles = syntheticSqueezeCandles();
  const result = detectBollingerSqueeze(candles);
  const closes = candles.slice(-20).map(c => c.close);
  const bands = calculateBollingerBands(closes, 20, 2);
  const expectedBandwidth = (bands.upper - bands.lower) / bands.middle;
  assert.ok(Math.abs(result.bandwidth - expectedBandwidth) < 1e-12);
  const expectedRatio = expectedBandwidth / result.avgBandwidth;
  assert.ok(Math.abs(result.bandwidthRatio - expectedRatio) < 1e-12);
  assert.ok(result.avgBandwidth > 0);
});
