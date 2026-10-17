import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTradetronCsvRow, parseCsv } from '../scripts/import-tradetron-csv.mjs';

test('CSV parser supports quoted commas, escaped quotes and multiline fields', () => {
  const rows = parseCsv('Symbol,Note,P&L\r\nBTCUSD,"profit, ""net""",-4.5\r\nETHUSD,"line one\nline two",2\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'profit, "net"');
  assert.equal(rows[1].note, 'line one\nline two');
  assert.equal(rows[1].p_l, '2');
});

test('CSV normalization only uses explicit fields, keeps side nullable and unverified', () => {
  const out = normalizeTradetronCsvRow({
    symbol: 'BTCUSD', pnl: '-12.50', quantity: '-2', entry_price: '100', exit_price: '94',
    closed_at: '2026-10-17T04:00:00Z', side: ''
  }, { deploymentIdOverride: '123', detectedAt: '2026-10-17T04:01:00Z' });
  assert.equal(out.ok, true);
  assert.equal(out.row.side, null);
  assert.equal(out.row.qty_closed, 2);
  assert.equal(out.row.data_quality, 'FULL');
  assert.equal(out.row.is_verified, false);
  assert.equal(out.row.derived_from, 'csv_import');
  assert.equal(out.row.raw_pnl, -12.5);
});

test('CSV rows with missing P&L are skipped rather than assigned zero', () => {
  const out = normalizeTradetronCsvRow({ symbol: 'ETHUSD', qty: 1 }, { deploymentIdOverride: '123' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /P&L/);
});
