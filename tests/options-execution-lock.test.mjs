import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONS_EXECUTION_ALLOWED,
  OPTIONS_EXECUTION_LOCK_REASON,
  isOptionsExecutionAllowed
} from '../worker/options-execution-lock.mjs';
import { DeltaEngine } from '../worker/engine.mjs';

test('Options entry hard-lock is false independent of route configuration', () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  assert.equal(isOptionsExecutionAllowed(), false);
  assert.match(OPTIONS_EXECUTION_LOCK_REASON, /maximum loss/i);
});

test('actual engine refuses BUY and SELL Options through the only supported entry method', async () => {
  const engine = new DeltaEngine();
  let buyCalls = 0;
  let spreadCalls = 0;

  engine.tradetronOptions.emitOptionEntry = async () => {
    buyCalls += 1;
    return { ok: true };
  };
  engine.tradetronOptions.emitOptionSpread = async () => {
    spreadCalls += 1;
    return { ok: true };
  };

  const common = {
    stage: 'CONFIRMED',
    ready: true,
    normalizedScore: 95,
    symbol: 'C-BTC-80000-311226',
    qty: 1,
    mark: 100,
    optionType: 'CALL',
    expiryMs: Date.UTC(2026, 11, 31)
  };

  assert.equal(typeof engine.openOptionTrade, 'undefined');

  const buyResult = await engine.openTrade(
    {}, 'OPTIONS_BUY', { ...common, strategy: 'OPTIONS_BUY' }, {}, {}, [], []
  );
  const sellResult = await engine.openTrade(
    {}, 'OPTIONS_SELL', { ...common, strategy: 'OPTIONS_SELL', hedgeSymbol: 'C-BTC-82000-311226' }, {}, {}, [], []
  );

  assert.equal(buyResult, false);
  assert.equal(sellResult, false);
  assert.equal(buyCalls, 0);
  assert.equal(spreadCalls, 0);
});

test('Options risk gate independently requires CONFIRMED, ready and a ready underlying', async () => {
  const engine = new DeltaEngine();
  const settings = {
    enabled: true,
    auto_trade: true,
    emergency_stop: false,
    continuous_mode: true
  };
  const account = { equity: 10000, available: 10000 };

  for (const strategy of ['OPTIONS_BUY', 'OPTIONS_SELL']) {
    const gate = await engine.riskGate({
      symbol: 'C-BTC-80000-311226',
      stage: 'SETUP',
      ready: false,
      underlyingReady: false,
      executionLocked: true,
      definedRiskOnly: strategy === 'OPTIONS_SELL',
      hedgeSymbol: strategy === 'OPTIONS_SELL' ? 'C-BTC-82000-311226' : undefined,
      ticker: {
        symbol: 'C-BTC-80000-311226',
        testnet_product_verified: true,
        underlying_spot: 90000,
        contract_value: 0.001,
        quotes: { best_ask: 20, best_bid: 19 }
      },
      hedgeTicker: strategy === 'OPTIONS_SELL' ? {
        symbol: 'C-BTC-82000-311226',
        testnet_product_verified: true,
        underlying_spot: 90000,
        contract_value: 0.001,
        quotes: { best_ask: 5, best_bid: 4 }
      } : undefined,
      ask: 20,
      bid: 19,
      hedgeAsk: 5,
      strike: 80000,
      hedgeStrike: 82000
    }, strategy, account, settings, [], []);

    assert.ok(gate.reasons.includes('Signal stage SETUP is not CONFIRMED'));
    assert.ok(gate.reasons.includes('Signal ready flag is not true'));
    assert.ok(gate.reasons.includes(
      'Underlying signal is not ready (fresh-candle or risk gate failed)'
    ));
    assert.ok(gate.reasons.includes('Option execution route locked'));
  }
});
