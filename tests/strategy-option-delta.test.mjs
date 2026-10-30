import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseOption } from '../worker/strategy.mjs';

const underlying = {
  symbol: 'BTCUSD',
  side: 'BUY',
  stage: 'CONFIRMED',
  score: 95,
  ready: true,
  change: 0
};

const baseTicker = {
  symbol: 'C-BTC-80000-311226',
  underlying: 'BTC',
  contract_type: 'call_options',
  mark_price: 100,
  quotes: { best_bid: 99, best_ask: 101 },
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

test('option candidates fail closed when the underlying signal is not ready', () => {
  const liquidCall = {
    ...baseTicker,
    greeks: { delta: 0.55 }
  };
  for (const override of [{ ready: false }, { ready: undefined }]) {
    const signal = analyseOption(
      liquidCall,
      { ...underlying, ...override },
      'OPTIONS_BUY',
      config
    );
    assert.equal(signal.underlyingReady, false);
    assert.equal(signal.ready, false);
    assert.ok(signal.blocked.includes(
      'Underlying signal is not ready (fresh-candle or risk gate failed)'
    ));
  }
});

test('option candidates remain eligible only when the underlying signal is ready', () => {
  const signal = analyseOption(
    { ...baseTicker, greeks: { delta: 0.55 } },
    underlying,
    'OPTIONS_BUY',
    config
  );
  assert.equal(signal.underlyingReady, true);
  assert.equal(signal.stage, 'CONFIRMED');
  assert.equal(signal.ready, true);
});
