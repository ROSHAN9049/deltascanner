import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationUrl = new URL('../src/ledger/migrations/001_position_ledger.sql', import.meta.url);
const migrationPath = fileURLToPath(migrationUrl);
const sql = readFileSync(migrationPath, 'utf8');
const positionLedgerBlock = sql.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+position_ledger\s*\(([\s\S]*?)\);/i)?.[1] ?? '';

describe('PositionLedger migration SQL structure (text-only)', () => {
  test('migration file exists and is readable', () => {
    assert.ok(sql.length > 500, 'migration SQL should contain a meaningful schema');
  });

  test('migration wraps in BEGIN/COMMIT', () => {
    assert.ok(sql.includes('BEGIN;'));
    assert.ok(sql.includes('COMMIT;'));
  });

  test('migration creates exactly three tables', () => {
    const matches = [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)];
    assert.strictEqual(matches.length, 3);
  });

  test('migration creates the expected three table names', () => {
    const tableNames = [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)]
      .map(match => match[1].toLowerCase());
    assert.deepStrictEqual(tableNames, ['position_ledger', 'webhook_events', 'system_meta']);
  });

  test('position_ledger has all required columns', () => {
    assert.ok(positionLedgerBlock, 'position_ledger table block should be present');
    const requiredColumns = [
      'id', 'tradetron_order_id', 'webhook_event_id', 'symbol', 'side', 'qty',
      'entry_price', 'entry_time', 'exit_price', 'exit_time', 'status',
      'gross_pnl_usd', 'net_pnl_usd', 'fees_usd', 'funding_usd',
      'created_at', 'updated_at'
    ];
    for (const column of requiredColumns) {
      assert.match(positionLedgerBlock, new RegExp('\\b' + column + '\\b', 'i'), `missing column: ${column}`);
    }
  });

  test('position_ledger has a CHECK constraint for side', () => {
    assert.ok(sql.includes("side IN ('LONG', 'SHORT')"));
  });

  test('position_ledger has a CHECK constraint for status', () => {
    assert.ok(sql.includes("status IN ('OPEN', 'CLOSED', 'PARTIAL')"));
  });

  test('webhook_events has JSONB raw_payload NOT NULL', () => {
    assert.match(sql, /raw_payload\s+JSONB\s+NOT NULL/i);
  });

  test('webhook_events has signature_valid BOOLEAN NOT NULL', () => {
    assert.match(sql, /signature_valid\s+BOOLEAN\s+NOT NULL/i);
  });

  test('required indexes exist', () => {
    for (const indexName of [
      'idx_position_ledger_status',
      'idx_position_ledger_symbol',
      'idx_webhook_events_status',
      'idx_webhook_events_received_at'
    ]) {
      assert.ok(sql.includes(indexName), `missing index: ${indexName}`);
    }
  });

  test('tradetron_order_id has a UNIQUE constraint', () => {
    assert.match(sql, /tradetron_order_id\s+VARCHAR\(64\)\s+NOT NULL\s+UNIQUE/i);
  });

  test('webhook_event_id has a UNIQUE constraint', () => {
    assert.match(sql, /webhook_event_id\s+VARCHAR\(64\)\s+NOT NULL\s+UNIQUE/i);
  });
});

const deltaMigrationRunner = readFileSync(
  fileURLToPath(new URL('../scripts/apply-all-migrations.mjs', import.meta.url)),
  'utf8'
);

test('multi-symbol Grid settings migration is registered and adds per-symbol configuration', async () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../db/migrations/20261105000100_enable_testnet_multi_symbol_grid.sql', import.meta.url)),
    'utf8'
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS grid_symbol_configs JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(migration, /NOTIFY pgrst/i);
  assert.match(migration, /COMMIT;/);
  assert.ok(deltaMigrationRunner.indexOf('20261105000100_enable_testnet_multi_symbol_grid.sql') >
    deltaMigrationRunner.indexOf('20261103000100_add_per_strategy_position_limits.sql'));
});

test('Delta position-close migration stays between worker lease and E-STOP safety migrations', () => {
  const leaseIndex = deltaMigrationRunner.indexOf('20261029100000_worker_lease_ownership.sql');
  const closeDetailsIndex = deltaMigrationRunner.indexOf('20261029110000_delta_position_close_details.sql');
  const estopIndex = deltaMigrationRunner.indexOf('20261029120000_estop_release_challenge.sql');

  assert.ok(leaseIndex >= 0, 'worker lease migration must remain registered');
  assert.ok(closeDetailsIndex > leaseIndex, 'position close details must follow worker lease ownership');
  assert.ok(estopIndex > closeDetailsIndex, 'E-STOP release challenge must remain after position close details');
});


const deltaFillMigrationPath = fileURLToPath(new URL('../db/migrations/20261029163000_delta_fill_ledger.sql', import.meta.url));
const deltaFillMigration = readFileSync(deltaFillMigrationPath, 'utf8');
const migrationRunner = readFileSync(fileURLToPath(new URL('../scripts/apply-all-migrations.mjs', import.meta.url)), 'utf8');

