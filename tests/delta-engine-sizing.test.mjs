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

function withNotionalMultiplier(value, callback) {
  const previous = process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER;
  if (value === null) delete process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER;
  else process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER = String(value);
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER;
    else process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER = previous;
  }
}

test('position sizing caps each entry at 15% of available margin', () => {
  const size = withNotionalMultiplier(2, () => engine.positionSizing(
    validSignal({ price: 100, sl: 99, contractValue: 1 }),
    { equity: 100000, available: 1000 },
    { risk_pct: 1, max_leverage: 3 }
  ));

  assert.ok(size);
  assert.equal(size.maxQtyByMargin, 4);
  assert.equal(size.qty, 4);
  assert.ok(size.marginEstimate <= 150);
  assert.ok(size.marginEstimate <= 1000);
});

test('position sizing applies a default 2x-equity notional cap', () => {
  const size = withNotionalMultiplier(2, () => engine.positionSizing(
    validSignal({ price: 100, sl: 99, contractValue: 1 }),
    { equity: 1000, available: 100000 },
    { risk_pct: 10, max_leverage: 3 }
  ));

  assert.ok(size);
  assert.equal(size.notionalCap, 2000);
  assert.equal(size.maxQtyByNotional, 20);
  assert.equal(size.qty, 20);
  assert.ok(size.notional <= 2000);
});

test('position sizing honours an explicitly configured equity notional multiplier', () => {
  const size = withNotionalMultiplier(1, () => engine.positionSizing(
    validSignal({ price: 100, sl: 99, contractValue: 1 }),
    { equity: 1000, available: 100000 },
    { risk_pct: 10, max_leverage: 3 }
  ));

  assert.ok(size);
  assert.equal(size.maxNotionalEquityMultiplier, 1);
  assert.equal(size.notionalCap, 1000);
  assert.equal(size.qty, 10);
});

test('position sizing preserves the exchange product notional cap', () => {
  const size = withNotionalMultiplier(2, () => engine.positionSizing(
    validSignal({ price: 100, sl: 99, contractValue: 1, maxLeverageNotional: 150 }),
    { equity: 1000, available: 100000 },
    { risk_pct: 10, max_leverage: 3 }
  ));

  assert.ok(size);
  assert.equal(size.maxQtyByNotional, 1);
  assert.equal(size.qty, 1);
  assert.ok(size.notional <= 150);
});

test('position sizing never bypasses the risk cap for a one-contract fallback', () => {
  const size = withNotionalMultiplier(2, () => engine.positionSizing(
    validSignal({ price: 100, sl: 90, contractValue: 1 }),
    { equity: 1000, available: 1000 },
    { risk_pct: 0.1, max_leverage: 3 }
  ));

  assert.equal(size, null, 'riskQty=0 must not be promoted to one contract');
});

test('position sizing fails closed when available margin is zero', () => {
  const size = withNotionalMultiplier(2, () => engine.positionSizing(
    validSignal({ price: 100, sl: 99, contractValue: 1 }),
    { equity: 1000, available: 0 },
    { risk_pct: 1, max_leverage: 3 }
  ));

  assert.equal(size, null);
});
