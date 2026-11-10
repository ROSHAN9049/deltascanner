import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAutoGridRange,
  hasGridAutoRangeExposure,
  isAutoGridRangeRefreshDue,
  selectLatestCompletedDailyCandle,
  utcDayKey
} from '../shared/grid-auto-range.js';

test('Auto-Range applies the 3% buffer to the completed daily low and high', () => {
  const range = calculateAutoGridRange({ low: 4000, high: 4200 });
  assert.equal(range.lowerPrice, 3880);
  assert.equal(range.upperPrice, 4326);
  assert.ok(range.upperPrice > range.lowerPrice);
  assert.equal(range.expandedForMinimumWidth, false);
});

test('Auto-Range expands a narrow range to at least 2% without reducing the buffer bounds', () => {
  const range = calculateAutoGridRange({ low: 100, high: 100.2 }, {
    bufferPct: 0.1,
    minimumWidthPct: 2
  });
  assert.equal(range.expandedForMinimumWidth, true);
  assert.ok(range.upperPrice > range.lowerPrice);
  assert.ok((range.upperPrice - range.lowerPrice) / range.lowerPrice * 100 >= 2);
});

test('Auto-Range rejects malformed and non-positive daily candles', () => {
  assert.throws(() => calculateAutoGridRange({ low: 0, high: 10 }), /positive low/);
  assert.throws(() => calculateAutoGridRange({ low: 12, high: 10 }), /greater than or equal/);
  assert.throws(() => calculateAutoGridRange({ low: 'not-a-number', high: 10 }), /positive low/);
});

test('daily candle selector returns the previous completed UTC day, not the current partial candle', () => {
  const now = Date.parse('2026-11-09T10:00:00.000Z');
  const candles = [
    { time: 1794009600, low: 100, high: 110 },
    { time: 1794096000, low: 105, high: 115 },
    { time: 1794182400, low: 111, high: 112 }
  ];
  const selected = selectLatestCompletedDailyCandle(candles, now);
  assert.equal(utcDayKey(now), '2026-11-09');
  assert.equal(selected?.time, 1794096000);
  assert.equal(selectLatestCompletedDailyCandle([{ time: 1794355200, low: 1, high: 2 }], now), null);
});

test('Auto-Range seeds once, then refreshes on UTC day rollover only with both trailing gates', () => {
  const now = Date.parse('2026-11-09T00:01:00.000Z');
  assert.equal(isAutoGridRangeRefreshDue({ enabled: false, timestamp: now }), false);
  assert.equal(isAutoGridRangeRefreshDue({ enabled: true, timestamp: now }), true);
  assert.equal(isAutoGridRangeRefreshDue({
    enabled: true, lastAppliedUtcDay: '2026-11-08', timestamp: now
  }), false);
  assert.equal(isAutoGridRangeRefreshDue({
    enabled: true, trailingEnvironmentEnabled: true, trailingSettingEnabled: false,
    lastAppliedUtcDay: '2026-11-08', timestamp: now
  }), false);
  assert.equal(isAutoGridRangeRefreshDue({
    enabled: true, trailingEnvironmentEnabled: true, trailingSettingEnabled: true,
    lastAppliedUtcDay: '2026-11-08', timestamp: now
  }), true);
});

test('Auto-Range defers when any configured symbol has exchange, DB, or local grid exposure', () => {
  const symbols = ['PAXGUSD', 'NVDAXUSD'];
  assert.equal(hasGridAutoRangeExposure({ symbols }), false);
  assert.equal(hasGridAutoRangeExposure({
    symbols, exchangePositions: [{ symbol: 'PAXGUSD', qty: 1 }]
  }), true);
  assert.equal(hasGridAutoRangeExposure({
    symbols, exchangeOrders: [{ product_symbol: 'NVDAXUSD' }]
  }), true);
  assert.equal(hasGridAutoRangeExposure({
    symbols, databasePositions: [{ symbol: 'PAXGUSD', qty: 1 }]
  }), true);
  assert.equal(hasGridAutoRangeExposure({
    symbols, databaseOrders: [{ symbol: 'NVDAXUSD' }]
  }), true);
  assert.equal(hasGridAutoRangeExposure({
    symbols, gridState: { symbolStates: { PAXGUSD: { positions: [{ symbol: 'PAXGUSD' }] } } }
  }), true);
});


import { calculateDailyAtr, calculateAtrGridRange } from '../shared/grid-auto-range.js';

test('14-day ATR uses completed daily candles and true-range gap components', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const start = Date.parse('2026-10-20T00:00:00Z') / 1000;
  const candles = Array.from({ length: 16 }, (_, i) => ({
    time: start + i * 86400, high: 110 + i, low: 100 + i, close: 105 + i
  }));
  const result = calculateDailyAtr(candles, { timestamp: now });
  assert.equal(result.ok, true);
  assert.equal(result.periods, 14);
  assert.equal(result.candleCount, 16);
  assert.ok(result.atr > 10);
});

test('ATR range clamps symmetrically to configured minimum and maximum widths', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const start = Date.parse('2026-10-20T00:00:00Z') / 1000;
  const quiet = Array.from({ length: 16 }, (_, i) => ({ time: start + i*86400, high: 4010, low: 4000, close: 4005 }));
  const fast = Array.from({ length: 16 }, (_, i) => ({ time: start + i*86400, high: 190, low: 160, close: 175 }));
  const paxg = calculateAtrGridRange(quiet, { currentPrice: 4100, timestamp: now, minRangePct: 2, maxRangePct: 20 });
  const nvdax = calculateAtrGridRange(fast, { currentPrice: 175, timestamp: now, minRangePct: 2, maxRangePct: 20 });
  assert.equal(paxg.widthPct, 2);
  assert.ok(nvdax.widthPct > paxg.widthPct);
  assert.ok(Math.abs((paxg.upperPrice - paxg.lowerPrice) / 4100 * 100 - paxg.widthPct) < 1e-8);
});

test('ATR fallback requires legacy completed candle and marks warning', () => {
  const result = calculateAtrGridRange([], { currentPrice: 100, fallbackCandle: { low: 98, high: 102 } });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.match(result.warning, /legacy 3% buffer/);
});
