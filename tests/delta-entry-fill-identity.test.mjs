import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/execution/delta-executor.mjs', import.meta.url), 'utf8');

test('persisted Delta positions retain the exchange entry order id explicitly', () => {
  const start = source.indexOf('async function persistRestConfirmedPosition');
  const end = source.indexOf('async function submitOrder', start);
  assert.ok(start >= 0 && end > start, 'position persistence function exists');
  const persist = source.slice(start, end);
  assert.match(
    persist,
    /entry_order_id:\s*String\(order\?\.id \?\? position\.order_id \?\? ''\)/
  );
});

test('fill reconciliation falls back to the legacy persisted order_id when entry_order_id is absent', () => {
  assert.match(
    source,
    /const entryOrderId = stringOrEmpty\(position\?\.entry_order_id \?\? position\?\.order_id\);/
  );
});
