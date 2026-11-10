import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGridAtrSnapshot } from '../src/grid-atr-snapshot.js';

test('reads persisted snake_case ATR fields for a symbol', () => {
  const result = resolveGridAtrSnapshot({
    grid_symbol_configs: { PAXGUSD: {
      atr_14d: 65.22, atr_pct: 1.588, atr_snapshot_status: 'READY', atr_fallback: false
    } }
  }, 'PAXGUSD');
  assert.deepEqual(result, { atr: 65.22, atrPct: 1.588, status: 'READY', fallback: false, snapshotAt: null });
});

test('handles serialized JSON and case-insensitive symbol keys', () => {
  const result = resolveGridAtrSnapshot({
    grid_symbol_configs: JSON.stringify({ paxgusd: { atr_14d: '65.22', atr_pct: '1.588', atr_snapshot_status: 'READY' } })
  }, 'PAXGUSD');
  assert.equal(result.atr, 65.22);
  assert.equal(result.atrPct, 1.588);
  assert.equal(result.status, 'READY');
});

test('supports legacy aliases and local auto-range draft values', () => {
  const legacy = resolveGridAtrSnapshot({
    grid_symbol_configs: { NVDAXUSD: { atr: 8.5, atrPct: 4.68, atrSnapshotStatus: 'READY' } }
  }, 'NVDAXUSD');
  assert.equal(legacy.atr, 8.5);
  assert.equal(legacy.atrPct, 4.68);
  const draft = resolveGridAtrSnapshot({}, 'PAXGUSD', { atr_14d: 20, atr_pct: 0.5 });
  assert.equal(draft.atr, 20);
  assert.equal(draft.atrPct, 0.5);
});

test('shows the deliberate fallback status without inventing a numeric ATR', () => {
  const result = resolveGridAtrSnapshot({
    grid_symbol_configs: { NVDAXUSD: { atr_snapshot_status: 'FALLBACK_3PCT', atr_fallback: true } }
  }, 'NVDAXUSD');
  assert.equal(result.atr, null);
  assert.equal(result.fallback, true);
  assert.equal(result.status, 'FALLBACK_3PCT');
});
