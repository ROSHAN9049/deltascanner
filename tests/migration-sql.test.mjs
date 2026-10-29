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
