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
  cached_at: new Date(NOW).toISOString(),
  details: { analysisReady: true }
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
    DELTA_EXECUTION_MODE: 'testnet',
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
        max_options_positions: 4,
        ...settingsPatch
      }];
      if (table === 'dd_option_cache') return cacheRows;
      if (table === 'dd_delta_positions') return openPositions;
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
  assert.equal(requests.length, 1);
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

test('open option position with the same symbol blocks duplicate preview requests', async () => {
  const { worker, calls } = harness({
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
    data: { enabled: true, mode: 'PREVIEW_ONLY', status: 'CANDIDATE_READY', candidateReady: true }
  };
  const fresh = summarizeOptionsAutoTriggerHealth([row], { now: NOW });
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.heartbeatFresh, true);
  assert.equal(fresh.mode, 'PREVIEW_ONLY');
  assert.equal(fresh.status, 'CANDIDATE_READY');
  assert.equal(fresh.candidateReady, true);

  const stale = summarizeOptionsAutoTriggerHealth([row], { now: NOW + 300_000 });
  assert.equal(stale.enabled, false);
  assert.equal(stale.heartbeatFresh, false);
  assert.equal(stale.status, 'STALE');
});
