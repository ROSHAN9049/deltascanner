import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DeltaEngine } from '../worker/engine.mjs';

const MB = 1024 * 1024;
const originalDatabaseUrl = process.env.DATABASE_URL;
const hadDatabaseUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
const originalSupabaseDbUrl = process.env.SUPABASE_DB_URL;
const hadSupabaseDbUrl = Object.prototype.hasOwnProperty.call(process.env, 'SUPABASE_DB_URL');
process.env.DATABASE_URL = 'postgres://retention-test:secret@127.0.0.1/test';

const engineSource = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');

async function run(name, callback) {
  await callback();
  console.log('[RetentionTest] PASS ' + name);
}

try {
  await run('stage history includes WATCH rows for deduplication', async () => {
    assert.doesNotMatch(
      engineSource,
      /if\s*\(\s*s\.stage\s*!==\s*['"]WATCH['"]\s*\|\|\s*cacheRow\.ready\s*\)/,
      'WATCH rows must reach the deduplicator so stage transitions can be recorded'
    );
    assert.match(engineSource, /Persist every stage observation to the history candidate batch/);
  });

  await run('dedup is cold-start safe and preserves stage/side changes', async () => {
    const engine = new DeltaEngine();
    const now = Date.now();
    const row = { symbol: 'BTCUSD', strategy: 'MOMENTUM', score: 90, stage: 'WATCH', side: '' };

    assert.equal(engine.isDuplicateSignalObservation(row, now), false, 'first observation must not be deduplicated');
    engine.rememberSignalObservation(row, now);
    assert.equal(engine.isDuplicateSignalObservation({ ...row, score: 91 }, now + 60_000), true,
      'same score within ±1 and within the configured window should be skipped');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, stage: 'SETUP' }, now + 60_000), false,
      'stage transition must be recorded');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, side: 'BUY' }, now + 60_000), false,
      'side transition must be recorded');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, score: 92 }, now + 60_000), false,
      'score change greater than one must be recorded');
    assert.equal(engine.isDuplicateSignalObservation(row, now + 6 * 60_000), false,
      'observation after the window must be recorded');
  });

  await run('retention accepts SUPABASE_DB_URL when DATABASE_URL is absent', async () => {
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const hadSavedDatabaseUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
    const savedSupabaseDbUrl = process.env.SUPABASE_DB_URL;
    const hadSavedSupabaseDbUrl = Object.prototype.hasOwnProperty.call(process.env, 'SUPABASE_DB_URL');
    try {
      delete process.env.DATABASE_URL;
      process.env.SUPABASE_DB_URL = 'postgres://retention-test:secret@127.0.0.1/test';
      const engine = new DeltaEngine();
      const logs = [];
      engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
      engine.getMaintenancePool = async () => ({
        query: async sql => {
          if (/SELECT COUNT\(\*\)::text AS signal_rows/i.test(sql)) {
            return { rows: [{ signal_rows: '0' }] };
          }
          if (/WITH batch AS/i.test(sql) && /DELETE FROM public\.dd_signals/i.test(sql)) {
            return { rows: [] };
          }
          throw new Error('Unexpected SQL in env-fallback test');
        }
      });
      await engine.runSignalRetention({ daysOverride: 1, reason: 'env-fallback' });
      assert.ok(logs.some(log => /Starting 1-day dd_signals retention/.test(log.message)),
        'SUPABASE_DB_URL should enable the retention path without DATABASE_URL');
    } finally {
      if (hadSavedDatabaseUrl) process.env.DATABASE_URL = savedDatabaseUrl;
      else delete process.env.DATABASE_URL;
      if (hadSavedSupabaseDbUrl) process.env.SUPABASE_DB_URL = savedSupabaseDbUrl;
      else delete process.env.SUPABASE_DB_URL;
    }
  });

  await run('retention forces 3-day mode above 500,000 rows and batches dd_signals only', async () => {
    const engine = new DeltaEngine();
    const calls = [];
    const logs = [];
    let batchNumber = 0;
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (/SELECT COUNT\(\*\)::text AS signal_rows/i.test(sql)) {
          return { rows: [{ signal_rows: '500001' }] };
        }
        if (/WITH batch AS/i.test(sql) && /DELETE FROM public\.dd_signals/i.test(sql)) {
          batchNumber += 1;
          return {
            rows: Array.from({ length: batchNumber === 1 ? 5000 : 1 }, (_, index) => ({ id: index + 1 }))
          };
        }
        throw new Error('Unexpected SQL in retention test');
      }
    });

    const result = await engine.performSignalRetention(7, 'unit-test');
    assert.equal(result.effectiveDays, 3);
    assert.equal(result.totalDeleted, 5001);
    const deleteCalls = calls.filter(call => /DELETE FROM/i.test(call.sql));
    assert.equal(deleteCalls.length, 2, '5001 rows must be deleted in two bounded batches');
    for (const call of deleteCalls) {
      assert.deepEqual(call.params, [3, 5000]);
      assert.match(call.sql, /DELETE FROM public\.dd_signals/i);
      assert.doesNotMatch(call.sql, /dd_trades|dd_positions|dd_orders|dd_tradetron_events|position_ledger|webhook_events|system_meta/i);
    }
    assert.ok(logs.some(log => /Emergency row-count threshold exceeded/.test(log.message)));
    assert.ok(logs.some(log => /\[Retention\] Deleted 5000 rows/.test(log.message)));
  });

  await run('disk monitor records growth rate and requests 3-day retention at critical size', async () => {
    const engine = new DeltaEngine();
    const logs = [];
    let retentionRequest = null;
    const now = Date.now();
    engine.diskSamples = [{ at: now - 24 * 60 * 60 * 1000, bytes: 100 * MB, rows: 1000 }];
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async sql => {
        assert.match(sql, /pg_database_size\(current_database\(\)\)/i);
        assert.match(sql, /FROM public\.dd_signals/i);
        return { rows: [{ db_bytes: String(460 * MB), signal_rows: '510000' }] };
      }
    });
    engine.runSignalRetention = async options => { retentionRequest = options; };

    await engine.checkDiskHealth();
    assert.ok(logs.some(log => /\[Disk\] dd_signals: 510000 rows, db: 460\.0 MB/.test(log.message)));
    assert.ok(logs.some(log => /Disk growth rate high/.test(log.message)));
    assert.deepEqual(retentionRequest, { daysOverride: 3, reason: 'disk-critical' });
  });

  await run('dedup summary cadence is every 1,000 analysis cycles', async () => {
    assert.match(engineSource, /dedupAnalysisCycles % 1000 !== 0/);
    const engine = new DeltaEngine();
    const messages = [];
    engine.log = async (level, message, data) => messages.push({ level, message, data });
    engine.dedupAnalysisCycles = 999;
    engine.dedupTotalCandidates = 1000;
    engine.dedupSkippedCount = 700;
    engine.dedupInsertedCount = 300;
    await engine.logDedupStatsIfDue();
    assert.equal(messages.length, 0, 'must not log before cycle 1,000');
    engine.dedupAnalysisCycles = 1000;
    await engine.logDedupStatsIfDue();
    assert.equal(messages.length, 1, 'must log at cycle 1,000');
    assert.equal(messages[0].data.reductionPct, 70);
  });

  console.log('[RetentionTest] All maintenance safeguards passed.');
} finally {
  if (hadDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
  else delete process.env.DATABASE_URL;
  if (hadSupabaseDbUrl) process.env.SUPABASE_DB_URL = originalSupabaseDbUrl;
  else delete process.env.SUPABASE_DB_URL;
}
