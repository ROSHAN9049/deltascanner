import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONS_EXECUTION_ALLOWED,
  OPTIONS_EXECUTION_LOCK_REASON,
  isOptionsExecutionAllowed,
  getOptionsExecutionMode,
  getOptionsExecutionGate,
  getOptionsManualTestOverrideGate,
  OPTIONS_DATABASE_EXECUTION_LOCK_REASON,
  getOptionsDatabaseExecutionGate
} from '../worker/options-execution-lock.mjs';
import { DeltaEngine } from '../worker/engine.mjs';

test('Options entry hard-lock is false independent of route configuration', () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  assert.equal(isOptionsExecutionAllowed(), false);
  assert.match(OPTIONS_EXECUTION_LOCK_REASON, /disabled/i);
});

test('database Options execution flag is a strict default-off gate', () => {
  assert.equal(getOptionsDatabaseExecutionGate({}).allowed, false);
  assert.equal(getOptionsDatabaseExecutionGate({ options_execution_enabled: false }).allowed, false);
  assert.equal(getOptionsDatabaseExecutionGate({ options_execution_enabled: true }).allowed, true);
  assert.match(OPTIONS_DATABASE_EXECUTION_LOCK_REASON, /dd_settings\.options_execution_enabled/);
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

const demoEnv = {
  OPTIONS_EXECUTION_MODE: 'demo',
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_ENVIRONMENT: 'TESTNET',
  DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org',
  DELTA_DEMO_API_KEY: 'demo-key',
  DELTA_DEMO_API_SECRET: 'demo-secret',
  OPTIONS_EXECUTION_ALLOWED: 'true',
  OPTIONS_EXIT_MONITOR_ENABLED: 'true',
  ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true'
};

test('Options Demo mode requires the isolated Delta India Testnet profile, credentials and exit monitor', () => {
  assert.equal(getOptionsExecutionMode({}), 'disabled');
  assert.equal(getOptionsExecutionGate(demoEnv).allowed, true);
  assert.equal(getOptionsManualTestOverrideGate(demoEnv).allowed, true);
  for (const patch of [
    { DELTA_EXECUTION_MODE: 'live' },
    { DELTA_ENVIRONMENT: 'PRODUCTION' },
    { DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange' },
    { DELTA_DEMO_API_KEY: '' },
    { DELTA_DEMO_API_SECRET: '' },
    { OPTIONS_EXECUTION_ALLOWED: 'false' },
    { OPTIONS_EXIT_MONITOR_ENABLED: 'false' }
  ]) {
    assert.equal(getOptionsExecutionGate({ ...demoEnv, ...patch }).allowed, false);
  }
});

test('Options live mode is always blocked even when all Demo/Testnet flags are otherwise enabled', () => {
  const gate = getOptionsExecutionGate({ ...demoEnv, OPTIONS_EXECUTION_MODE: 'live' });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /not implemented|permanently blocked/i);
});

test('invalid Options execution mode fails closed to disabled', () => {
  assert.equal(getOptionsExecutionMode({ OPTIONS_EXECUTION_MODE: 'prod' }), 'disabled');
  assert.equal(getOptionsExecutionGate({ ...demoEnv, OPTIONS_EXECUTION_MODE: 'prod' }).allowed, false);
});


test('Options Demo gate exposes only safe booleans and the precise failing interlock', () => {
  const ready = getOptionsExecutionGate(demoEnv);
  assert.equal(ready.allowed, true);
  assert.equal(ready.credentialsConfigured, true);
  assert.equal(ready.demoApiKeyConfigured, true);
  assert.equal(ready.demoApiSecretConfigured, true);
  assert.equal(ready.restBaseMatched, true);
  assert.equal(ready.exitMonitorEnabled, true);

  const missingSecret = getOptionsExecutionGate({
    ...demoEnv,
    DELTA_DEMO_API_SECRET: ''
  });
  assert.equal(missingSecret.allowed, false);
  assert.equal(missingSecret.demoApiKeyConfigured, true);
  assert.equal(missingSecret.demoApiSecretConfigured, false);
  assert.equal(missingSecret.credentialsConfigured, false);
  assert.match(missingSecret.reason, /DELTA_DEMO_API_KEY and DELTA_DEMO_API_SECRET/);

  const wrongEndpoint = getOptionsExecutionGate({
    ...demoEnv,
    DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange'
  });
  assert.equal(wrongEndpoint.restBaseMatched, false);
  assert.match(wrongEndpoint.reason, /pinned to the Delta India Testnet REST endpoint/);

  const monitorOff = getOptionsExecutionGate({
    ...demoEnv,
    OPTIONS_EXIT_MONITOR_ENABLED: 'false'
  });
  assert.equal(monitorOff.exitMonitorEnabled, false);
  assert.match(monitorOff.reason, /OPTIONS_EXIT_MONITOR_ENABLED=true/);
});
