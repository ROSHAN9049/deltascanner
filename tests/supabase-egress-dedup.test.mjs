import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('analysis shares one position-cap snapshot while final entry gate stays fresh', async () => {
  const engine = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  const analysisStart = engine.indexOf('  async analyseUniverse(');
  const analysisEnd = engine.indexOf('\n  async ', analysisStart + 10);
  const analysis = engine.slice(analysisStart, analysisEnd);
  const snapshotCall = analysis.indexOf('await this.getStrategyPositionCapSnapshot(settings)');
  const perTickerLoop = analysis.indexOf('for (let i = 0; i < tickers.length; i++)');
  assert.ok(snapshotCall >= 0 && perTickerLoop > snapshotCall);
  assert.match(analysis, /strategyPositionCapSnapshot\[strategyName\]/);
  const openTradeStart = engine.indexOf('  async openTrade(');
  const openTradeEnd = engine.indexOf('\n  async ', openTradeStart + 10);
  const openTrade = engine.slice(openTradeStart, openTradeEnd);
  assert.match(openTrade, /this\.riskGate\(signal, strategy, account, settings, openPositions, trades\)/);
  const riskGateStart = engine.indexOf('  async riskGate(');
  const riskGateEnd = engine.indexOf('\n  async ', riskGateStart + 10);
  const riskGate = engine.slice(riskGateStart, riskGateEnd);
  assert.match(riskGate, /suppliedPositionCap \|\|\s*await this\.getStrategyPositionCapAssessment/);
});

test('rotation ledger materializer uses the batched idempotent cleanup helper', async () => {
  const tracker = await readFile(new URL('../worker/execution/delta-tracker.mjs', import.meta.url), 'utf8');
  assert.match(tracker, /cleanupRotationLedgerRowsOnce\(/);
  assert.match(tracker, /rotationLedgerCleanupCompletedIds/);
  assert.doesNotMatch(tracker, /database\.remove\(\s*'dd_rotation_ledger',\s*'execution_id=eq\.'/);
});

test('engine-state API uses a short-lived cache split by authorization scope', async () => {
  const api = await readFile(new URL('../api/engine/state.js', import.meta.url), 'utf8');
  assert.match(api, /createTtlSingleFlightCache\(\{ ttlMs: 15_000 \}\)/);
  assert.match(api, /privateDataAuthorized \? 'private' : 'public'/);
  assert.match(api, /engineStateCache\.get\(cacheKey, async \(\) =>/);
  assert.match(api, /staleIfErrorMs: 120_000/);
  assert.ok(api.includes('return res.status(200).json(protectEngineState({'));
  assert.match(api, /settingsAvailable = Boolean\(rawSettings\)/);
  assert.match(api, /Fresh safety-settings read unavailable/);
  assert.ok(api.includes("const settingsRows = await select('dd_settings'"));
  assert.match(api, /async function readDashboardRows\(table, query\)/);
  assert.match(api, /dataAvailability/);
  assert.match(api, /Heartbeat failure still resolves to an empty set, so execution mode remains UNKNOWN/);
  assert.match(api, /readDashboardRows\('dd_signals'/);
  assert.match(api, /readDashboardRows\('dd_engine_logs', 'order=created_at\.desc&limit=200'\)/);
  assert.match(api, /message=like\.Worker%20heartbeat%20scan\*/);
  assert.match(api, /workerHeartbeat: heartbeatResult\.available/);
  assert.match(api, /const rawLogsWithHeartbeat = heartbeatLog/);
  assert.match(api, /readDashboardRows\('dd_engine_logs'/);
});

test('Options IV write and aggregate failures use bounded backoff and remain fail-closed', async () => {
  const engine = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../worker/iv-history-write-policy.mjs', import.meta.url), 'utf8');
  assert.match(engine, /isIvRetryReady\(this\.ivHistoryWriteRetryByUnderlying, underlying, now\)/);
  assert.match(engine, /isIvRetryReady\(this\.ivGroupMetricsRetryByUnderlying, underlying, now\)/);
  assert.match(engine, /IV_HISTORY_WRITE_RETRY_BACKOFF/);
  assert.match(engine, /IV_GROUP_METRICS_RETRY_BACKOFF/);
  assert.match(engine, /retry backoff scheduled/);
  assert.match(policy, /IV_RETRY_MAX_DELAY_MS = 5 \* 60 \* 1000/);
});

test('position-cap snapshots require exact counts to detect server-side row caps', async () => {
  const helper = await readFile(new URL('../worker/strategy-position-cap-snapshot.mjs', import.meta.url), 'utf8');
  const db = await readFile(new URL('../server/db.js', import.meta.url), 'utf8');
  assert.match(helper, /database\.selectWithCount\(/);
  assert.match(helper, /openTotal !== openPositions\.length/);
  assert.match(helper, /entryOrderTotal !== entryOrders\.length/);
  assert.match(db, /Prefer: 'count=exact'/);
  assert.match(db, /Range: '0-' \+ \(limit - 1\)/);
});


test('dashboard and health message-filtered engine logs have a registered message-first index migration', async () => {
  const migration = await readFile(new URL('../db/migrations/20261120000100_engine_log_message_latest_idx.sql', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../scripts/apply-all-migrations.mjs', import.meta.url), 'utf8');
  const health = await readFile(new URL('../api/health.js', import.meta.url), 'utf8');
  const state = await readFile(new URL('../api/engine/state.js', import.meta.url), 'utf8');
  assert.match(migration, /CREATE INDEX IF NOT EXISTS dd_engine_logs_message_created_idx/i);
  assert.match(migration, /ON public\\.dd_engine_logs \\(message, created_at DESC\\)/i);
  assert.match(runner, /20261120000100_engine_log_message_latest_idx/);
  assert.match(health, /message=eq\\.%5BAUTO-TRIGGER%5D/);
  assert.match(health, /message=eq\\.%5BRetention%5D/);
  assert.match(state, /message=like\\.Worker%20heartbeat%20scan\\*/);
});
