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

  await run('dedup is cold-start safe and caps history across stage/side transitions', async () => {
    const engine = new DeltaEngine();
    const now = Date.now();
    const row = { symbol: 'BTCUSD', strategy: 'MOMENTUM', score: 90, stage: 'WATCH', side: '' };

    assert.equal(engine.isDuplicateSignalObservation(row, now), false, 'first observation must not be deduplicated');
    engine.rememberSignalObservation(row, now);
    assert.equal(engine.isDuplicateSignalObservation({ ...row, score: 91 }, now + 60 * 60_000), true,
      'score changes inside the sample window must be skipped');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, stage: 'SETUP' }, now + 60 * 60_000), true,
      'stage transitions are sampled, but do not bypass the history cap');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, side: 'BUY' }, now + 60 * 60_000), true,
      'side transitions must not bypass the history cap');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, score: 92 }, now + 119 * 60_000), true,
      'observations remain capped for the full two-hour window');
    assert.equal(engine.isDuplicateSignalObservation({ ...row, stage: 'SETUP', side: 'SELL' }, now + 121 * 60_000), false,
      'the next eligible observation is persisted once the two-hour window expires');
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
          if (/DELETE FROM public\.dd_engine_logs/i.test(sql)) return { rows: [] };
          throw new Error('Unexpected SQL in env-fallback test');
        }
      });
      await engine.runSignalRetention({ daysOverride: 7, reason: 'env-fallback' });
      assert.ok(logs.some(log => /Starting 7-day dd_signals retention/.test(log.message)),
        'SUPABASE_DB_URL should enable the retention path without DATABASE_URL');
    } finally {
      if (hadSavedDatabaseUrl) process.env.DATABASE_URL = savedDatabaseUrl;
      else delete process.env.DATABASE_URL;
      if (hadSavedSupabaseDbUrl) process.env.SUPABASE_DB_URL = savedSupabaseDbUrl;
      else delete process.env.SUPABASE_DB_URL;
    }
  });

  await run('retention preserves configured age and batches dd_signals plus engine logs', async () => {
    const engine = new DeltaEngine();
    const calls = [];
    const logs = [];
    let signalBatchNumber = 0;
    let engineLogBatchNumber = 0;
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (/SELECT COUNT\(\*\)::text AS signal_rows/i.test(sql)) {
          return { rows: [{ signal_rows: '500001' }] };
        }
        if (/DELETE FROM public\.dd_signals/i.test(sql)) {
          signalBatchNumber += 1;
          return {
            rows: Array.from({ length: signalBatchNumber === 1 ? 5000 : 1 }, (_, index) => ({ id: index + 1 }))
          };
        }
        if (/DELETE FROM public\.dd_engine_logs/i.test(sql)) {
          engineLogBatchNumber += 1;
          return {
            rows: Array.from({ length: engineLogBatchNumber === 1 ? 5000 : 5 }, (_, index) => ({ id: index + 1 }))
          };
        }
        throw new Error('Unexpected SQL in retention test');
      }
    });

    const result = await engine.performSignalRetention(7, 'unit-test');
    assert.equal(result.success, true);
    assert.equal(result.effectiveDays, 7);
    assert.equal(result.totalDeleted, 5001);
    assert.equal(result.totalEngineLogsDeleted, 5005);
    const deleteCalls = calls.filter(call => /DELETE FROM/i.test(call.sql));
    const signalDeleteCalls = deleteCalls.filter(call => /DELETE FROM public\.dd_signals/i.test(call.sql));
    const logDeleteCalls = deleteCalls.filter(call => /DELETE FROM public\.dd_engine_logs/i.test(call.sql));
    assert.equal(signalDeleteCalls.length, 2, '5001 signal rows must be deleted in two bounded batches');
    assert.equal(logDeleteCalls.length, 2, '5005 engine log rows must be deleted in two bounded batches');
    for (const call of deleteCalls) assert.deepEqual(call.params, [7, 5000]);
    assert.ok(logDeleteCalls.every(call => /created_at < NOW\(\)/i.test(call.sql)));
    assert.ok(deleteCalls.every(call => !/dd_trades|dd_positions|dd_orders|dd_tradetron_events|position_ledger|webhook_events|system_meta/i.test(call.sql)));
    assert.ok(logs.some(log => /Critical row-count threshold exceeded/.test(log.message)));
    assert.ok(logs.some(log => /\[Retention\] Deleted 5000 rows/.test(log.message)));
    assert.ok(logs.some(log => /\[Retention\] Deleted 5000 engine log rows/.test(log.message)));
  });

  await run('disk monitor pauses signal history at high size and preserves configured retention at critical count', async () => {
    const engine = new DeltaEngine();
    const logs = [];
    let retentionRequest = null;
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async sql => {
        assert.match(sql, /pg_database_size\(current_database\(\)\)/i);
        assert.match(sql, /COUNT\(\*\) FILTER/i);
        assert.match(sql, /INTERVAL '1 day'/i);
        assert.match(sql, /FROM public\.dd_signals/i);
        return { rows: [{ db_bytes: String(436 * MB), signal_rows: '510000', expired_rows: '60000' }] };
      }
    });
    engine.runSignalRetention = async options => { retentionRequest = options; };

    await engine.checkDiskHealth();
    const diskSummary = logs.find(log => log.message.startsWith('[Disk] DB:'));
    assert.equal(diskSummary?.data?.pauseAtMb, 370);
    assert.equal(diskSummary?.data?.resumeAtMb, 350);
    assert.ok(logs.some(log => /\[Disk\] DB: 436\.0 MB, signals: 510000 rows, expired_1d: 60000/.test(log.message)));
    assert.ok(logs.some(log => /pausing new dd_signals history writes/.test(log.message)));
    assert.equal(engine.signalHistoryWritesPaused, true);
    assert.ok(logs.some(log => /WARNING: signal row count 510000 exceeds 250000/.test(log.message)));
    assert.ok(logs.some(log => /CRITICAL: signal row count 510000 exceeds 500000; requesting configured 1-day retention/.test(log.message)));
    assert.deepEqual(retentionRequest, { reason: 'row-count-critical' });
  });

  await run('signal-history writes pause before the 400 MiB operational target', async () => {
    assert.ok(engineSource.includes("envInteger('SIGNAL_HISTORY_PAUSE_DB_MB', 370, 300, 380)"));
    const engine = new DeltaEngine();
    const logs = [];
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async () => ({
        rows: [{ db_bytes: String(390 * MB), signal_rows: '8000', expired_rows: '0' }]
      })
    });

    await engine.checkDiskHealth();
    assert.equal(engine.signalHistoryWritesPaused, true,
      'history writes must pause while database size remains below 400 MiB but exceeds the configured guard');
    const pauseLog = logs.find(log => /pausing new dd_signals history writes/.test(log.message));
    assert.ok(pauseLog, 'disk monitor should log the protective pause');
    assert.equal(pauseLog.data.pauseAtMb, 370);
  });

  await run('expired retention-window backlog triggers configured retention below the critical row count', async () => {
    const engine = new DeltaEngine();
    const logs = [];
    let retentionRequest = null;
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async () => ({
        rows: [{ db_bytes: String(390 * MB), signal_rows: '300000', expired_rows: '50001' }]
      })
    });
    engine.runSignalRetention = async options => { retentionRequest = options; };

    await engine.checkDiskHealth();
    assert.ok(logs.some(log => /older than configured 1-day window exceeds 50000; requesting configured retention/.test(log.message)));
    assert.deepEqual(retentionRequest, { reason: 'retention-window-backlog' });
  });

  await run('disk monitor resumes history writes only after the database recovers below the hysteresis threshold', async () => {
    const engine = new DeltaEngine();
    const logs = [];
    let dbBytes = 440 * MB;
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async () => ({
        rows: [{ db_bytes: String(dbBytes), signal_rows: '300000', expired_rows: '0' }]
      })
    });
    engine.runSignalRetention = async () => {};

    await engine.checkDiskHealth();
    assert.equal(engine.signalHistoryWritesPaused, true, 'high database size must pause history writes');

    dbBytes = 345 * MB;
    await engine.checkDiskHealth();
    assert.equal(engine.signalHistoryWritesPaused, false, 'history writes resume after the database falls below the recovery threshold');
    assert.ok(logs.some(log => /resuming dd_signals history writes/.test(log.message)));
  });

  await run('retention defaults to 1 day and logs durable health summaries', async () => {
    assert.match(engineSource, /envInteger\('RETENTION_DAYS', 1, 1, 3650\)/);
    const engine = new DeltaEngine();
    const logs = [];
    engine.maintenanceLog = async (level, message, data = {}) => logs.push({ level, message, data });
    engine.getMaintenancePool = async () => ({
      query: async sql => {
        if (/SELECT COUNT\(\*\)::text AS signal_rows/i.test(sql)) return { rows: [{ signal_rows: '100' }] };
        if (/WITH batch AS/i.test(sql) && /DELETE FROM public\.dd_signals/i.test(sql)) return { rows: [] };
        if (/DELETE FROM public\.dd_engine_logs/i.test(sql)) return { rows: [] };
        throw new Error('Unexpected SQL in retention health summary test');
      }
    });

    await engine.runSignalRetention({ daysOverride: 1, reason: 'health-summary-test' });
    const summary = logs.find(log => log.message === '[Retention] Run summary');
    assert.ok(summary, 'retention run summary must be durably logged');
    assert.equal(summary.data.status, 'SUCCESS');
    assert.equal(summary.data.effectiveDays, 1);
    assert.equal(summary.data.rowsDeleted, 0);
    assert.equal(summary.data.engineLogRowsDeleted, 0);
    assert.equal(summary.data.reason, 'health-summary-test');
    assert.ok(Number.isSafeInteger(summary.data.configDays) && summary.data.configDays >= 1);
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
