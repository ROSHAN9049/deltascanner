#!/usr/bin/env node
/**
 * Carefully prune historical dd_signals rows in committed batches.
 *
 * DRY RUN is the default. Deletion requires an explicit --confirm flag.
 * The DELETE and VACUUM targets are hard-coded and guarded at runtime.
 */
import pg from 'pg';

const { Pool } = pg;
const TARGET_TABLE = 'dd_signals';
const TARGET_RELATION = 'public.dd_signals';
const DEFAULT_DAYS = 3;
const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 50000;
const SLEEP_MS = 100;

function parseArgs(argv) {
  const options = { days: DEFAULT_DAYS, batchSize: DEFAULT_BATCH_SIZE, confirm: false };
  for (const arg of argv) {
    if (arg === '--confirm') {
      options.confirm = true;
      continue;
    }
    const match = arg.match(/^--(days|batch-size)=(.*)$/);
    if (!match) throw new Error('Unsupported argument. Use --days=N, --batch-size=N, and optional --confirm.');
    const key = match[1];
    const value = match[2];
    if (!/^\d+$/.test(value)) throw new Error('--' + key + ' must be a positive whole number.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('--' + key + ' is outside the safe integer range.');
    if (key === 'days') options.days = parsed;
    if (key === 'batch-size') options.batchSize = parsed;
  }
  if (!Number.isInteger(options.days) || options.days < 1) {
    throw new Error('Refusing to run: --days must be at least 1.');
  }
  if (options.days > 3650) throw new Error('Refusing to run: --days cannot exceed 3650.');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > MAX_BATCH_SIZE) {
    throw new Error('--batch-size must be between 1 and ' + MAX_BATCH_SIZE + '.');
  }
  return options;
}

function toCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Database returned an invalid count.');
  return parsed;
}
function toBytes(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function safeError(error) {
  return String(error?.message || 'Database operation failed')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 800);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function assertExpectedTable() {
  if (TARGET_TABLE !== 'dd_signals' || TARGET_RELATION !== 'public.dd_signals') {
    throw new Error('SAFETY ABORT: prune target must be exactly public.dd_signals.');
  }
}
function assertOnlySignalDelete(sql) {
  assertExpectedTable();
  const deleteTargets = [...sql.matchAll(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_.]*)/gi)]
    .map(match => match[1].toLowerCase());
  if (deleteTargets.length !== 1 || deleteTargets[0] !== TARGET_RELATION) {
    throw new Error('SAFETY ABORT: attempted DELETE target is not exactly public.dd_signals.');
  }
  const referencedRelations = [...sql.matchAll(/\b(?:FROM|JOIN|USING)\s+([a-z_][a-z0-9_.]*)/gi)]
    .map(match => match[1].toLowerCase())
    .filter(name => name !== 'batch');
  if (referencedRelations.some(name => name !== TARGET_RELATION)) {
    throw new Error('SAFETY ABORT: prune statement references a table other than public.dd_signals.');
  }
  if ((sql.match(/\bpublic\.dd_signals\b/gi) || []).length !== 2) {
    throw new Error('SAFETY ABORT: prune statement differs from the two-allowed-reference guard.');
  }
}
function assertOnlySignalVacuum(sql) {
  assertExpectedTable();
  if (!/^\s*VACUUM\s*\(\s*ANALYZE\s*\)\s+public\.dd_signals\s*;?\s*$/i.test(sql)) {
    throw new Error('SAFETY ABORT: VACUUM target must be exactly public.dd_signals.');
  }
}
async function safeQuery(pool, sql, params) {
  const statement = String(sql);
  if (/^\s*VACUUM\b/i.test(statement)) {
    assertOnlySignalVacuum(statement);
    return pool.query(statement, params);
  }
  if (/\bDELETE\b/i.test(statement)) {
    assertOnlySignalDelete(statement);
    return pool.query(statement, params);
  }
  if (/^\s*(SELECT|WITH)\b/i.test(statement) &&
      !/\b(INSERT|UPDATE|TRUNCATE|CREATE|ALTER|DROP|VACUUM)\b/i.test(statement)) {
    return pool.query(statement, params);
  }
  throw new Error('SAFETY ABORT: only SELECT queries, the guarded dd_signals DELETE, and the guarded dd_signals VACUUM are permitted.');
}
async function assertSignalTableExists(pool) {
  assertExpectedTable();
  const result = await safeQuery(pool,
    "SELECT table_schema, table_name, table_type " +
    "FROM information_schema.tables " +
    "WHERE table_schema = 'public' AND table_name = $1",
    [TARGET_TABLE]
  );
  if (result.rows.length !== 1 ||
      result.rows[0].table_schema !== 'public' ||
      result.rows[0].table_name !== 'dd_signals' ||
      result.rows[0].table_type !== 'BASE TABLE') {
    throw new Error('SAFETY ABORT: public.dd_signals is not verified as exactly one base table.');
  }
}
async function getDiagnostics(pool, days) {
  const result = await safeQuery(pool,
    "SELECT " +
    "COUNT(*)::text AS total_rows, " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - ($1::int * INTERVAL '1 day'))::text AS old_rows, " +
    "pg_database_size(current_database())::text AS database_bytes, " +
    "pg_size_pretty(pg_database_size(current_database())) AS database_size, " +
    "pg_total_relation_size('public.dd_signals'::regclass)::text AS table_bytes, " +
    "pg_size_pretty(pg_total_relation_size('public.dd_signals'::regclass)) AS table_size, " +
    "MIN(captured_at) AS oldest_captured_at, MAX(captured_at) AS newest_captured_at " +
    "FROM public.dd_signals",
    [days]
  );
  const row = result.rows[0] || {};
  const totalRows = toCount(row.total_rows);
  const oldRows = toCount(row.old_rows);
  return {
    capturedAt: new Date().toISOString(),
    databaseBytes: toBytes(row.database_bytes),
    databaseSize: row.database_size ?? 'UNKNOWN',
    ddSignalsTableBytes: toBytes(row.table_bytes),
    ddSignalsTableSize: row.table_size ?? 'UNKNOWN',
    totalRows,
    rowsOlderThanDays: oldRows,
    rowsToKeep: totalRows - oldRows,
    oldestCapturedAt: row.oldest_captured_at instanceof Date
      ? row.oldest_captured_at.toISOString() : row.oldest_captured_at ?? null,
    newestCapturedAt: row.newest_captured_at instanceof Date
      ? row.newest_captured_at.toISOString() : row.newest_captured_at ?? null,
    thresholdDays: days
  };
}
function printDiagnostics(label, data) {
  console.log('=== ' + label + ' ===');
  console.log('Database size: ' + data.databaseSize + ' (' + data.databaseBytes + ' bytes)');
  console.log('dd_signals total rows: ' + data.totalRows);
  console.log('dd_signals table + indexes: ' + data.ddSignalsTableSize + ' (' + data.ddSignalsTableBytes + ' bytes)');
  console.log('Rows older than ' + data.thresholdDays + ' days: ' + data.rowsOlderThanDays);
  console.log('Rows to keep: ' + data.rowsToKeep);
  console.log('Oldest captured_at: ' + (data.oldestCapturedAt || 'N/A'));
  console.log('Newest captured_at: ' + (data.newestCapturedAt || 'N/A'));
  console.log('');
}

