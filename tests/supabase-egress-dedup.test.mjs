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
  assert.match(api, /return res\.status\(200\)\.json\(payload\)/);
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
