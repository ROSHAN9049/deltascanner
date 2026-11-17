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
