import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOptionsAutoTrigger,
  OPTIONS_AUTO_TRIGGER_INTERVAL_MS
} from '../worker/options-auto-trigger.mjs';
import { summarizeOptionsAutoTriggerHealth } from '../src/options-auto-trigger-health.js';

const NOW = Date.UTC(2026, 10, 5, 2, 0, 0);
const CANDIDATE = {
  symbol: 'C-BTC-80000-311226',
  strategy: 'OPTIONS_BUY',
  score: 95,
  stage: 'CONFIRMED',
  market_regime: 'TRENDING',
  iv_rank: 30,
  iv_percentile: 10,
  oi: 100,
  volume: 10,
  spread_pct: 0.25,
  delta: 0.55,
  dte: 8,
  cached_at: new Date(NOW).toISOString(),
  details: { analysisReady: true, marketRegime: 'TRENDING', ivRank: 30, ivPercentile: 10, ivPercentileDays: 20, delta: 0.55, dte: 8 }
};

function harness({
  envPatch = {},
  settingsPatch = {},
  cacheRows = [CANDIDATE],
  openPositions = [],
  activeOrders = [],
  recentFilledOrders = [],
  previewPayload = { success: true, preview: { executionAllowed: true, quoteToken: 'short-lived-token' } },
  responseOk = true
} = {}) {
  const calls = [];
  const logs = [];
  const timers = [];
  const cleared = [];
  const env = {
    AUTO_EXECUTE_OPTIONS: 'true',
    FULL_AUTO_EXECUTE: 'false',
    OPTIONS_REGIME_STRATEGY_ENABLED: 'true',
    OPTIONS_EXIT_MONITOR_ENABLED: 'true',
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_ENVIRONMENT: 'TESTNET',
    OPTIONS_EXECUTION_ALLOWED: 'true',
    ENGINE_SECRET: 'worker-secret',
    OPTIONS_AUTO_TRIGGER_API_URL: 'https://deltascanner-api-v2.hostless.app',
    ...envPatch
  };
  const database = {
    async select(table, query) {
      calls.push({ kind: 'select', table, query });
      if (table === 'dd_settings') return [{
        enabled: true,
        auto_trade: true,
        emergency_stop: false,
        options_enabled: true,
        options_buy_enabled: true,
        options_sell_enabled: true,
        options_execution_enabled: true,
        max_options_positions: 4,
        options_max_open_positions: 1,
        options_min_oi: 50,
        options_min_volume: 1,
        options_max_spread_pct: 1.5,
        options_min_days_to_expiry: 2,
        options_max_days_to_expiry: 14,
        options_buy_min_delta: 0.45,
        options_buy_max_delta: 0.65,
        options_sell_min_delta: 0.20,
        options_sell_max_delta: 0.35,
        ...settingsPatch
      }];
      if (table === 'dd_option_cache') return cacheRows;
      if (table === 'dd_delta_positions') return openPositions;
      if (table === 'dd_option_positions') return [];
      if (table === 'dd_orders' && query.includes('state=eq.FILLED')) return recentFilledOrders;
      if (table === 'dd_orders') return activeOrders;
      return [];
    }
  };
  const fetchImpl = async (url, init) => {
    calls.push({ kind: 'fetch', url: String(url), init });
    return {
      ok: responseOk,
      async json() { return previewPayload; }
    };
  };
  const logger = async (...args) => logs.push(args);
  const setIntervalFn = (callback, delay) => {
    const timer = { callback, delay, unref() { this.unrefCalled = true; } };
    timers.push(timer);
    return timer;
  };
  const clearIntervalFn = timer => cleared.push(timer);
  const worker = createOptionsAutoTrigger({
    env,
    database,
    fetchImpl,
    logger,
    now: () => NOW,
    setIntervalFn,
    clearIntervalFn
  });
  return { worker, calls, logs, timers, cleared };
}

test('preview-only poller requests the API preview with ENGINE_SECRET and never submits an order', async () => {
  const { worker, calls, logs } = harness();
  const result = await worker.runOnce();
  assert.equal(result.status, 'CANDIDATE_READY');
  const requests = calls.filter(call => call.kind === 'fetch');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://deltascanner-api-v2.hostless.app/api/options/preview');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['x-engine-secret'], 'worker-secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    symbol: CANDIDATE.symbol,
    strategy: CANDIDATE.strategy,
    qty: 1,
    manualOverride: false
  });
  assert.ok(logs.some(args => args[1] === '[AUTO-TRIGGER] Candidate ready for execution. Token acquired. Waiting for manual execution.'));
  assert.ok(logs.every(args => !String(args[1]).includes('/api/options/execute')));
  const heartbeat = logs.find(args => args[1] === '[AUTO-TRIGGER] Worker heartbeat');
  assert.equal(heartbeat?.[2]?.fullAutoExecute, false);
  assert.equal(heartbeat?.[2]?.mode, 'PREVIEW_ONLY');
  assert.equal(requests.length, 1);
});

