import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseOption } from '../worker/strategy.mjs';

const underlying = {
  symbol: 'BTCUSD',
  side: 'BUY',
  stage: 'CONFIRMED',
  score: 95,
  normalizedScore: 95,
  change: 0
};

const baseTicker = {
  symbol: 'C-BTC-80000-311226',
  underlying: 'BTC',
  contract_type: 'call_options',
  mark_price: 100,
  quotes: { best_bid: 99, best_ask: 101 },
  iv_rank: 25,
  open_interest: 1000,
  volume: 10
};

const config = {
  minDays: 1,
  maxDays: 120,
  minOi: 1,
  minVolume: 1,
  maxSpreadPct: 10,
  buyMinDelta: 0.45,
  buyMaxDelta: 0.65,
  scoreMin: 80
};

test('uses normalized underlying score instead of a high raw local score', () => {
  const signal = analyseOption(
    { ...baseTicker, greeks: { delta: 0.55 } },
    { ...underlying, stage: 'SETUP', score: 100, normalizedScore: 57.5 },
    'OPTIONS_BUY',
    config
  );
  assert.equal(signal.underlyingScore, 57.5);
  assert.equal(signal.underlyingRawScore, 100);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Underlying stage is not CONFIRMED'));
  assert.ok(signal.blocked.includes('Underlying normalized score below 80 or unavailable'));
});

test('a high normalized score does not bypass the underlying CONFIRMED stage', () => {
  const signal = analyseOption(
    { ...baseTicker, greeks: { delta: 0.55 } },
    { ...underlying, stage: 'SETUP', score: 100, normalizedScore: 95 },
    'OPTIONS_BUY',
    config
  );
  assert.equal(signal.underlyingScore, 95);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Underlying stage is not CONFIRMED'));
  assert.ok(!signal.blocked.some(reason => reason.includes('normalized score below')));
});

test('missing normalized underlying score fails closed even when raw score is high', () => {
  const signal = analyseOption(
    { ...baseTicker, greeks: { delta: 0.55 } },
    { ...underlying, score: 100, normalizedScore: null },
    'OPTIONS_BUY',
    config
  );
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Underlying normalized score below 80 or unavailable'));
});

test('missing option Delta remains missing and cannot qualify', () => {
  const signal = analyseOption({ ...baseTicker }, underlying, 'OPTIONS_BUY', config);
  assert.equal(signal.delta, null);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Delta outside target band'));
});

test('a genuine zero option Delta is preserved but fails the configured band', () => {
  const signal = analyseOption({ ...baseTicker, greeks: { delta: 0 } }, underlying, 'OPTIONS_BUY', config);
  assert.equal(signal.delta, 0);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Delta outside target band'));
});


test('Delta option Greeks returned as numeric strings are parsed and pass the BUY Delta band', () => {
  const signal = analyseOption({
    ...baseTicker,
    greeks: { delta: '0.55', gamma: '0.01', theta: '-0.02', vega: '0.12' }
  }, underlying, 'OPTIONS_BUY', config);
  assert.equal(signal.delta, 0.55);
  assert.equal(signal.ready, true, JSON.stringify(signal));
  assert.equal(signal.stage, 'CONFIRMED');
});

test('Delta option Greeks returned as numeric strings are parsed and pass the SELL Delta band', () => {
  const signal = analyseOption({
    ...baseTicker,
    symbol: 'P-BTC-76000-311226',
    contract_type: 'put_options',
    greeks: { delta: '0.28', gamma: '0.01', theta: '-0.02', vega: '0.12' }
  }, underlying, 'OPTIONS_SELL', {
    ...config,
    sellMinDelta: 0.20,
    sellMaxDelta: 0.35
  });
  assert.equal(signal.delta, 0.28);
  assert.equal(signal.ready, true);
  assert.equal(signal.stage, 'CONFIRMED');
});
