// This script is idempotent — safe to run multiple times. It will
// refuse to re-run if all three tables exist. For partial states, manual
// intervention is required.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function main() {
  console.log('[1/5] Checking DATABASE_URL...');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exitCode = 1;
    return;
  }
  console.log('DATABASE_URL is configured.');

  let pool;
  let closePool;
  let client;
  try {
    ({ pool, closePool } = await import('../src/ledger/pg-adapter.mjs'));
    client = await pool.connect();

    console.log('[2/5] Checking existing tables...');
    const checkTables = async () => {
      const result = await client.query(`
        SELECT
          to_regclass('public.position_ledger') AS t1,
          to_regclass('public.webhook_events') AS t2,
          to_regclass('public.system_meta') AS t3
      `);
      const row = result.rows[0] || {};
      return [Boolean(row.t1), Boolean(row.t2), Boolean(row.t3)];
    };

    const existing = await checkTables();
    if (existing.every(Boolean)) {
      console.log('Migration already applied. Nothing to do.');
      console.log('[4/5] Verifying tables...');
      console.log('All three required tables exist.');
      console.log('[5/5] Done.');
      return;
    }
    if (existing.some(Boolean)) {
      console.error(
        'WARNING: Partial migration state detected. Existing tables:',
        ['position_ledger', 'webhook_events', 'system_meta']
          .filter((_, index) => existing[index]).join(', ') || '(none)'
      );
      console.error('Manual inspection is required; no schema changes were made.');
      process.exitCode = 1;
      return;
    }

    console.log('[3/5] Applying migration...');
    const migrationPath = new URL('../src/ledger/migrations/001_position_ledger.sql', import.meta.url);
    const originalSql = readFileSync(fileURLToPath(migrationPath), 'utf8');

    // The migration file documents itself with BEGIN/COMMIT. Strip only these
    // outer statements so the runner's transaction can own rollback/commit.
    // The committed migration file itself remains unchanged.
    const migrationSql = originalSql
      .replace(/(^|\n)\s*BEGIN\s*;\s*/i, '$1')
      .replace(/\s*COMMIT\s*;\s*$/, '');

    await client.query('BEGIN');
    try {
      await client.query(migrationSql);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original migration error; don't print driver internals.
      }
      throw error;
    }
    console.log('✅ Migration applied successfully.');

    console.log('[4/5] Verifying tables...');
    const after = await checkTables();
    if (!after.every(Boolean)) {
      throw new Error('Post-migration verification failed: one or more tables are missing');
    }
    console.log('✅ position_ledger, webhook_events, and system_meta exist.');

    console.log('[5/5] Done.');
    console.log('Summary: migration applied and all three tables verified.');
  } catch (error) {
    process.exitCode = 1;
    const message = String(error?.message || 'Unknown migration error');
    // Ensure environment values cannot leak if a database driver includes
    // configuration text in an error message.
    const sanitized = [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL]
      .filter(Boolean)
      .reduce((text, secret) => text.split(secret).join('[redacted]'), message);
    console.error('❌ Migration failed:', sanitized);
  } finally {
    if (client) client.release();
    if (closePool) {
      try {
        await closePool();
      } catch {
        process.exitCode = 1;
        console.error('Failed to close database pool; details suppressed.');
      }
    }
  }
}

await main();