test('disabled poller heartbeat still reports the separate full-auto flag without executing', async () => {
  const { worker, calls, logs } = harness({
    envPatch: { AUTO_EXECUTE_OPTIONS: 'false', FULL_AUTO_EXECUTE: 'true' },
    cacheRows: []
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'DISABLED');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
  const heartbeat = logs.find(args => args[1] === '[AUTO-TRIGGER] Worker heartbeat');
  assert.equal(heartbeat?.[2]?.enabled, false);
  assert.equal(heartbeat?.[2]?.fullAutoExecute, true);
  assert.equal(heartbeat?.[2]?.mode, 'AUTO_EXECUTE');
});

test('auto-trade false blocks the preview poller before any HTTP request', async () => {
  const { worker, calls, logs } = harness({ settingsPatch: { auto_trade: false } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'BLOCKED_AUTO_TRADE');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
  assert.ok(logs.some(args => args[2]?.status === 'BLOCKED_AUTO_TRADE'));
});

test('unknown or active emergency stop blocks the preview poller', async () => {
  const { worker, calls } = harness({ settingsPatch: { emergency_stop: true } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'BLOCKED_ESTOP');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
});

test('database Options opt-in false blocks before preview or execution', async () => {
  const { worker, calls, logs } = harness({
    settingsPatch: { options_execution_enabled: false }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'BLOCKED_OPTIONS_EXECUTION_DISABLED');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
  assert.ok(logs.some(args => args[2]?.status === 'BLOCKED_OPTIONS_EXECUTION_DISABLED'));
});

test('open option position with the same symbol blocks duplicate preview requests', async () => {
  const { worker, calls } = harness({
    settingsPatch: { options_max_open_positions: 2 },
    openPositions: [{ symbol: CANDIDATE.symbol }]
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'READY');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
});

test('position cap blocks preview requests when occupied option slots reach the configured maximum', async () => {
  const { worker, calls } = harness({
    settingsPatch: { max_options_positions: 2 },
    openPositions: [{ symbol: 'C-BTC-79000-311226' }, { symbol: 'C-BTC-78000-311226' }]
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'BLOCKED_POSITION_CAP');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
});

test('cache candidates must be confirmed, analysis-ready, scored and fresh', async () => {
  const rows = [
    { ...CANDIDATE, stage: 'SETUP' },
    { ...CANDIDATE, symbol: 'C-BTC-79000-311226', details: { analysisReady: false } },
    { ...CANDIDATE, symbol: 'C-BTC-78000-311226', score: 70 },
    { ...CANDIDATE, symbol: 'C-BTC-77000-311226', cached_at: new Date(NOW - 600_000).toISOString() }
  ];
  const { worker, calls } = harness({ cacheRows: rows });
  const result = await worker.runOnce();
  assert.equal(result.status, 'READY');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
});

test('worker polls at a 60-second cadence and can be stopped cleanly', async () => {
  const { worker, timers, cleared } = harness();
  await worker.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, OPTIONS_AUTO_TRIGGER_INTERVAL_MS);
  assert.equal(timers[0].delay, 60_000);
  assert.equal(timers[0].unrefCalled, true);
  await worker.stop();
  assert.deepEqual(cleared, timers);
});

test('preview failures remain preview-only and are reported as a blocked worker state', async () => {
  const { worker, calls, logs } = harness({
    responseOk: false,
    previewPayload: { success: false, error: 'Preview endpoint unavailable' }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'ERROR');
  assert.equal(calls.filter(call => call.kind === 'fetch').length, 1);
  assert.ok(logs.some(args => args[2]?.status === 'ERROR'));
});

test('Options auto-trigger health only reports fresh, enabled preview-only heartbeats as ready', () => {
  const row = {
    created_at: new Date(NOW).toISOString(),
    data: { enabled: true, mode: 'PREVIEW_ONLY', fullAutoExecute: false, status: 'CANDIDATE_READY', candidateReady: true }
  };
  const fresh = summarizeOptionsAutoTriggerHealth([row], { now: NOW });
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.heartbeatFresh, true);
  assert.equal(fresh.mode, 'PREVIEW_ONLY');
  assert.equal(fresh.fullAutoExecute, false);
  assert.equal(fresh.status, 'CANDIDATE_READY');
  assert.equal(fresh.candidateReady, true);

  const stale = summarizeOptionsAutoTriggerHealth([row], { now: NOW + 300_000 });
  assert.equal(stale.enabled, false);
  assert.equal(stale.heartbeatFresh, false);
  assert.equal(stale.fullAutoExecute, null);
  assert.equal(stale.status, 'STALE');

  const autoExecute = summarizeOptionsAutoTriggerHealth([{
    ...row,
    data: { ...row.data, mode: 'AUTO_EXECUTE', fullAutoExecute: true }
  }], { now: NOW });
  assert.equal(autoExecute.mode, 'AUTO_EXECUTE');
  assert.equal(autoExecute.fullAutoExecute, true);
});
test('Demo Options execution does not inherit the global Futures FULL_AUTO_EXECUTE flag', async () => {
  const { worker, calls } = harness({
    envPatch: {
      FULL_AUTO_EXECUTE: 'true',
      OPTIONS_EXECUTION_MODE: 'demo',
      OPTIONS_DEMO_AUTO_EXECUTE: 'false',
      OPTIONS_EXIT_MONITOR_ENABLED: 'true',
      DELTA_DEMO_API_KEY: 'demo-key',
      DELTA_DEMO_API_SECRET: 'demo-secret',
      ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true',
      DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org'
    },
    cacheRows: [{
      ...CANDIDATE, stage: 'SETUP', market_regime: 'UNKNOWN',
      iv_rank: 48, iv_percentile: null, oi: 1, volume: 2,
      spread_pct: 0.4, delta: 0.55, dte: 8,
      details: { ...CANDIDATE.details, analysisReady: false, delta: 0.55, dte: 8, ivPercentile: null }
    }]
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'CANDIDATE_READY');
  const requests = calls.filter(call => call.kind === 'fetch');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/api/options/preview'));
  assert.equal(calls.some(call => call.kind === 'fetch' && call.url.endsWith('/api/options/execute')), false);
});

test('Demo full-auto passes the isolated Demo credentials and manual quality override only in Testnet', async () => {
  const demoCandidate = {
    symbol: 'P-BTC-59600-171126',
    strategy: 'OPTIONS_BUY',
    score: 87,
    stage: 'SETUP',
    market_regime: 'UNKNOWN',
    iv_rank: 48.29,
    iv_percentile: null,
    oi: 0.485,
    volume: 3.968,
    spread_pct: 0.3935,
    cached_at: new Date(NOW).toISOString(),
    details: {
      analysisReady: false, dte: 12.5, delta: -0.5837,
      optionType: 'PUT', strike: 59600, underlyingSymbol: 'BTCUSD',
      ivRank: 48.29, ivPercentile: null, openInterest: 0.485, volume: 3.968
    }
  };
  const { worker, calls, logs } = harness({
    envPatch: {
      FULL_AUTO_EXECUTE: 'false',
      OPTIONS_DEMO_AUTO_EXECUTE: 'true',
      OPTIONS_EXECUTION_MODE: 'demo',
      OPTIONS_EXIT_MONITOR_ENABLED: 'true',
      OPTIONS_REGIME_STRATEGY_ENABLED: 'false',
      DELTA_DEMO_API_KEY: 'demo-key',
      DELTA_DEMO_API_SECRET: 'demo-secret',
      ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true',
      DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org'
    },
    cacheRows: [demoCandidate]
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'ORDER_EXECUTED');
  const requests = calls.filter(call => call.kind === 'fetch');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith('/api/options/preview'));
  assert.ok(requests[1].url.endsWith('/api/options/execute'));
  assert.equal(JSON.parse(requests[0].init.body).manualOverride, true);
  assert.equal(JSON.parse(requests[1].init.body).manualOverride, true);
  assert.ok(logs.some(args => args[1] === '[AUTO-TRIGGER] Executing automatically...'));
  assert.ok(logs.some(args => String(args[1]).includes('Demo-only candidate quality filters observed')));
  assert.ok(logs.every(args => args[1] !== '[AUTO-TRIGGER] Candidate ready for execution. Token acquired. Waiting for manual execution.'));
});

test('Options auto-trigger requires both the Testnet execution mode and TESTNET environment', async () => {
  for (const envPatch of [
    { DELTA_ENVIRONMENT: 'SIGNAL_ONLY' },
    { DELTA_ENVIRONMENT: '' },
    { DELTA_EXECUTION_MODE: 'disabled' }
  ]) {
    const { worker, calls } = harness({ envPatch });
    const result = await worker.runOnce();
    assert.equal(result.status, 'BLOCKED_NOT_TESTNET');
    assert.equal(calls.some(call => call.kind === 'fetch'), false);
  }
});

test('FULL_AUTO_EXECUTE cannot submit when OPTIONS_EXECUTION_ALLOWED is false or missing', async () => {
  for (const value of ['false', '']) {
    const { worker, calls, logs } = harness({
      envPatch: { FULL_AUTO_EXECUTE: 'true', OPTIONS_EXECUTION_ALLOWED: value }
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'BLOCKED_OPTIONS_ENV_EXECUTION_DISABLED');
    assert.equal(calls.some(call => call.kind === 'fetch'), false);
    const heartbeat = logs.find(args => args[1] === '[AUTO-TRIGGER] Worker heartbeat');
    assert.equal(heartbeat?.[2]?.status, 'BLOCKED_OPTIONS_ENV_EXECUTION_DISABLED');
  }
});

test('auto-trigger requires the strategy-specific daily IV Percentile threshold', async () => {
  const blockedBuyRows = [
    { ...CANDIDATE, iv_percentile: null, details: { ...CANDIDATE.details, ivPercentile: null } },
    { ...CANDIDATE, iv_percentile: 20, details: { ...CANDIDATE.details, ivPercentile: 20 } }
  ];
  for (const row of blockedBuyRows) {
    const { worker, calls } = harness({ cacheRows: [row] });
    const result = await worker.runOnce();
    assert.equal(result.status, 'READY');
    assert.equal(calls.some(call => call.kind === 'fetch'), false);
  }

  const sellBase = {
    ...CANDIDATE,
    strategy: 'OPTIONS_SELL',
    market_regime: 'SIDEWAYS',
    iv_rank: 60,
    iv_percentile: 90,
    details: { ...CANDIDATE.details, marketRegime: 'SIDEWAYS', ivRank: 60, ivPercentile: 90 }
  };
  const sellPass = harness({ cacheRows: [sellBase] });
  assert.equal((await sellPass.worker.runOnce()).status, 'CANDIDATE_READY');

  for (const percentile of [null, 80]) {
    const row = {
      ...sellBase,
      iv_percentile: percentile,
      details: { ...sellBase.details, ivPercentile: percentile }
    };
    const { worker, calls } = harness({ cacheRows: [row] });
    const result = await worker.runOnce();
    assert.equal(result.status, 'READY');
    assert.equal(calls.some(call => call.kind === 'fetch'), false);
  }
});

test('Demo quality override still enforces score, spread, DTE and supported underlying', async () => {
  const base = {
    symbol: 'P-BTC-59600-171126',
    strategy: 'OPTIONS_BUY',
    score: 87,
    stage: 'SETUP',
    market_regime: 'UNKNOWN',
    iv_rank: 48,
    iv_percentile: null,
    oi: 0.485,
    volume: 3.9,
    spread_pct: 0.4,
    cached_at: new Date(NOW).toISOString(),
    details: { analysisReady: false, dte: 12, delta: -0.58, optionType: 'PUT', strike: 59600, underlyingSymbol: 'BTCUSD' }
  };
  const envPatch = {
    OPTIONS_EXECUTION_MODE: 'demo',
    OPTIONS_EXIT_MONITOR_ENABLED: 'true',
    DELTA_DEMO_API_KEY: 'demo-key',
    DELTA_DEMO_API_SECRET: 'demo-secret',
    ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true',
    DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org'
  };
  const blocked = [
    { ...base, score: 79 },
    { ...base, symbol: 'P-BTC-59600-171126', spread_pct: 1.51 },
    { ...base, symbol: 'P-BTC-59600-171126', details: { ...base.details, dte: 1 } },
    { ...base, symbol: 'P-XAUT-59600-171126' }
  ];
  const { worker, calls } = harness({ envPatch, cacheRows: blocked });
  const result = await worker.runOnce();
  assert.equal(result.status, 'READY');
  assert.equal(calls.some(call => call.kind === 'fetch'), false);
});