describe('Delta Testnet fill ledger migration SQL structure', () => {
  test('fill ledger migration is transactional and preserves unknown amounts as NULL', () => {
    assert.ok(deltaFillMigration.includes('BEGIN;'));
    assert.ok(deltaFillMigration.includes('COMMIT;'));
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS client_order_id TEXT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS timestamp_us BIGINT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS commission_currency TEXT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS commission_currency TEXT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS close_source TEXT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS entry_order_id TEXT NULL/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS fees_verified BOOLEAN NOT NULL DEFAULT FALSE/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS gross_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS net_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE/i);
    assert.match(deltaFillMigration, /ADD COLUMN IF NOT EXISTS realized_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE/i);
    assert.match(deltaFillMigration, /CREATE TABLE IF NOT EXISTS public\.dd_delta_fill_sync_state/i);
    assert.match(deltaFillMigration, /ALTER COLUMN gross_pnl DROP NOT NULL/i);
    assert.match(deltaFillMigration, /ALTER COLUMN fees DROP DEFAULT/i);
    assert.match(deltaFillMigration, /ALTER COLUMN gross_pnl DROP DEFAULT/i);
    assert.match(deltaFillMigration, /ALTER COLUMN net_pnl DROP DEFAULT/i);
    assert.match(deltaFillMigration, /ALTER COLUMN net_pnl DROP NOT NULL/i);
    assert.match(deltaFillMigration, /REVOKE ALL ON TABLE public\.dd_delta_fill_sync_state FROM anon, authenticated/i);
    assert.match(deltaFillMigration, /GRANT ALL ON TABLE public\.dd_delta_fill_sync_state TO service_role/i);
  });

  test('migration runner registers the fill ledger after prior safety migrations', () => {
    const estopIndex = migrationRunner.indexOf('20261029120000_estop_release_challenge.sql');
    const fillIndex = migrationRunner.indexOf('20261029163000_delta_fill_ledger.sql');
    assert.ok(estopIndex >= 0 && fillIndex > estopIndex);
    assert.match(migrationRunner, /'dd_delta_fill_sync_state'/);
  });
});


const exchangePnlMigrationPath = fileURLToPath(
  new URL('../db/migrations/20261106000100_exchange_authoritative_pnl_ledger.sql', import.meta.url)
);
const exchangePnlMigration = readFileSync(exchangePnlMigrationPath, 'utf8');

test('exchange-authoritative P&L migration adds private wallet history and verified daily rollups', () => {
  assert.match(exchangePnlMigration, /^BEGIN;/);
  assert.match(exchangePnlMigration, /CREATE TABLE IF NOT EXISTS public\.dd_wallet_transactions/i);
  assert.match(exchangePnlMigration, /CREATE TABLE IF NOT EXISTS public\.dd_wallet_transaction_sync_state/i);
  assert.match(exchangePnlMigration, /ADD COLUMN IF NOT EXISTS history_start_us BIGINT NULL/i);
  assert.match(exchangePnlMigration, /ADD COLUMN IF NOT EXISTS exchange_realized_pnl NUMERIC NULL/i);
  assert.match(exchangePnlMigration, /ADD COLUMN IF NOT EXISTS realized_funding NUMERIC NULL/i);
  assert.match(exchangePnlMigration, /ADD COLUMN IF NOT EXISTS funding_verified BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(exchangePnlMigration, /ADD COLUMN IF NOT EXISTS fee_currency TEXT NULL/i);
  assert.match(exchangePnlMigration, /ALTER TABLE public\.dd_wallet_transactions ENABLE ROW LEVEL SECURITY/i);
  assert.match(exchangePnlMigration, /REVOKE ALL ON TABLE public\.dd_wallet_transactions FROM anon, authenticated/i);
  assert.match(exchangePnlMigration, /GRANT ALL ON TABLE public\.dd_wallet_transactions TO service_role/i);
  assert.match(exchangePnlMigration, /result = 'SUPERSEDED'/i);
  assert.match(exchangePnlMigration, /CREATE TRIGGER dd_trades_daily_pnl_sync/i);
  assert.match(exchangePnlMigration, /net_pnl_verified IS TRUE/i);
  assert.match(exchangePnlMigration, /NOTIFY pgrst/i);
  assert.match(exchangePnlMigration, /COMMIT;/);
  const gridIndex = migrationRunner.indexOf('20261105000100_enable_testnet_multi_symbol_grid.sql');
  const pnlIndex = migrationRunner.indexOf('20261106000100_exchange_authoritative_pnl_ledger.sql');
  assert.ok(gridIndex >= 0 && pnlIndex > gridIndex, 'exchange P&L migration must run after the Grid settings migration');
  assert.match(migrationRunner, /'dd_wallet_transactions'/);
  assert.match(migrationRunner, /'dd_wallet_transaction_sync_state'/);
});
