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
