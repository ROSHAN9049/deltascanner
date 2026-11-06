import test from 'node:test';
import assert from 'node:assert/strict';
import { filterDeltaTradesByPeriod } from '../src/delta-pnl-period.js';

const rows = [
  { id: 1, closed_at: '2026-11-06T02:00:00.000Z' }, // 07:30 IST, today
  { id: 2, closed_at: '2026-11-05T18:30:00.000Z' }, // 00:00 IST, Nov 6
  { id: 3, closed_at: '2026-10-31T18:29:59.000Z' }, // Oct 31 IST
  { id: 4, closed_at: '2026-10-01T10:00:00.000Z' },
  { id: 5, closed_at: null }
];

test('ALL preserves every row and TODAY uses the India calendar day', () => {
  const now = Date.parse('2026-11-06T03:30:00.000Z');
  assert.deepEqual(filterDeltaTradesByPeriod(rows, 'ALL', '', '', now).map(row => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterDeltaTradesByPeriod(rows, 'TODAY', '', '', now).map(row => row.id), [1, 2]);
});

test('7D and 30D use rolling windows ending at the supplied clock', () => {
  const now = Date.parse('2026-11-06T03:30:00.000Z');
  assert.deepEqual(filterDeltaTradesByPeriod(rows, '7D', '', '', now).map(row => row.id), [1, 2, 3]);
  assert.deepEqual(filterDeltaTradesByPeriod(rows, '30D', '', '', now).map(row => row.id), [1, 2, 3, 4]);
});

test('CUSTOM includes the full from/to dates in India local time', () => {
  assert.deepEqual(
    filterDeltaTradesByPeriod(rows, 'CUSTOM', '2026-11-01', '2026-11-06').map(row => row.id),
    [1, 2]
  );
  assert.deepEqual(
    filterDeltaTradesByPeriod(rows, 'CUSTOM', '2026-11-01', '').map(row => row.id),
    [1, 2]
  );
});
