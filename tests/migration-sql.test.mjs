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


const deltaOptionsMigrationPath = fileURLToPath(new URL('../db/migrations/20261030100000_delta_options_execution_ledger.sql', import.meta.url));
const deltaOptionsMigration = readFileSync(deltaOptionsMigrationPath, 'utf8');
const optionsMigrationRunner = readFileSync(fileURLToPath(new URL('../scripts/apply-all-migrations.mjs', import.meta.url)), 'utf8');

describe('Delta Testnet Options execution ledger migration SQL structure', () => {
  test('creates separate group and leg ledgers, not dd_delta_positions rows', () => {
    assert.ok(deltaOptionsMigration.includes('BEGIN;'));
    assert.ok(deltaOptionsMigration.includes('COMMIT;'));
    assert.match(deltaOptionsMigration, /CREATE TABLE IF NOT EXISTS public\\.dd_options_execution_groups/i);
    assert.match(deltaOptionsMigration, /CREATE TABLE IF NOT EXISTS public\\.dd_options_execution_legs/i);
    assert.doesNotMatch(deltaOptionsMigration, /INSERT INTO public\\.dd_delta_positions/i);
  });

  test('enforces one active Options group and unique group/leg idempotency keys', () => {
    assert.match(deltaOptionsMigration, /dd_options_one_active_execution_slot_idx/i);
    assert.match(deltaOptionsMigration, /WHERE state NOT IN \\('CLOSED', 'REJECTED', 'FAILED'\\)/i);
    assert.match(deltaOptionsMigration, /client_group_id TEXT NOT NULL UNIQUE/i);
    assert.match(deltaOptionsMigration, /client_order_id TEXT NOT NULL UNIQUE/i);
    assert.match(deltaOptionsMigration, /UNIQUE \\(group_id, leg_role\\)/i);
    assert.match(deltaOptionsMigration, /dd_options_active_leg_symbol_idx/i);
  });

  test('captures partial fills, exit fills, commissions and unknown order state', () => {
    assert.match(deltaOptionsMigration, /filled_qty NUMERIC NOT NULL DEFAULT 0/i);
    assert.match(deltaOptionsMigration, /exit_filled_qty NUMERIC NOT NULL DEFAULT 0/i);
    assert.match(deltaOptionsMigration, /commission_currency TEXT NULL/i);
    assert.match(deltaOptionsMigration, /exit_commission_currency TEXT NULL/i);
    assert.match(deltaOptionsMigration, /'UNKNOWN'/i);
    assert.match(deltaOptionsMigration, /'RECONCILIATION_REQUIRED'/i);
  });

  test('both ledgers are service-role only and migration follows Delta fill ledger', () => {
    for (const table of ['dd_options_execution_groups', 'dd_options_execution_legs', 'dd_options_execution_orders']) {
      assert.match(deltaOptionsMigration, new RegExp('ALTER TABLE public\\.' + table + ' ENABLE ROW LEVEL SECURITY', 'i'));
      assert.match(deltaOptionsMigration, new RegExp('REVOKE ALL ON TABLE public\\.' + table + ' FROM anon, authenticated', 'i'));
      assert.match(deltaOptionsMigration, new RegExp('GRANT ALL ON TABLE public\\.' + table + ' TO service_role', 'i'));
      assert.match(optionsMigrationRunner, new RegExp("'" + table + "'"));
    }
    const fillIndex = optionsMigrationRunner.indexOf('20261029163000_delta_fill_ledger.sql');
    const optionsIndex = optionsMigrationRunner.indexOf('20261030100000_delta_options_execution_ledger.sql');
    assert.ok(fillIndex >= 0 && optionsIndex > fillIndex);
  });
});
