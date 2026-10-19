#!/usr/bin/env node
/**
 * Guarded emergency retention for public.dd_signals.
 *
 * Dry-run is the default. Deletion requires --confirm. Deletion above 700,000
 * rows additionally requires --force. No other table is mutated.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const TARGET_RELATION = 'public.dd_signals';
const DEFAULT_DAYS = 2;
const BATCH_SIZE = 5000;
const BATCH_PAUSE_MS = 100;
const MIN_ROWS_TO_DELETE = 100_000;
const MAX_ROWS_WITHOUT_FORCE = 700_000;
const MIB = 1024 * 1024;

function parseArgs(argv) {
  const options = { days: DEFAULT_DAYS, confirm: false, force: false };
  for (const arg of argv) {
    if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--force') {
      options.force = true;
    } else {
      const match = arg.match(/^--days=(\d+)$/);
      if (!match) {
        throw new Error('Unsupported argument. Use --days=N and optional --confirm and --force.');
      }
      options.days = Number(match[1]);
    }
  }

  if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 3650) {
    throw new Error('--days must be a whole number between 1 and 3650.');
  }
  return options;
}

function toCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Database returned an invalid ' + label + '.');
  }
  return parsed;
}

function toBytes(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Database returned an invalid ' + label + '.');
  }
  return parsed;
}

function formatMiB(bytes) {
  return (bytes / MIB).toFixed(2) + ' MiB';
}

function safeError(error) {
  return String(error?.message || 'Database operation failed')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 800);
}

async function getState(pool, days) {
  const result = await pool.query(
    'SELECT ' +
    'pg_database_size(current_database())::text AS db_size_bytes, ' +
    'pg_total_relation_size(\'public.dd_signals\'::regclass)::text AS table_size_bytes, ' +
    'COUNT(*)::text AS total_rows, ' +
    'COUNT(*) FILTER (WHERE captured_at < NOW() - ($1::int * INTERVAL \'1 day\'))::text AS rows_to_delete ' +
    'FROM public.dd_signals',
    [days]
  );
  const row = result.rows[0] || {};
  const totalRows = toCount(row.total_rows, 'total row count');
  const rowsToDelete = toCount(row.rows_to_delete, 'eligible row count');
  if (rowsToDelete > totalRows) {
    throw new Error('Safety abort: eligible row count exceeds total row count.');
  }
  return {
    databaseBytes: toBytes(row.db_size_bytes, 'database size'),
    tableBytes: toBytes(row.table_size_bytes, 'dd_signals table size'),
    totalRows,
    rowsToDelete,
    rowsToKeep: totalRows - rowsToDelete,
    days
  };
}

function printBefore(state) {
  console.log('[EMERGENCY PRUNE] Before:');
  console.log('- DB size: ' + formatMiB(state.databaseBytes));
  console.log('- dd_signals table + indexes: ' + formatMiB(state.tableBytes));
  console.log('- Total rows: ' + state.totalRows.toLocaleString('en-US'));
  console.log('- Rows to delete: ' + state.rowsToDelete.toLocaleString('en-US'));
  console.log('- Rows to keep: ' + state.rowsToKeep.toLocaleString('en-US'));
  console.log('- Cutoff: older than ' + state.days + ' day(s)');
}

function printAfter(initial, final, deleted, vacuumStatus, startedAt, errors) {
  const reportedDbChangeBytes = initial.databaseBytes - final.databaseBytes;
  const estimatedLogicalBytes = initial.totalRows > 0
    ? Math.round(initial.tableBytes * Math.min(deleted, initial.totalRows) / initial.totalRows)
    : 0;

  console.log('');
  console.log('[EMERGENCY PRUNE] Complete:');
  console.log('- Rows deleted: ' + deleted.toLocaleString('en-US'));
  console.log('- DB size before: ' + formatMiB(initial.databaseBytes));
  console.log('- DB size after: ' + formatMiB(final.databaseBytes));
  console.log('- Reported DB size change (before minus after): ' +
    formatMiB(Math.abs(reportedDbChangeBytes)) +
    (reportedDbChangeBytes >= 0 ? ' lower' : ' higher'));
  console.log('- Estimated logical table footprint represented by deleted rows: ' +
    formatMiB(estimatedLogicalBytes) + ' (proportional estimate, not measured disk reclamation)');
  console.log('- Remaining rows: ' + final.totalRows.toLocaleString('en-US'));
  console.log('- VACUUM ANALYZE: ' + vacuumStatus);
  console.log('- Elapsed: ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' seconds');
  console.log('- NOTE: Actual disk space may not immediately free due to PostgreSQL VACUUM behavior.');
  if (errors.length) {
    console.error('- Errors: ' + errors.join(' | '));
    process.exitCode = 1;
  }

  console.log('JSON SUMMARY');
  console.log(JSON.stringify({
    target: TARGET_RELATION,
    days: initial.days,
    batchSize: BATCH_SIZE,
    rowsDeleted: deleted,
    before: initial,
    after: final,
    reportedDbChangeBytes,
    estimatedLogicalBytes,
    vacuumStatus,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    errors
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    throw new Error('DATABASE_URL is required; its value will not be printed.');
  }

  // Dynamic import ensures the missing-DATABASE_URL guard runs before the
  // adapter is evaluated and attempts to construct its PostgreSQL pool.
  const { pool, closePool } = await import('../src/ledger/pg-adapter.mjs');
  const startedAt = Date.now();
  const errors = [];
  let initial;
  let final;
  let totalDeleted = 0;
  let vacuumStatus = 'NOT_RUN';

  try {
    initial = await getState(pool, options.days);
    printBefore(initial);
    console.log('- Mode: ' + (options.confirm ? 'CONFIRMED DELETE' : 'DRY RUN'));
    console.log('- Batch size: ' + BATCH_SIZE);
    console.log('');

    if (initial.rowsToDelete < MIN_ROWS_TO_DELETE) {
      console.log('[EMERGENCY PRUNE] Prune would delete only ' +
        initial.rowsToDelete.toLocaleString('en-US') +
        ' rows. Aborting (too little benefit). No rows were modified.');
      return;
    }

    if (initial.rowsToDelete > MAX_ROWS_WITHOUT_FORCE && !options.force) {
      console.error('[EMERGENCY PRUNE] Prune would delete ' +
        initial.rowsToDelete.toLocaleString('en-US') + ' rows (too aggressive). Aborting.');
      console.error('[EMERGENCY PRUNE] Review before running. Use --force to override.');
      process.exitCode = 1;
      return;
    }

    if (!options.confirm) {
      console.log('[EMERGENCY PRUNE] Dry run only. Add --confirm to delete eligible rows.');
      console.log('[EMERGENCY PRUNE] No rows were deleted and VACUUM was not run.');
      return;
    }

    console.log('[EMERGENCY PRUNE] Starting batched delete from ' + TARGET_RELATION + '...');
    try {
      while (true) {
        const result = await pool.query(
          'DELETE FROM public.dd_signals ' +
          'WHERE id IN (' +
          ' SELECT id FROM public.dd_signals ' +
          ' WHERE captured_at < NOW() - ($1::int * INTERVAL \'1 day\') ' +
          ' ORDER BY captured_at ASC, id ASC ' +
          ' LIMIT $2::int' +
          ') RETURNING id',
          [options.days, BATCH_SIZE]
        );
        const batchDeleted = Number.isSafeInteger(result.rowCount)
          ? result.rowCount
          : result.rows.length;
        totalDeleted += batchDeleted;

        if (totalDeleted > 0 && totalDeleted % 50_000 === 0) {
          console.log('[EMERGENCY PRUNE] Deleted ' +
            totalDeleted.toLocaleString('en-US') + ' rows...');
        }
        if (batchDeleted === 0) break;
        await sleep(BATCH_PAUSE_MS);
      }
      console.log('[EMERGENCY PRUNE] Batched DELETE finished. Total deleted: ' +
        totalDeleted.toLocaleString('en-US'));
    } catch (error) {
      const message = 'DELETE stopped after ' + totalDeleted.toLocaleString('en-US') +
        ' rows: ' + safeError(error);
      errors.push(message);
      console.error('[EMERGENCY PRUNE] ' + message);
    }

    if (totalDeleted > 0) {
      try {
        // A pool.query statement is sent standalone; VACUUM cannot run inside a transaction.
        await pool.query('VACUUM ANALYZE public.dd_signals');
        vacuumStatus = 'SUCCESS';
        console.log('[EMERGENCY PRUNE] VACUUM ANALYZE public.dd_signals succeeded.');
      } catch (error) {
        vacuumStatus = 'FAILED';
        const message = 'VACUUM ANALYZE failed: ' + safeError(error);
        errors.push(message);
        console.error('[EMERGENCY PRUNE] ' + message);
      }
    } else {
      vacuumStatus = 'SKIPPED_NO_ROWS_DELETED';
      console.log('[EMERGENCY PRUNE] VACUUM skipped because no rows were deleted.');
    }

    try {
      final = await getState(pool, options.days);
      printAfter(initial, final, totalDeleted, vacuumStatus, startedAt, errors);
    } catch (error) {
      errors.push('Final diagnostics failed: ' + safeError(error));
      console.error('[EMERGENCY PRUNE] ' + errors[errors.length - 1]);
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

main().catch(error => {
  console.error('[EMERGENCY PRUNE] Failed: ' + safeError(error));
  process.exitCode = 1;
});
