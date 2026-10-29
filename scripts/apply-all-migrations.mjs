import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Keep this list explicit and in dependency order. The base schema must run first.
const MIGRATIONS = [
  'db/schema.sql',
  'src/ledger/migrations/001_position_ledger.sql',
  'db/migrations/20261010151000_tradetron_event_processing.sql',
  'db/migrations/20261011055500_secure_open_positions_summary_view.sql',
  'db/migrations/20261012080000_tradetron_developer_api_sync.sql',
  'db/migrations/20261013090000_tradetron_developer_notifications_history.sql',
  'db/migrations/20261016000000_postgrest_schema_refresh.sql',
  'db/migrations/20261024100000_delta_testnet_positions.sql',
  'db/migrations/20261026120000_delta_position_external_close.sql',
  'db/migrations/20261029100000_worker_lease_ownership.sql',
  'db/migrations/20261029110000_delta_position_close_details.sql',
  'db/migrations/20261029120000_estop_release_challenge.sql'
];

// These are the four "already exists" SQLSTATEs explicitly approved for skipping.
// Do not broaden this set to generic SQL or connection errors.
const ALREADY_EXISTS_CODES = new Set(['42P07', '42710', '42P06', '42701']);

const EXPECTED_TABLES = [
  'dd_settings',
  'dd_signals',
  'dd_positions',
  'dd_orders',
  'dd_delta_positions',
  'dd_trades',
  'dd_fills',
  'dd_signal_cache',
  'dd_market_cache',
  'dd_option_cache',
  'dd_engine_logs',
  'dd_engine_lease',
  'dd_tradetron_events',
  'position_ledger',
  'webhook_events',
  'system_meta',
  'dd_tradetron_developer_snapshots',
  'dd_tradetron_developer_sync_state',
  'dd_tradetron_developer_notifications',
  'dd_tradetron_developer_notification_sync_state',
  'dd_tradetron_developer_pnl_history'
];

function sanitizeError(error) {
  let message = error instanceof Error
    ? error.message
    : String(error ?? 'Unknown error');

  // Never allow a connection string or common credential assignment into logs.
  for (const secret of [
    process.env.DATABASE_URL,
    process.env.SUPABASE_DB_URL
  ]) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }

  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'\x60]+/gi, '[REDACTED DATABASE URL]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 400);
}

function hasInternalTransaction(sql) {
  // In the repository's SQL files, an explicit transaction starts with a
  // standalone BEGIN; statement. The match is case-insensitive.
  return /^\s*BEGIN\s*;/im.test(sql);
}

async function applyMigration(pool, relativePath, sql) {
  const client = await pool.connect();
  const hasOwnTransaction = hasInternalTransaction(sql);

  try {
    if (!hasOwnTransaction) {
      await client.query('BEGIN');
    }

    await client.query(sql);

    if (!hasOwnTransaction) {
      await client.query('COMMIT');
    }

    return 'success';
  } catch (error) {
    // Ensure the same connection is usable for subsequent migrations.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback can itself fail if the connection was lost; retain the
      // original, sanitized migration error.
    }

    if (ALREADY_EXISTS_CODES.has(error?.code)) {
      return 'skipped';
    }

    const safeError = new Error(sanitizeError(error));
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
      safeError.code = error.code;
    }
    safeError.migrationPath = relativePath;
    throw safeError;
  } finally {
    client.release();
  }
}

async function main() {
  let closePool;

  try {
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL is required. Add the DATABASE_URL repository secret.');
      process.exitCode = 1;
      return;
    }

    // Load the adapter only after the environment guard: its module validates
    // DATABASE_URL during initialization.
    const adapter = await import('../src/ledger/pg-adapter.mjs');
    const { pool } = adapter;
    closePool = adapter.closePool;

    console.log(`Applying ${MIGRATIONS.length} SQL migrations in dependency order.\n`);

    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const relativePath = MIGRATIONS[index];
      const fullPath = path.join(REPO_ROOT, relativePath);

      console.log(`[${index + 1}/${MIGRATIONS.length}] Applying ${relativePath}...`);

      let sql;
      try {
        sql = fs.readFileSync(fullPath, 'utf8');
      } catch (error) {
        console.error(`  ❌ Failed: Could not read migration file (${sanitizeError(error)})`);
        process.exitCode = 1;
        return;
      }

      try {
        const result = await applyMigration(pool, relativePath, sql);
        if (result === 'skipped') {
          console.log('  ⚠️ Skipped (already exists)');
        } else {
          console.log('  ✅ Success');
        }
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
          ? ` (SQLSTATE ${error.code})`
          : '';
        console.error(`  ❌ Failed: ${sanitizeError(error)}${code}`);
        process.exitCode = 1;
        return;
      }
    }

    await pool.query(
      "NOTIFY pgrst, 'reload schema'"
    );
    console.log("✅ PostgREST schema cache reload notification sent.\n");

    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );

    console.log(`\nPublic tables verified (${result.rows.length} total):`);
    for (const row of result.rows) {
      console.log(`  - ${row.table_name}`);
    }

    const existingTables = new Set(result.rows.map(row => row.table_name));
    const missingTables = EXPECTED_TABLES.filter(tableName => !existingTables.has(tableName));

    if (missingTables.length > 0) {
      console.warn(
        `\n⚠️ Expected table(s) missing (non-fatal): ${missingTables.join(', ')}`
      );
    } else {
      console.log('\n✅ All expected minimum tables are present.');
    }

    console.log('\nMigration application finished.');
  } catch (error) {
    console.error(`❌ Migration runner failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  } finally {
    if (typeof closePool === 'function') {
      try {
        await closePool();
      } catch (error) {
        console.error(`❌ Failed to close database pool: ${sanitizeError(error)}`);
        process.exitCode = 1;
      }
    }
  }
}

await main();
