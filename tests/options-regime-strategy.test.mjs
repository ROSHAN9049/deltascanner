import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOptionsMarketRegime,
  strategyForOptionsRegime,
  normalizeIvRank,
  normalizeIvPercentile,
  evaluateIvRank,
  evaluateIvMetrics,
  normalizeOptionGreeks,
  evaluateOptionGreeks,
  evaluateOptionsExit
} from '../worker/options-regime-strategy.mjs';

function makeCandles({ mode = 'trend', count = 90, start = 100, step = 0.5 } = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const center = mode === 'trend'
      ? start + index * step
      : mode === 'sideways'
        ? start + Math.sin(index * 0.7) * 0.18
        : start + index * step;
    rows.push({
      time: index * 3600,
      open: center - 0.08,
      high: center + (mode === 'trend' ? 0.12 : 0.3),
      low: center - (mode === 'trend' ? 0.12 : 0.3),
      close: center,
      volume: 100,
      res: '1h'
    });
  }
  return rows;
}

test('strong aligned 15m and 1h trends classify TRENDING', () => {
  const result = detectOptionsMarketRegime({
    candles15m: makeCandles({ mode: 'trend', step: 0.5 }),
    candles1h: makeCandles({ mode: 'trend', step: 0.5 })
  });
  assert.equal(result.regime, 'TRENDING');
});

test('low-ADX narrow-range 15m and 1h candles classify SIDEWAYS', () => {
  const result = detectOptionsMarketRegime({
    candles15m: makeCandles({ mode: 'sideways' }),
    candles1h: makeCandles({ mode: 'sideways' })
  });
  assert.equal(result.regime, 'SIDEWAYS');
});

test('neutral, insufficient, or disagreeing timeframe data classifies UNKNOWN', () => {
  assert.equal(detectOptionsMarketRegime({ candles15m: [], candles1h: [] }).regime, 'UNKNOWN');
  assert.equal(detectOptionsMarketRegime({
    candles15m: makeCandles({ mode: 'trend' }),
    candles1h: makeCandles({ mode: 'sideways' })
  }).regime, 'UNKNOWN');
});

test('TRENDING routes only to BUY and SIDEWAYS routes only to SELL', () => {
  assert.equal(strategyForOptionsRegime('TRENDING'), 'OPTIONS_BUY');
  assert.equal(strategyForOptionsRegime('SIDEWAYS'), 'OPTIONS_SELL');
  assert.equal(strategyForOptionsRegime('UNKNOWN'), null);
});

test('IV Rank blocks BUY at 40+, SELL at 50 or lower, and all missing values', () => {
  assert.equal(evaluateIvRank('OPTIONS_BUY', 39.99).allowed, true);
  assert.equal(evaluateIvRank('OPTIONS_BUY', 40).allowed, false);
  assert.equal(evaluateIvRank('OPTIONS_SELL', 50).allowed, false);
  assert.equal(evaluateIvRank('OPTIONS_SELL', 50.01).allowed, true);
  assert.equal(evaluateIvRank('OPTIONS_BUY', null).allowed, false);
  assert.equal(normalizeIvRank({ greeks: { iv_rank: '44' } }), 44);
  assert.equal(normalizeIvRank({ quotes: { ask_iv: '0.25' } }), null);
});

test('BUY exit logic enforces TP, SL and a 20% trail from peak after +30%', () => {
  assert.equal(evaluateOptionsExit({ strategy: 'OPTIONS_BUY', entryPremium: 100, currentPremium: 150 }).reason,
    'TAKE_PROFIT_50_PERCENT');
  assert.equal(evaluateOptionsExit({ strategy: 'OPTIONS_BUY', entryPremium: 100, currentPremium: 70 }).reason,
    'STOP_LOSS_30_PERCENT');
  assert.equal(evaluateOptionsExit({
    strategy: 'OPTIONS_BUY', entryPremium: 100, currentPremium: 100, peakPremium: 130
  }).reason, 'TRAILING_STOP_20_PERCENT_FROM_PEAK');
});

test('SELL exit logic enforces 50% decay, 2x premium stop and 0.5 DTE exit', () => {
  assert.equal(evaluateOptionsExit({ strategy: 'OPTIONS_SELL', entryPremium: 100, currentPremium: 50 }).reason,
    'TAKE_PROFIT_50_PERCENT_DECAY');
  assert.equal(evaluateOptionsExit({ strategy: 'OPTIONS_SELL', entryPremium: 100, currentPremium: 200 }).reason,
    'STOP_LOSS_2X_PREMIUM');
  assert.equal(evaluateOptionsExit({ strategy: 'OPTIONS_SELL', entryPremium: 100, currentPremium: 80, dte: 0.5 }).reason,
    'TIME_EXIT_DTE_0_5_DAYS');
});

