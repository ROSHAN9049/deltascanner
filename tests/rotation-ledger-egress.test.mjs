import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRotationLedgerRowsOnce } from '../worker/execution/delta-tracker.mjs';

test('rotation ledger cleanup batches IDs and suppresses duplicate DELETEs after success', async () => {
  const calls = [];
  const database = {
    async remove(table, query) {
      calls.push({ table, query });
      return [];
    }
  };
  const completedIds = new Set();
  const first = await cleanupRotationLedgerRowsOnce({
    database,
    executionIds: ['delta-testnet-position:abc', 'DDM-BTCUSD-one', 'DDM-BTCUSD-one'],
    completedIds
  });
  const second = await cleanupRotationLedgerRowsOnce({
    database,
    executionIds: ['delta-testnet-position:abc', 'DDM-BTCUSD-one'],
    completedIds
  });

  assert.equal(first, 2);
  assert.equal(second, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'dd_rotation_ledger');
  assert.match(calls[0].query, /^execution_id=in\.\(/);
  assert.match(calls[0].query, /delta-testnet-position%3Aabc/);
  assert.ok(completedIds.has('delta-testnet-position:abc'));
});

test('rotation ledger cleanup retries a batch when the DELETE request fails', async () => {
  let callCount = 0;
  const completedIds = new Set();
  const database = {
    async remove() {
      callCount += 1;
      if (callCount === 1) throw new Error('temporary request failure');
      return [];
    }
  };
  await assert.rejects(
    cleanupRotationLedgerRowsOnce({ database, executionIds: ['one', 'two'], completedIds }),
    /temporary request failure/
  );
  assert.equal(completedIds.size, 0);
  assert.equal(await cleanupRotationLedgerRowsOnce({
    database, executionIds: ['one', 'two'], completedIds
  }), 2);
  assert.equal(callCount, 2);
});
