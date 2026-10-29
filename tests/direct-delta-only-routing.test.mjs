import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertDirectDeltaExecutionMode,
  getExecutionRouteBlockReason,
  isDirectDeltaExecutionMode
} from '../worker/execution/execution-route-policy.mjs';

test('only explicit Delta Testnet mode selects the direct execution route', () => {
  assert.equal(isDirectDeltaExecutionMode('testnet'), true);
  assert.equal(isDirectDeltaExecutionMode(' TESTNET '), true);
  for (const mode of ['disabled', '', undefined, null, 'live', 'paper', 'tradetron']) {
    assert.equal(isDirectDeltaExecutionMode(mode), false, String(mode));
  }
  assert.equal(getExecutionRouteBlockReason('testnet'), '');
  assert.match(getExecutionRouteBlockReason('disabled'), /scan-only/);
});

test('non-Testnet execution is locked and does not silently fall back to an external bridge', () => {
  assert.equal(assertDirectDeltaExecutionMode('testnet'), true);
  for (const mode of ['disabled', 'live', undefined, null]) {
    assert.throws(() => assertDirectDeltaExecutionMode(mode), error => {
      assert.equal(error.code, 'direct_delta_testnet_only');
      assert.equal(error.executionLocked, true);
      assert.match(error.message, /Direct Delta Testnet execution is not enabled/);
      return true;
    });
  }
});

test('worker routing is wired to the direct-only policy', () => {
  const engine = readFileSync(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../server/config.js', import.meta.url), 'utf8');

  assert.match(engine, /getExecutionRouteBlockReason\(CONFIG\.deltaExecutionMode\)/);
  assert.match(engine, /assertDirectDeltaExecutionMode\(CONFIG\.deltaExecutionMode\)/);

  const executeSignalStart = engine.indexOf('async executeSignal(');
  const openTradeStart = engine.indexOf('async openTrade(', executeSignalStart);
  const manageOptionStart = engine.indexOf('async manageOptionPositionRow(', openTradeStart);
  assert.ok(executeSignalStart >= 0 && openTradeStart > executeSignalStart);
  assert.ok(manageOptionStart > openTradeStart);
  const executeSignalSource = engine.slice(executeSignalStart, openTradeStart);
  const openTradeSource = engine.slice(openTradeStart, manageOptionStart);
  assert.doesNotMatch(executeSignalSource, /getTradetronBridgeForSymbol|emitEntry\(/);
  assert.match(openTradeSource, /CONFIG\.deltaExecutionMode !== 'testnet'/);
  assert.match(openTradeSource, /only direct Delta Testnet execution is supported/);
  assert.match(openTradeSource, /return false;/);
  assert.doesNotMatch(engine, /async openOptionTrade\(/);

  assert.doesNotMatch(index, /Tradetron signal bridge is required in SIGNAL_ONLY mode/);
  assert.match(index, /public market scan-only/);
  assert.match(config, /tradetronBridgeEnabled:\s*false/);
  assert.match(config, /tradetronDynamicBridgeEnabled:\s*false/);
  assert.match(config, /tradetronOptionsBridgeEnabled:\s*false/);
});