const DELETE_BATCH_SQL =
  'WITH batch AS (' +
  ' SELECT id FROM public.dd_signals' +
  " WHERE captured_at < NOW() - ($1::int * INTERVAL '1 day')" +
  ' ORDER BY captured_at ASC, id ASC' +
  ' LIMIT $2::int' +
  ')' +
  ' DELETE FROM public.dd_signals AS target USING batch' +
  ' WHERE target.id = batch.id RETURNING target.id';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    throw new Error('DATABASE_URL is required; its value will not be printed.');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });
  const startedAt = Date.now();
  let initial;
  let totalDeleted = 0;
  let vacuumStatus = 'NOT_RUN';
  let operationalError = null;
  let final = null;
  try {
    await assertSignalTableExists(pool);
    initial = await getDiagnostics(pool, options.days);
    printDiagnostics('INITIAL DIAGNOSTICS', initial);
    console.log('Mode: ' + (options.confirm ? 'CONFIRMED DELETE' : 'DRY RUN'));
    console.log('Target table: ' + TARGET_RELATION);
    console.log('Batch size: ' + options.batchSize);
    console.log('');

    if (!options.confirm) {
      console.log('DRY RUN. Would delete ' + initial.rowsOlderThanDays + ' rows. Add --confirm to proceed.');
      console.log('No rows were deleted. No VACUUM was run.');
      return;
    }

    assertOnlySignalDelete(DELETE_BATCH_SQL);
    let batchNumber = 0;
    try {
      while (true) {
        const result = await safeQuery(pool, DELETE_BATCH_SQL, [options.days, options.batchSize]);
        const deleted = result.rows.length;
        batchNumber += 1;
        totalDeleted += deleted;
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        console.log('[batch ' + batchNumber + '] Deleted ' + deleted +
          ' rows (total: ' + totalDeleted + ', elapsed: ' + elapsedSeconds.toFixed(1) + 's)');
        if (deleted === 0) break;
        await sleep(SLEEP_MS);
      }
      console.log('Batched delete complete. Total deleted: ' + totalDeleted);
    } catch (error) {
      operationalError = 'Deletion stopped after ' + totalDeleted + ' row(s): ' + safeError(error);
      console.error('ERROR: ' + operationalError);
    }

    if (totalDeleted > 0) {
      const vacuumSql = 'VACUUM (ANALYZE) public.dd_signals';
      try {
        assertOnlySignalVacuum(vacuumSql);
        // pool.query sends this as a standalone command, not inside BEGIN/COMMIT.
        await safeQuery(pool, vacuumSql);
        vacuumStatus = 'SUCCESS';
        console.log('VACUUM ANALYZE public.dd_signals: SUCCESS');
        console.log('Note: standard VACUUM generally makes freed space reusable; it may not reduce pg_database_size.');
      } catch (error) {
        vacuumStatus = 'FAILED';
        operationalError = [operationalError, 'VACUUM ANALYZE failed: ' + safeError(error)].filter(Boolean).join(' | ');
        console.error('ERROR: VACUUM ANALYZE failed: ' + safeError(error));
      }
    } else {
      vacuumStatus = 'SKIPPED_NO_ROWS_DELETED';
      console.log('VACUUM ANALYZE skipped because no rows were deleted.');
    }

    try {
      final = await getDiagnostics(pool, options.days);
      printDiagnostics('FINAL DIAGNOSTICS', final);
      const dbDelta = initial.databaseBytes !== null && final.databaseBytes !== null
        ? initial.databaseBytes - final.databaseBytes : null;
      console.log('TOTAL DELETED: ' + totalDeleted);
      console.log('Database size change (before minus after): ' +
        (dbDelta === null ? 'UNKNOWN' : dbDelta + ' bytes') +
        ' (' + initial.databaseSize + ' -> ' + final.databaseSize + ')');
      console.log('Row count change: ' + initial.totalRows + ' -> ' + final.totalRows);
      console.log('Elapsed: ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' seconds');
      console.log('VACUUM status: ' + vacuumStatus);
      console.log('');
      console.log('JSON SUMMARY');
      console.log(JSON.stringify({
        targetTable: TARGET_RELATION,
        confirmed: options.confirm,
        days: options.days,
        batchSize: options.batchSize,
        initial,
        final,
        totalDeleted,
        vacuumStatus,
        databaseBytesFreed: dbDelta,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        operationalError
      }, null, 2));
    } catch (error) {
      operationalError = [operationalError, 'Final diagnostics failed: ' + safeError(error)].filter(Boolean).join(' | ');
      console.error('ERROR: final diagnostics failed: ' + safeError(error));
    }

    if (operationalError || vacuumStatus === 'FAILED') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Prune failed: ' + (error?.message === 'DATABASE_URL is required; its value will not be printed.'
    ? error.message : safeError(error)));
  process.exitCode = 1;
});
