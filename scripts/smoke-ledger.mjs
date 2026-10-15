// Manual, read-only integration smoke test. Run via: npm run smoke:ledger
// This script never runs automatically, never changes database rows, and
// prints counts only (not position rows, credentials, or snapshot contents).

const readiness = {
  databaseUrl: false,
  databaseConnected: false,
  tablesExist: false,
  positionLedgerRows: null,
  webhookEventRows: null,
  systemMetaRows: null,
  positionLedgerFunctional: false,
  snapshotOk: false,
  snapshotCount: null,
  reconciliationOk: false,
  isSynced: null,
  poolClosed: false
};

let pool;
let closePool;
let db;
let positionLedger;
let snapshotAdapter;
let overallFailed = false;

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function sanitizedFailure(label) {
  overallFailed = true;
  console.error(label + '; error details suppressed.');
}

async function run() {
  console.log('[1/6] Checking DATABASE_URL...');
  readiness.databaseUrl = Boolean(process.env.DATABASE_URL);
  if (!readiness.databaseUrl) {
    sanitizedFailure('DATABASE_URL is not set. Refusing to connect');
  } else {
    console.log('DATABASE_URL configured: yes (value hidden)');
  }

  if (readiness.databaseUrl) {
    try {
      console.log('[2/6] Connecting to database...');
      ({ pool, db, closePool } = await import('../src/ledger/pg-adapter.mjs'));
      await pool.query('SELECT 1');
      readiness.databaseConnected = true;
      console.log('Database connection: OK');

      console.log('[3/6] Checking migration tables...');
      const tablesResult = await pool.query(`
        SELECT
          to_regclass('public.position_ledger') AS t1,
          to_regclass('public.webhook_events') AS t2,
          to_regclass('public.system_meta') AS t3
      `);
      const tableRow = tablesResult.rows[0] || {};
      readiness.tablesExist = Boolean(tableRow.t1 && tableRow.t2 && tableRow.t3);
      if (readiness.tablesExist) {
        console.log('All three required tables exist.');
      } else {
        sanitizedFailure('Migration 001_position_ledger.sql has not been fully applied');
        console.error('Run npm run db:migrate only after reviewing the database state.');
      }

      if (readiness.tablesExist) {
        console.log('[4/6] Reading all ledger table counts...');
        const [positions, events, metadata] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS count FROM position_ledger'),
          pool.query('SELECT COUNT(*)::int AS count FROM webhook_events'),
          pool.query('SELECT COUNT(*)::int AS count FROM system_meta')
        ]);
        readiness.positionLedgerRows = safeCount(positions.rows[0]?.count);
        readiness.webhookEventRows = safeCount(events.rows[0]?.count);
        readiness.systemMetaRows = safeCount(metadata.rows[0]?.count);
        if ([readiness.positionLedgerRows, readiness.webhookEventRows, readiness.systemMetaRows]
          .every(value => value !== null)) {
          console.log('position_ledger rows:', readiness.positionLedgerRows);
          console.log('webhook_events rows:', readiness.webhookEventRows);
          console.log('system_meta rows:', readiness.systemMetaRows);
        } else {
          sanitizedFailure('One or more ledger table counts were invalid');
        }

        console.log('[5/6] Checking PositionLedger...');
        const { PositionLedger } = await import('../src/ledger/index.mjs');
        positionLedger = new PositionLedger(db, {
          logger: { info() {}, warn() {}, error() {} }
        });
        const globalCount = await positionLedger.getGlobalCount();
        readiness.positionLedgerFunctional =
          typeof globalCount === 'number' && Number.isFinite(globalCount) && globalCount >= 0;
        if (!readiness.positionLedgerFunctional) {
          sanitizedFailure('PositionLedger.getGlobalCount() did not return a finite non-negative number');
        } else {
          console.log('PositionLedger.getGlobalCount():', globalCount);
        }
      } else {
        overallFailed = true;
      }
    } catch {
      sanitizedFailure('Database readiness check failed');
    }
  }

  console.log('[6/6] Checking read-only Tradetron snapshot and reconciliation...');
  try {
    const adapterModule = await import('../src/adapters/tradetron-snapshot-adapter.mjs');
    snapshotAdapter = adapterModule.tradetronAPI;
    const snapshot = await snapshotAdapter.getSnapshot();
    if (!Array.isArray(snapshot)) {
      throw new TypeError('Snapshot was not an array');
    }

    readiness.snapshotOk = true;
    readiness.snapshotCount = snapshot.length;
    console.log('Normalized Tradetron snapshot item count:', readiness.snapshotCount);

    if (positionLedger && readiness.tablesExist && readiness.positionLedgerFunctional) {
      const diff = await positionLedger.reconcileWithSnapshot(snapshot);
      readiness.isSynced = typeof diff?.isSynced === 'boolean' ? diff.isSynced : null;
      readiness.reconciliationOk = typeof diff?.isSynced === 'boolean';
      if (!readiness.reconciliationOk) {
        sanitizedFailure('Reconciliation did not return a boolean isSynced value');
      } else {
        console.log('Reconciliation isSynced:', readiness.isSynced);
        if (!readiness.isSynced) {
          // A mismatch is reported, not silently reclassified as healthy.
          console.warn('Ledger/snapshot mismatch detected; the script did not modify either source.');
        }
      }
    } else {
      readiness.reconciliationOk = false;
      readiness.isSynced = null;
      sanitizedFailure('Reconciliation skipped because the database or ledger check was unavailable');
    }
  } catch {
    readiness.snapshotOk = false;
    readiness.reconciliationOk = false;
    readiness.isSynced = null;
    sanitizedFailure('Tradetron snapshot fetch failed');
  }
}

