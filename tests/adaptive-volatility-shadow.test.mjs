import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAdaptiveVolatilityShadowObservation,
  advanceAdaptiveShadowPosition,
  inferAdaptiveVolatilityShadowSide
} from '../worker/adaptive-volatility-shadow.mjs';

function makeFiveMinuteCandles({
  movePct = -3.5,
  lastVolume = 400
} = {}) {
  const start = 1_700_000_000;
  const closed = Array.from({ length: 22 }, (_, index) => ({
    time: start + index * 300,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 100
  }));
  const finalClosed = closed.at(-1);
  finalClosed.close = 100 * (1 + movePct / 100);
  finalClosed.low = Math.min(finalClosed.open, finalClosed.close) - 0.2;
  finalClosed.high = Math.max(finalClosed.open, finalClosed.close) + 0.2;
  finalClosed.volume = lastVolume;
  return [
    ...closed,
    {
      time: start + 22 * 300,
      open: finalClosed.close,
      high: finalClosed.close + 0.1,
      low: finalClosed.close - 0.1,
      close: finalClosed.close,
      volume: 1
    }
  ];
}

function makeSignal(overrides = {}) {
  return {
    symbol: 'BTCUSD',
    side: 'SELL',
    stage: 'SETUP',
    score: 82,
    normalizedScore: 85,
    price: 96.5,
    sl: 98,
    tp: 93.5,
    rsi: 16,
    vwap: 100,
    atrEntry: 1,
    emaDistanceAtr: 4.2,
    spreadPct: 0.1,
    feeRiskRatio: 0.1,
    costGateRatio: 0.2,
    change: -4,
    btcTrend: 'BEAR',
    btcConfirmTrend: 'BEAR',
    volumeSpike: 4,
    stopPct: 0.02,
    tickSize: 0.01,
    candlesFresh: true,
    rangeAtr: 1.2,
    trend: 'BEAR',
    confirmTrend: 'BEAR',
    blocked: ['RSI/VWAP', 'Price > 3.50x ATR from entry EMA21'],
    ...overrides
  };
}

test('adaptive shadow permits RSI 15-20 and a small EMA distance extension on a >2.5%, >3x 5m impulse', () => {
  const observation = buildAdaptiveVolatilityShadowObservation(
    makeSignal(),
    makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5, takerFeeRate: 0.0005, rangeAtrMax: 4, spreadMaxPct: 0.35, costGateRatio: 0.2, volumeMin: 0.75 }
  );

  assert.ok(observation);
  assert.equal(observation.impulse_side, 'SELL');
  assert.ok(observation.move_5m_pct < -2.5);
  assert.ok(observation.relative_volume > 3);
  assert.equal(observation.shadow_status, 'PENDING_ENTRY');
  assert.equal(observation.shadow_blocked_reasons.length, 0);
  assert.equal(observation.ema_distance_limit_atr, 4.5);
  assert.equal(observation.details.execution, 'SHADOW_ONLY');
});

test('adaptive shadow does not bypass normalized score, spread, VWAP or other strategy blockers', () => {
  const scoreBlocked = buildAdaptiveVolatilityShadowObservation(
    makeSignal({ normalizedScore: 79 }),
    makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5, rangeAtrMax: 4, spreadMaxPct: 0.35, costGateRatio: 0.2, volumeMin: 0.75 }
  );
  assert.equal(scoreBlocked.shadow_status, 'BLOCKED');
  assert.ok(scoreBlocked.shadow_blocked_reasons.some(reason => reason.includes('Normalized score')));

  const spreadBlocked = buildAdaptiveVolatilityShadowObservation(
    makeSignal({ blocked: ['RSI/VWAP', 'Spread > 0.35%'] }),
    makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5 }
  );
  assert.equal(spreadBlocked.shadow_status, 'BLOCKED');
  assert.ok(spreadBlocked.shadow_blocked_reasons.includes('Spread > 0.35%'));
});

test('shadow can infer a missing side from the supported 5m/15m trend stack', () => {
  assert.equal(inferAdaptiveVolatilityShadowSide({ side: '', trend: 'BEAR', confirmTrend: 'BEAR' }, 'SELL'), 'SELL');
  assert.equal(inferAdaptiveVolatilityShadowSide({ side: '', trend: 'BULL', confirmTrend: 'BULL' }, 'SELL'), '');
});

test('impulse must be strictly greater than 2.5% and relative volume strictly greater than 3x', () => {
  assert.equal(buildAdaptiveVolatilityShadowObservation(
    makeSignal(),
    makeFiveMinuteCandles({ movePct: -2.5, lastVolume: 500 }),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5 }
  ), null);

  assert.equal(buildAdaptiveVolatilityShadowObservation(
    makeSignal(),
    makeFiveMinuteCandles({ movePct: -3, lastVolume: 300 }),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5 }
  ), null);
});

