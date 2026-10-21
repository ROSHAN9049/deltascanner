import test from 'node:test';
import assert from 'node:assert/strict';
import { atr } from '../worker/strategy.mjs';
import { detectAccumulation } from '../worker/leading-indicators/accumulation.mjs';
import { detectSqueezeSetup } from '../worker/leading-indicators/squeeze.mjs';
import { detectPreBreakout } from '../worker/leading-indicators/pre-breakout.mjs';

function combinedCandles({ constantVolume = false } = {}) {
  const candles = [];
  let previousClose = 100;
  for (let i = 0; i < 80; i++) {
    let close;
    let upper;
    let lower;
    if (i < 43) {
      close = i % 2 === 0 ? 90 : 110;
      upper = 5;
      lower = 5;
    } else if (i < 60) {
      close = 100 + (i - 43) * 0.001;
      upper = i < 55 ? 2.5 : 1.1;
      lower = upper * 1.7;
    } else {
      const phase = (i - 60) % 4;
      close = phase === 1 || phase === 2 ? 100.004 : 100;
      if (i < 66) {
        upper = 0.2;
        lower = 0.8;
      } else {
        upper = 0.002;
        lower = 0.01;
      }
      if (i === 77) { upper = 0.08; lower = 0.12; }
      if (i === 78) { upper = 0.04; lower = 0.10; }
      if (i === 79) { upper = 0.01; lower = 0.05; }
    }

    const high = Math.max(previousClose, close) + upper;
    const low = Math.min(previousClose, close) - lower;
    const phase = (i - 60) % 4;
    const cycle = Math.floor((i - 60) / 4);
    const volume = constantVolume
      ? 100
      : i < 60 ? 100 : 100 + cycle * 30 + (phase === 1 ? 20 : 0);
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high,
      low,
      close,
      volume
    });
    previousClose = close;
  }
  return candles;
}

function smoothAccumulationCandles(count = 80) {
  const candles = [];
  let previousClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.002;
    candles.push({
      time: 1_800_000_000 + i * 60,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.02,
      low: Math.min(previousClose, close) - 0.06,
      close,
      volume: 50 + i * 5
    });
    previousClose = close;
  }
  return candles;
}

test('combined squeeze and accumulation conditions create a PRE_BREAKOUT signal', () => {
  const candles = combinedCandles();
  assert.equal(detectSqueezeSetup(candles).isSqueeze, true);
  assert.equal(detectAccumulation(candles).isAccumulating, true);
  const result = detectPreBreakout('BTCUSD', candles);
  assert.equal(result.reason, 'setup_detected');
  assert.ok(result.signal);
  assert.equal(result.signal.type, 'PRE_BREAKOUT');
});

test('squeeze without accumulation does not produce a signal', () => {
  const candles = combinedCandles({ constantVolume: true });
  assert.equal(detectSqueezeSetup(candles).isSqueeze, true);
  assert.equal(detectAccumulation(candles).isAccumulating, false);
  assert.deepEqual(detectPreBreakout('BTCUSD', candles), { signal: null, reason: 'no_setup' });
});

test('accumulation without squeeze does not produce a signal', () => {
  const candles = smoothAccumulationCandles();
  assert.equal(detectAccumulation(candles).isAccumulating, true);
  assert.equal(detectSqueezeSetup(candles).isSqueeze, false);
  assert.deepEqual(detectPreBreakout('ETHUSD', candles), { signal: null, reason: 'no_setup' });
});

test('direction, breakout entry, ATR stops/targets and confidence are calculated', () => {
  const candles = combinedCandles();
  const result = detectPreBreakout('BTCUSD', candles);
  assert.ok(result.signal, JSON.stringify(result));
  const signal = result.signal;
  const atrValue = atr(candles, 14);
  assert.equal(signal.direction, 'UP');
  assert.ok(Math.abs(signal.entryPrice - signal.rangeHigh * 1.001) < 1e-10);
  assert.ok(Math.abs(signal.stopLoss - (signal.entryPrice - 2 * atrValue)) < 1e-10);
  assert.ok(Math.abs(signal.tp1 - (signal.entryPrice + 3 * atrValue)) < 1e-10);
  assert.ok(Math.abs(signal.tp2 - (signal.entryPrice + 5 * atrValue)) < 1e-10);
  assert.equal(signal.confidenceScore,
    (signal.squeezeScore * 0.5) + (signal.accumulationScore * 0.5));
  assert.ok(Math.abs(signal.riskReward - 1.5) < 1e-10);
});
