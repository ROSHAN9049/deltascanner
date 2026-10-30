import test from 'node:test';
import assert from 'node:assert/strict';
import { trimDetails } from '../worker/strategy.mjs';

test('main signal details retain only the approved compact fields', () => {
  const trimmed = trimDetails({
    fee: 0.0002,
    rsi: 54,
    vwap: 100,
    localScore: 88,
    candlesFresh: true,
    btcRegimeOverride: false,
    btcOverrideScoreMin: 90,
    btcOverrideVolumeMin: 1.5,
    rangeAtr: 0.8,
    emaDistanceAtr: 0.4,
    btcRegime: 'RISK_ON',
    btcRegimeStatus: 'ALLOW',
    btcRegimeSource: 'live-1h',
    btcAtrPct: 1.2,
    btcRegimeComputedAt: '2026-10-16T00:00:00.000Z',
    normalizedScore: 73.25,
    btcRegimeReason: 'long-form reason that should not be persisted',
    btcTrend5m: 'UP',
    btcTrend15m: 'UP',
    fullMarketScan: true,
    nested: { huge: true }
  }, 'MOMENTUM');

  assert.deepEqual(Object.keys(trimmed), [
    'fee',
    'rsi',
    'vwap',
    'localScore',
    'candlesFresh',
    'btcRegimeOverride',
    'btcOverrideScoreMin',
    'btcOverrideVolumeMin',
    'rangeAtr',
    'emaDistanceAtr',
    'btcRegime',
    'btcRegimeStatus',
    'btcRegimeSource',
    'btcAtrPct',
    'btcRegimeComputedAt',
    'normalizedScore'
  ]);
  assert.equal(trimmed.rsi, 54);
  assert.equal(trimmed.vwap, 100);
  assert.equal(trimmed.normalizedScore, 73.25);
  assert.equal('btcRegimeReason' in trimmed, false);
  assert.equal('btcTrend5m' in trimmed, false);
  assert.equal('btcTrend15m' in trimmed, false);
  assert.equal('nested' in trimmed, false);
});

test('options details use a separate allowlist with no more than 15 fields', () => {
  const trimmed = trimDetails({
    engine: 'OPTIONS_BUY',
    optionType: 'CALL',
    strike: 80000,
    dte: 3,
    expiryMs: 1790000000000,
    delta: 0.55,
    gamma: 0.01,
    theta: -0.2,
    vega: 3.5,
    bid: 101,
    ask: 102,
    openInterest: 1000,
    volume: 10,
    underlyingSymbol: 'BTCUSD',
    underlyingScore: 92,
    executionLocked: true,
    routeConfigured: true,
    signalOnly: true,
    tradetronRoute: 'tt_option_buy',
    longText: 'x'.repeat(201),
    nested: { bad: true }
  }, 'OPTIONS_BUY');

  assert.ok(Object.keys(trimmed).length <= 15);
  assert.equal(trimmed.optionType, 'CALL');
  assert.equal(trimmed.strike, 80000);
  assert.equal(trimmed.delta, 0.55);
  assert.equal(trimmed.underlyingScore, 92);
  assert.equal(trimmed.executionLocked, true);
  assert.equal('rsi' in trimmed, false);
  assert.equal('longText' in trimmed, false);
  assert.equal('nested' in trimmed, false);
});

test('options sell details preserve defined-risk spread, hedge fields, and Greeks', () => {
  const trimmed = trimDetails({
    optionType: 'CALL',
    strike: 90000,
    expiryMs: 1790000000000,
    dte: 4,
    delta: 0.25,
    gamma: 0.004,
    theta: -0.8,
    vega: 2.5,
    bid: 120,
    ask: 123,
    volume: 50,
    openInterest: 500,
    underlyingSymbol: 'BTCUSD',
    hedgeSymbol: 'C-BTC-95000-301026',
    hedgeStrike: 95000,
    hedgeDelta: 0.1,
    hedgeAsk: 8,
    credit: 20,
    maxRiskPerSpread: 4980,
    estimatedFeesPerSpread: 0.9,
    executionLocked: true,
    optionRouteReady: false,
    definedRiskOnly: true,
    rsi: 54,
    nested: { bad: true }
  }, 'OPTIONS_SELL');

  assert.ok(Object.keys(trimmed).length <= 18);
  assert.deepEqual(
    { gamma: trimmed.gamma, theta: trimmed.theta, vega: trimmed.vega },
    { gamma: 0.004, theta: -0.8, vega: 2.5 }
  );
  assert.equal(trimmed.hedgeSymbol, 'C-BTC-95000-301026');
  assert.equal(trimmed.hedgeStrike, 95000);
  assert.equal(trimmed.hedgeDelta, 0.1);
  assert.equal(trimmed.hedgeAsk, 8);
  assert.equal(trimmed.credit, 20);
  assert.equal(trimmed.maxRiskPerSpread, 4980);
  assert.equal(trimmed.estimatedFeesPerSpread, 0.9);
  assert.equal('rsi' in trimmed, false);
  assert.equal('executionLocked' in trimmed, false);
  assert.equal('nested' in trimmed, false);
});

test('details helper safely handles null, arrays, and unknown strategies', () => {
  assert.deepEqual(trimDetails(null, 'MOMENTUM'), {});
  assert.deepEqual(trimDetails(['no'], 'OPTIONS_BUY'), {});
  assert.deepEqual(trimDetails({ fee: 0.01, rsi: 50 }, 'UNKNOWN'), { fee: 0.01, rsi: 50 });
});