test('adaptive shadow checks Scalp VWAP and the BUY RSI ceiling independently', () => {
  const scalp = buildAdaptiveVolatilityShadowObservation(
    makeSignal({ price: 96.5, rsi: 16, emaDistanceAtr: 3.2 }),
    makeFiveMinuteCandles(),
    { strategy: 'SCALPING', baseEmaDistanceMax: 2.5, takerFeeRate: 0.0005, rangeAtrMax: 3, spreadMaxPct: 0.35, costGateRatio: 0.25, volumeMin: 1.25 }
  );
  assert.equal(scalp.shadow_status, 'PENDING_ENTRY');

  const buy = buildAdaptiveVolatilityShadowObservation(
    makeSignal({
      side: 'BUY', price: 103.5, sl: 101.5, tp: 107,
      rsi: 80, vwap: 100, emaDistanceAtr: 3.2,
      trend: 'BULL', confirmTrend: 'BULL', btcTrend: 'BULL', btcConfirmTrend: 'BULL',
      blocked: ['RSI/VWAP', 'Price > 2.50x ATR from entry EMA21']
    }),
    makeFiveMinuteCandles({ movePct: 3.5, lastVolume: 400 }),
    { strategy: 'SCALPING', baseEmaDistanceMax: 2.5, takerFeeRate: 0.0005,
      rangeAtrMax: 3, spreadMaxPct: 0.35, costGateRatio: 0.25, volumeMin: 1.25 }
  );
  assert.equal(buy.shadow_status, 'PENDING_ENTRY');
  assert.equal(buy.side, 'BUY');
});

test('shadow trailing stop activates at +1R and closes on a reversal without a fixed take-profit', () => {
  const entryTime = 1_700_000_000;
  const position = {
    side: 'BUY',
    entry_at: new Date(entryTime * 1000).toISOString(),
    entry_price: 100,
    initial_stop_price: 95,
    trailing_stop_price: 95,
    best_price: 100,
    worst_price: 100,
    trailing_activated: false,
    max_hold_minutes: 240,
    taker_fee_rate: 0.0005,
    spread_pct: 0.1
  };

  const first = advanceAdaptiveShadowPosition(position, {
    time: entryTime, open: 100, high: 110, low: 101, close: 109, volume: 100
  });
  assert.equal(first.shadow_status, 'OPEN');
  assert.equal(first.trailing_activated, true);
  assert.equal(first.trailing_stop_price, 105);

  const second = advanceAdaptiveShadowPosition({ ...position, ...first }, {
    time: entryTime + 60, open: 107, high: 108, low: 104, close: 106, volume: 100
  });
  assert.equal(second.shadow_status, 'CLOSED');
  assert.equal(second.exit_reason, 'TRAILING_STOP');
  assert.equal(second.exit_price, 105);
  assert.ok(second.net_pnl_pct > 0);
});

test('shadow refuses to model net profitability when product taker fee metadata is missing', () => {
  const observation = buildAdaptiveVolatilityShadowObservation(
    makeSignal(),
    makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5,
      rangeAtrMax: 4, spreadMaxPct: 0.35, costGateRatio: 0.2, volumeMin: 0.75 }
  );
  assert.equal(observation.shadow_status, 'BLOCKED');
  assert.ok(observation.shadow_blocked_reasons.includes('Taker fee rate unavailable'));
  assert.equal(observation.details.takerFeeRateAvailable, false);
});

test('shadow retains anti-chase and BTC regime vetoes', () => {
  const antiChase = buildAdaptiveVolatilityShadowObservation(
    makeSignal({ change: -18 }), makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5, rangeAtrMax: 4, spreadMaxPct: 0.35, costGateRatio: 0.2, volumeMin: 0.75 }
  );
  assert.equal(antiChase.shadow_status, 'BLOCKED');
  assert.ok(antiChase.shadow_blocked_reasons.includes('24h anti-chase'));
  const btcOpposed = buildAdaptiveVolatilityShadowObservation(
    makeSignal({ btcTrend: 'BULL', btcConfirmTrend: 'BULL' }), makeFiveMinuteCandles(),
    { strategy: 'MOMENTUM', baseEmaDistanceMax: 3.5, rangeAtrMax: 4, spreadMaxPct: 0.35, costGateRatio: 0.2, volumeMin: 0.75 }
  );
  assert.equal(btcOpposed.shadow_status, 'BLOCKED');
  assert.ok(btcOpposed.shadow_blocked_reasons.includes('BTC regime'));
});

test('shadow implementation contains no order-routing dependency', async () => {
  const source = await readFile(new URL('../worker/adaptive-volatility-shadow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /placeOrder|closePosition|deltaExecutor/);
});
