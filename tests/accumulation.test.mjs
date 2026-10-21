import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCMF,
  calculateOBV,
  detectAccumulation,
  detectOBVDivergence
} from '../worker/leading-indicators/accumulation.mjs';

function accumulationCandles(count = 40) {
  const candles = [];
  let previousClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.002;
    const upper = 0.02;
    const lower = 0.06;
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high: Math.max(previousClose, close) + upper,
      low: Math.min(previousClose, close) - lower,
      close,
      volume: 50 + i * 5
    });
    previousClose = close;
  }
  return candles;
}

function distributionCandles(count = 40) {
  const candles = [];
  let previousClose = 100;
  let close = 100;
  for (let i = 0; i < count; i++) {
    close += i % 2 === 0 ? -0.25 : 0.75;
    const downBar = i % 2 === 0;
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high: Math.max(previousClose, close) + (downBar ? 0.2 : 0.8),
      low: Math.min(previousClose, close) - (downBar ? 0.8 : 0.2),
      close,
      volume: downBar ? 1000 : 100
    });
    previousClose = close;
  }
  return candles;
}

test('rising OBV with flat price is classified as accumulation', () => {
  const result = detectAccumulation(accumulationCandles());
  assert.ok(result.accumulationScore >= 60, JSON.stringify(result));
  assert.equal(result.isAccumulating, true);
  assert.equal(result.indicators.obvDiv.divergence, 'accumulation');
  assert.equal(result.indicators.volAccum.pattern, 'accumulation');
});

test('falling OBV with rising price does not score as accumulation', () => {
  const candles = distributionCandles();
  const divergence = detectOBVDivergence(candles);
  assert.equal(divergence.divergence, 'distribution');
  const result = detectAccumulation(candles);
  assert.ok(result.accumulationScore < 20, JSON.stringify(result));
  assert.equal(result.isAccumulating, false);
});

test('OBV is the running signed-volume sum', () => {
  const candles = [
    { close: 100, high: 101, low: 99, volume: 10 },
    { close: 101, high: 102, low: 100, volume: 20 },
    { close: 100, high: 102, low: 99, volume: 5 },
    { close: 100, high: 101, low: 99, volume: 30 }
  ];
  assert.deepEqual(calculateOBV(candles), [0, 20, 15, 15]);
});

test('Chaikin Money Flow uses the money-flow multiplier and volume weighting', () => {
  const candles = Array.from({ length: 2 }, () => ({
    high: 10, low: 0, close: 7.5, volume: 10
  }));
  assert.equal(calculateCMF(candles, 2).cmf, 0.5);
});

test('insufficient history returns a zero accumulation score', () => {
  const result = detectAccumulation(accumulationCandles(24));
  assert.deepEqual(result, { accumulationScore: 0, isAccumulating: false });
});
