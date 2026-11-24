import test from 'node:test';
import assert from 'node:assert/strict';
import { screenGridMarket } from '../shared/grid-market-screener.js';

function rangeCandles(count = 60, amplitude = 0.8) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i * 0.8) * amplitude;
    return { high: close + 0.25, low: close - 0.25, close };
  });
}

const ticker = {
  turnover_usd: 1500000,
  quotes: { best_bid: 99.99, best_ask: 100.01 }
};
const config = { lowerPrice: 95, upperPrice: 105, atr_pct: 0.5 };

test('range screener qualifies liquid, tight-spread, stable-ATR range markets', () => {
  const result = screenGridMarket({ ticker, candles: rangeCandles(), config });
  assert.equal(result.qualified, true, JSON.stringify(result.reasons));
  assert.equal(result.pauseNewEntries, false);
  assert.ok(result.dynamicRungGapPct >= 0.25);
  assert.ok(result.dynamicLevelsCount >= 8 && result.dynamicLevelsCount <= 12);
});

test('range screener rejects low volume and wide spreads', () => {
  const result = screenGridMarket({
    ticker: { turnover_usd: 10, quotes: { best_bid: 99, best_ask: 102 } },
    candles: rangeCandles(), config
  });
  assert.ok(result.reasons.includes('GRID_VOLUME_TOO_LOW'));
  assert.ok(result.reasons.includes('GRID_SPREAD_TOO_WIDE'));
});

test('range screener rejects a trending market', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    high: 100 + i * 0.2 + 0.3,
    low: 100 + i * 0.2 - 0.3,
    close: 100 + i * 0.2
  }));
  const result = screenGridMarket({ ticker, candles, config });
  assert.ok(result.reasons.includes('GRID_TRENDING_MARKET'));
  assert.equal(result.qualified, false);
});

test('volatility shock pauses new Grid entries', () => {
  const candles = rangeCandles();
  candles[candles.length - 1] = { high: 110, low: 90, close: 100 };
  const result = screenGridMarket({ ticker, candles, config });
  assert.equal(result.volatilitySpike, true);
  assert.equal(result.pauseNewEntries, true);
  assert.ok(result.reasons.includes('GRID_VOLATILITY_SPIKE'));
});

test('missing candle/quote evidence fails closed', () => {
  const result = screenGridMarket({ ticker: {}, candles: [], config });
  assert.equal(result.qualified, false);
  assert.ok(result.reasons.includes('GRID_RANGE_DATA_INSUFFICIENT'));
  assert.ok(result.reasons.includes('GRID_SPREAD_TOO_WIDE'));
});