test('IV Rank and daily IV Percentile must both pass strategy thresholds', () => {
  assert.equal(evaluateIvMetrics('OPTIONS_BUY', 39.99, 19.99).allowed, true);
  assert.equal(evaluateIvMetrics('OPTIONS_BUY', 39.99, 20).reason,
    'BUY requires IV Percentile < 20');
  assert.equal(evaluateIvMetrics('OPTIONS_BUY', 40, 5).reason,
    'BUY requires IV Rank < 40');
  assert.equal(evaluateIvMetrics('OPTIONS_SELL', 50.01, 80).reason,
    'SELL requires IV Percentile > 80');
  assert.equal(evaluateIvMetrics('OPTIONS_SELL', 50.01, 80.01).allowed, true);
  assert.equal(evaluateIvMetrics('OPTIONS_SELL', 50.01, null).reason,
    'IV Percentile unavailable or insufficient daily history; entry blocked');
  assert.equal(normalizeIvPercentile({ details: { ivPercentile: '18.5' } }), 18.5);
  assert.equal(normalizeIvPercentile({ iv_percentile: 101 }), null);
});

test('Greeks gate enforces BUY and SELL Delta bands and finite directional Gamma, Theta and Vega', () => {
  const buy = { delta: 0.55, gamma: 0.00044, theta: -535, vega: 7.36 };
  const sell = { delta: -0.15, gamma: 0.00044, theta: -535, vega: 7.36 };
  assert.equal(evaluateOptionGreeks('OPTIONS_BUY', buy).allowed, true);
  assert.equal(evaluateOptionGreeks('OPTIONS_SELL', sell).allowed, true);
  assert.equal(evaluateOptionGreeks('OPTIONS_BUY', { ...buy, delta: 0.4 }).allowed, false);
  assert.equal(evaluateOptionGreeks('OPTIONS_SELL', { ...sell, delta: -0.25 }).allowed, false);
  assert.equal(evaluateOptionGreeks('OPTIONS_BUY', { ...buy, gamma: 0 }).allowed, false);
  assert.equal(evaluateOptionGreeks('OPTIONS_BUY', { ...buy, theta: 0 }).allowed, false);
  assert.equal(evaluateOptionGreeks('OPTIONS_BUY', { ...buy, vega: null }).allowed, false);
  assert.deepEqual(normalizeOptionGreeks({ details: { greeks: buy } }), buy);
});

test('BUY trail follows 20% below premium peak after activation', () => {
  const armed = evaluateOptionsExit({
    strategy: 'OPTIONS_BUY', entryPremium: 100, currentPremium: 140, peakPremium: 140
  });
  assert.equal(armed.exit, false);
  assert.equal(armed.trailingStopPremium, 112);
  const exit = evaluateOptionsExit({
    strategy: 'OPTIONS_BUY', entryPremium: 100, currentPremium: 112, peakPremium: 140
  });
  assert.equal(exit.exit, true);
  assert.equal(exit.reason, 'TRAILING_STOP_20_PERCENT_FROM_PEAK');
});

test('SELL trail persists premium trough and exits on a 15% rebound after 30% decay', () => {
  const armed = evaluateOptionsExit({
    strategy: 'OPTIONS_SELL', entryPremium: 100, currentPremium: 65, troughPremium: 65
  });
  assert.equal(armed.exit, false);
  assert.equal(armed.trailingStopPremium, 74.75);
  const exit = evaluateOptionsExit({
    strategy: 'OPTIONS_SELL', entryPremium: 100, currentPremium: 75, troughPremium: 65
  });
  assert.equal(exit.exit, true);
  assert.equal(exit.reason, 'TRAILING_STOP_15_PERCENT_FROM_TROUGH');
});

test('regime results expose both timeframe measurements for UNKNOWN diagnosis', () => {
  const result = detectOptionsMarketRegime({
    candles15m: makeCandles({ mode: 'trend', step: 0.5 }),
    candles1h: makeCandles({ mode: 'sideways' })
  });
  assert.equal(result.regime, 'UNKNOWN');
  assert.equal(result.reason, 'TIMEFRAME_DISAGREEMENT_OR_NEUTRAL_ADX');
  assert.equal(result.fifteenMinute.valid, true);
  assert.equal(result.hourly.valid, true);
  assert.ok(Number.isFinite(result.fifteenMinute.adx));
  assert.ok(Number.isFinite(result.hourly.adx));
});
