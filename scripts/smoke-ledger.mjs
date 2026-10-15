// Manual integration smoke test. This script is never imported by the app
// or test suite and is only run via: npm run smoke:ledger
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Refusing to run.');
  process.exit(1);
}

const summary = [];
let closePool = null;
let failureCode = null;

function addSummary(check, status, result) {
  summary.push({ Check: check, Status: status, Result: result });
}

function safeCode(error) {
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(error.code)
    ? error.code
    : null;
  return code;
}

try {
  console.log('[1/6] Connecting to database...');
  const { pool, db, closePool: closeDatabase } = await import('../src/ledger/pg-adapter.mjs');
  closePool = closeDatabase;
  const { PositionLedger } = await import('../src/ledger/index.mjs');
  const { tradetronAPI } = await import('../src/adapters/tradetron-snapshot-adapter.mjs');

  await pool.query('SELECT 1');
  console.log('Database connection: OK');
  addSummary('Database connection', 'PASS', 'SELECT 1 succeeded');

  console.log('[2/6] Checking migrations...');
  const migrationResult = await pool.query(`
    SELECT
      to_regclass('public.position_ledger') AS t1,
      to_regclass('public.webhook_events') AS t2,
      to_regclass('public.system_meta') AS t3
  `);
  const migration = migrationResult.rows[0] || {};
  const migrationOk = Boolean(migration.t1 && migration.t2 && migration.t3);
  if (!migrationOk) {
    console.error('Migration 001_position_ledger.sql has not been applied. Run it first.');
    addSummary('Migration 001', 'FAIL', 'One or more required tables are missing');
    const err = new Error('Required ledger tables missing');
    err.code = 'MIGRATION_MISSING';
    throw err;
  }
  console.log('Required ledger tables: present');
  addSummary('Migration 001', 'PASS', 'All three required tables exist');

  console.log('[3/6] Reading database row counts...');
  const positionsCount = await pool.query('SELECT COUNT(*)::int AS count FROM position_ledger');
  const webhookCount = await pool.query('SELECT COUNT(*)::int AS count FROM webhook_events');
  const positionRows = Number(positionsCount.rows[0]?.count ?? 0);
  const webhookRows = Number(webhookCount.rows[0]?.count ?? 0);
  console.log('position_ledger rows:', positionRows);
  console.log('webhook_events rows:', webhookRows);
  addSummary('Database row counts', 'PASS', `position_ledger=${positionRows}; webhook_events=${webhookRows}`);

  console.log('[4/6] Reading PositionLedger global count...');
  const positionLedger = new PositionLedger(db, {
    logger: { info() {}, warn() {}, error() {} }
  });
  const globalCount = await positionLedger.getGlobalCount();
  console.log('PositionLedger getGlobalCount():', globalCount);
  addSummary('PositionLedger count', 'PASS', String(globalCount));

  console.log('[5/6] Calling read-only Tradetron snapshot adapter...');
  try {
    const snapshot = await tradetronAPI.getSnapshot();
    const snapshotCount = Array.isArray(snapshot) ? snapshot.length : 0;
    console.log('Normalized snapshot item count:', snapshotCount);
    addSummary('Tradetron snapshot adapter', 'PASS', `${snapshotCount} normalized items`);
  } catch (error) {
    // Do not print arbitrary upstream error messages; they may contain details
    // that should not be copied into terminal logs.
    const code = safeCode(error);
    const result = code ? `Request failed (code: ${code}); details suppressed` : 'Request failed; details suppressed';
    console.warn('Tradetron snapshot request failed; details suppressed.');
    addSummary('Tradetron snapshot adapter', 'WARN', result);
  }

} catch (error) {
  failureCode = safeCode(error);
  process.exitCode = 1;
  if (error && error.code === 'MIGRATION_MISSING') {
    // The specific, actionable migration message was already printed above.
  } else {
    console.error('Ledger smoke test failed; error details suppressed.');
    if (failureCode) console.error('Safe error code:', failureCode);
  }
  addSummary('Smoke test', 'FAIL', error && error.code === 'MIGRATION_MISSING'
    ? 'Required ledger tables missing'
    : failureCode ? `Failed (code: ${failureCode})` : 'Failed; details suppressed');
} finally {
  if (closePool) {
    try {
      await closePool();
      addSummary('Database pool shutdown', 'PASS', 'Pool closed');
    } catch (error) {
      process.exitCode = 1;
      const code = safeCode(error);
      addSummary('Database pool shutdown', 'FAIL', code ? `Failed (code: ${code})` : 'Failed; details suppressed');
      console.error('Database pool shutdown failed; details suppressed.');
    }
  } else {
    addSummary('Database pool shutdown', 'SKIP', 'Pool was not initialized');
  }
  console.log('[6/6] Final summary');
  console.table(summary);
}
