import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/score-distribution.mjs', import.meta.url));

test('score distribution reports target bands, score statistics and strategy/stage groups', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-score-distribution-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'scores.json');
  const records = {
    signals: [
      { symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'WATCH', score: 0 },
      { symbol: 'ETHUSD', strategy: 'SCALPING', stage: 'SETUP', score: 39.99 },
      { symbol: 'ADAUSD', strategy: 'MOMENTUM', stage: 'SETUP', score: 40 },
      { symbol: 'SOLUSD', strategy: 'SCALPING', stage: 'WATCH', score: 69.99 },
      { symbol: 'XRPUSD', strategy: 'MOMENTUM', stage: 'SETUP', score: 70 },
      { symbol: 'BNBUSD', strategy: 'SCALPING', stage: 'WATCH', score: 84.99 },
      { symbol: 'LINKUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 85 },
      { symbol: 'DOGEUSD', strategy: 'SCALPING', stage: 'CONFIRMED', score: 100 },
      { symbol: 'BADUSD', strategy: 'SCALPING', stage: 'WATCH', score: 101 },
      { symbol: 'MISSUSD', strategy: 'MOMENTUM', stage: 'WATCH', score: 'not-a-score' }
    ]
  };
  await fs.writeFile(inputPath, JSON.stringify(records), 'utf8');

  const run = spawnSync(process.execPath, [scriptPath, inputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.count, 8);
  assert.equal(report.skippedRows, 2);
  assert.equal(report.statistics.min, 0);
  assert.equal(report.statistics.max, 100);
  assert.equal(report.bands['0-<40'].count, 2);
  assert.equal(report.bands['40-<70'].count, 2);
  assert.equal(report.bands['70-<85'].count, 2);
  assert.equal(report.bands['85-100'].count, 2);
  assert.equal(report.bands['0-<40'].actualPct, 25);
  assert.equal(report.bands['85-100'].actualPct, 25);
  assert.equal(report.byStrategy.MOMENTUM, 4);
  assert.equal(report.byStrategy.SCALPING, 4);
  assert.equal(report.byStage.WATCH, 3);
  assert.equal(report.byStage.CONFIRMED, 2);
});

test('score distribution exits with a clear error when no valid scores exist', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-score-distribution-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'scores.json');
  await fs.writeFile(inputPath, JSON.stringify({ scores: [{ score: 101 }, { score: 'n/a' }] }), 'utf8');

  const run = spawnSync(process.execPath, [scriptPath, inputPath], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /No finite scores within 0-100/);
});


test('score distribution compares original and normalized scores with same-population coverage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-score-distribution-normalized-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'scores.json');
  const records = {
    signals: [
      { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'AAAUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', side: 'BUY', score: 95, rsi: 70, trend: 'BULL', volume_spike: 2, ema_distance_atr: 0.3 },
      { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'BBBUSD', strategy: 'MOMENTUM', stage: 'SETUP', side: 'BUY', score: 75, rsi: 50, trend: 'FLAT', volume_spike: 1, ema_distance_atr: 1.5 },
      { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'CCCUSD', strategy: 'MOMENTUM', stage: 'WATCH', side: 'SELL', score: 40, rsi: 60, trend: 'BEAR', volume_spike: 0.5, ema_distance_atr: 2.5 },
      { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'DDDUSD', strategy: 'SCALPING', stage: 'CONFIRMED', side: 'BUY', score: 92, rsi: 68, trend: 'BULL', volume_spike: 1.8, ema_distance_atr: 0.4, details: { normalizedScore: 83.5 } }
    ]
  };
  await fs.writeFile(inputPath, JSON.stringify(records), 'utf8');

  const run = spawnSync(process.execPath, [scriptPath, inputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.count, 4);
  assert.equal(report.normalized.count, 4);
  assert.equal(report.samePopulation.count, 4);
  assert.equal(report.byStrategyDistribution.MOMENTUM.normalizedCount, 3);
  assert.equal(report.byStrategyDistribution.SCALPING.normalizedCount, 1);
  assert.equal(report.normalized.targetAtLeast85Pct, 2);
  assert.ok(report.normalized.statistics.min >= 0);
  assert.ok(report.normalized.statistics.max <= 100);
});

test('score distribution flags report all-signal and CONFIRMED-only comparison with coverage and missing reasons', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-score-distribution-compare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'scores.json');
  const rows = [
    { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'AAAUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', side: 'BUY', score: 95, rsi: 70, trend: 'BULL', volume_spike: 2, ema_distance_atr: 0.3 },
    { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'BBBUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', side: 'BUY', score: 90, rsi: 62, trend: 'BULL', volume_spike: 1.5, ema_distance_atr: 0.5 },
    { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'CCCUSD', strategy: 'MOMENTUM', stage: 'SETUP', side: null, score: 76, rsi: 50, trend: 'FLAT', volume_spike: 1, ema_distance_atr: 1, details: { candlesFresh: false } },
    { captured_at: '2026-10-21T00:00:00.000Z', symbol: 'DDDUSD', strategy: 'SCALPING', stage: 'WATCH', side: null, score: 40, rsi: 45, trend: 'FLAT', volume_spike: 0.8, ema_distance_atr: 2 }
  ];
  await fs.writeFile(inputPath, JSON.stringify({ signals: rows }), 'utf8');
  const run = spawnSync(process.execPath, [scriptPath, '--days=7', '--compare', inputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.requestedDays, 7);
  assert.equal(report.compareRequested, true);
  assert.equal(report.comparison.allSignals.original.count, 4);
  assert.equal(report.comparison.confirmedOnly.rowCount, 2);
  assert.equal(report.comparison.confirmedOnly.original.count, 2);
  assert.equal(report.normalized.bands['85-100'].targetPct, 2);
  assert.equal(report.coverage.totalRows, 4);
  assert.equal(report.coverage.rowsWithNormalizedScore, 2);
  assert.equal(report.missingNormalization.byReason.missing_directional_side, 2);
  assert.equal(report.missingNormalization.byReason.insufficient_candle_history, 1);
  assert.ok(Array.isArray(report.missingNormalization.symbols));
});

test('score distribution accepts --days=7 --compare before an offline JSON path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delta-score-distribution-flags-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'scores.json');
  await fs.writeFile(inputPath, JSON.stringify({ scores: [{ score: 90 }] }), 'utf8');
  const run = spawnSync(process.execPath, [scriptPath, '--days=7', '--compare', inputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.requestedDays, 7);
  assert.equal(report.compareRequested, true);
});
