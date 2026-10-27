import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaEngine } from '../worker/engine.mjs';

const engine = new DeltaEngine();
const account = { equity: 1000, available: 1000 };
const settings = { risk_pct: 1, max_leverage: 3 };

function validSignal(overrides = {}) {
  return {
    symbol: 'BABABUSD',
    stage: 'CONFIRMED',
    ready: true,
    side: 'BUY',
    price: 100,
    sl: 90,
    tp: 120,
    contractValue: 1,
    notionalType: 'vanilla',
    ...overrides
  };
}

test('position sizing only accepts CONFIRMED and ready=true signals', () => {
  for (const stage of ['SETUP', 'WATCH', 'UNKNOWN']) {
    assert.equal(
      engine.positionSizing(validSignal({ stage }), account, settings),
      null,
      stage + ' must not be sized'
    );
  }
  assert.equal(
    engine.positionSizing(validSignal({ ready: false }), account, settings),
    null,
    'ready=false must not be sized'
  );
});

test('position sizing fails closed on zero, missing, NaN or non-numeric SL', () => {
  for (const sl of [0, null, undefined, NaN, 'not-a-number']) {
    assert.equal(
      engine.positionSizing(validSignal({ sl }), account, settings),
      null,
      'invalid SL must not produce a position size: ' + String(sl)
    );
  }
});

test('position sizing fails closed on invalid TP', () => {
  for (const tp of [0, null, undefined, NaN, 'not-a-number']) {
    assert.equal(
      engine.positionSizing(validSignal({ tp }), account, settings),
      null,
      'invalid TP must not produce a position size: ' + String(tp)
    );
  }
});

test('valid CONFIRMED and ready signal still receives a positive risk-based size', () => {
  const size = engine.positionSizing(validSignal(), account, settings);
  assert.ok(size);
  assert.equal(size.qty, 1);
});
