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
