import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseOption } from '../worker/strategy.mjs';
import { selectOptionsUnderlyingSignal } from '../worker/options-underlying-confirmation.mjs';

const marketSignal = {
  symbol: 'ETHUSD',
  side: 'SELL',
  stage: 'CONFIRMED',
  score: 98,
  normalizedScore: 98.68,
  ready: true,
  candlesFresh: true,
  change: 0,
  trend: 'BEAR',
  confirmTrend: 'BEAR',
  executionProductAvailable: false,
  productId: null,
  blocked: []
};

const putTicker = {
  symbol: 'P-ETH-1900-311226',
  underlying: 'ETH',
  contract_type: 'put_options',
  mark_price: 100,
  quotes: { best_bid: 99.5, best_ask: 100.5 },
  iv_rank: 30,
  open_interest: 1000,
  volume: 10,
  greeks: { delta: -0.55 }
};

const config = {
  minDays: 1,
  maxDays: 120,
  minOi: 50,
  minVolume: 1,
  maxSpreadPct: 1.5,
  buyMinDelta: 0.45,
  buyMaxDelta: 0.65,
  scoreMin: 80,
  regimeBased: false
};

test('ETH Options can confirm from a fresh normalized market signal even when its Futures route is unavailable', () => {
  // This snapshot is taken before Futures risk/sizing. The Futures path below
  // intentionally changes its own signal to SKIPPED_INSUFFICIENT_CAPITAL.
  const optionsUnderlying = selectOptionsUnderlyingSignal([marketSignal], { scoreMin: 80 });
  const futuresSignalAfterGates = {
    ...marketSignal,
    stage: 'SKIPPED_INSUFFICIENT_CAPITAL',
    ready: false,
    blocked: [
      'Symbol is outside the fixed Delta Testnet futures allowlist',
      'Delta Testnet route unavailable: no verified live, operational product for this symbol',
      'Risk budget insufficient for 1 contract'
    ]
  };

  const option = analyseOption(putTicker, optionsUnderlying, 'OPTIONS_BUY', config);

  assert.equal(futuresSignalAfterGates.stage, 'SKIPPED_INSUFFICIENT_CAPITAL');
  assert.equal(optionsUnderlying.stage, 'CONFIRMED');
  assert.equal(optionsUnderlying.optionsUnderlyingConfirmed, true);
  assert.equal(option.underlyingSymbol, 'ETHUSD');
  assert.equal(option.underlyingStage, 'CONFIRMED');
  assert.equal(option.underlyingScore, 98.68);
  assert.equal(option.stage, 'CONFIRMED');
  assert.equal(option.ready, true);
  assert.deepEqual(option.blocked, []);
});

test('Options underlying confirmation fails closed for stale candles', () => {
  const underlying = selectOptionsUnderlyingSignal([
    { ...marketSignal, candlesFresh: false, ready: false }
  ]);
  assert.equal(underlying.stage, 'SETUP');
  assert.equal(underlying.optionsUnderlyingConfirmed, false);
  const option = analyseOption(putTicker, underlying, 'OPTIONS_BUY', config);
  assert.equal(option.ready, false);
  assert.ok(option.blocked.includes('Underlying stage is not CONFIRMED'));
});

test('Options underlying confirmation requires normalized score >= 80', () => {
  for (const score of [79.99, null, undefined]) {
    const underlying = selectOptionsUnderlyingSignal([
      { ...marketSignal, normalizedScore: score }
    ]);
    assert.equal(underlying.optionsUnderlyingConfirmed, false, String(score));
    assert.notEqual(underlying.stage, 'CONFIRMED', String(score));
  }
});

test('Options underlying confirmation requires a market-confirmed signal and direction', () => {
  for (const patch of [
    { stage: 'SETUP' },
    { ready: false },
    { side: '' },
    { side: 'HOLD' }
  ]) {
    const underlying = selectOptionsUnderlyingSignal([{ ...marketSignal, ...patch }]);
    assert.equal(underlying.optionsUnderlyingConfirmed, false, JSON.stringify(patch));
    assert.notEqual(underlying.stage, 'CONFIRMED', JSON.stringify(patch));
  }
});

test('a confirmed fresh underlying is preferred over a higher raw-score unconfirmed engine signal', () => {
  const selected = selectOptionsUnderlyingSignal([
    { ...marketSignal, stage: 'SETUP', ready: false, score: 100, normalizedScore: 99 },
    { ...marketSignal, score: 80, normalizedScore: 85 }
  ]);
  assert.equal(selected.stage, 'CONFIRMED');
  assert.equal(selected.score, 80);
});