try {
  await run();
} finally {
  if (closePool) {
    try {
      await closePool();
      readiness.poolClosed = true;
    } catch {
      sanitizedFailure('Database pool shutdown failed');
    }
  }

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('LEDGER SMOKE TEST SUMMARY');
  console.log('════════════════════════════════════════════');
  console.log(`${readiness.databaseUrl ? '✅' : '❌'} DATABASE_URL configured`);
  console.log(`${readiness.databaseConnected ? '✅' : '❌'} DB connection established`);
  console.log(`${readiness.tablesExist ? '✅' : '❌'} Migration applied (3 tables)`);
  console.log(`${readiness.positionLedgerRows !== null ? '✅' : '❌'} position_ledger rows: ${readiness.positionLedgerRows ?? 'unavailable'}`);
  console.log(`${readiness.webhookEventRows !== null ? '✅' : '❌'} webhook_events rows: ${readiness.webhookEventRows ?? 'unavailable'}`);
  console.log(`${readiness.systemMetaRows !== null ? '✅' : '❌'} system_meta rows: ${readiness.systemMetaRows ?? 'unavailable'}`);
  console.log(`${readiness.positionLedgerFunctional ? '✅' : '❌'} PositionLedger functional (getGlobalCount returns number)`);
  console.log(`${readiness.snapshotOk ? '✅' : '⚠️ '} Tradetron snapshot: ${readiness.snapshotOk ? 'OK (' + readiness.snapshotCount + ' items)' : 'FAILED'}`);
  console.log(`${readiness.reconciliationOk ? '✅' : '❌'} Reconciliation: isSynced = ${readiness.isSynced === null ? 'null' : readiness.isSynced}`);
  if (readiness.poolClosed) console.log('✅ Database pool closed');
  console.log('════════════════════════════════════════════');
  console.log(overallFailed ? 'RESULT: FAIL — review the failed readiness checks above.' : 'RESULT: PASS — all readiness checks completed.');
  console.log('');
  console.log('Read-only script. Does not modify any data. Run manually via:');
  console.log('npm run smoke:ledger');

  if (overallFailed) process.exitCode = 1;
}
