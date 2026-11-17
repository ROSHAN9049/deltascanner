import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStrategyPositionCapSnapshot } from '../worker/strategy-position-cap-snapshot.mjs';

test('loads one open-position query and one entry-order query for multiple strategies', async () => {
  const calls = [];
  const database = {
    async select(table, query) {
      calls.push({ table, query });
      if (table === 'dd_delta_positions') {
        return [
          { id: 'p1', symbol: 'XAUTUSD', status: 'OPEN', strategy: 'MOMENTUM', entry_order_id: 'entry-1' },
          { id: 'p2', symbol: 'PAXGUSD', status: 'OPEN', strategy: 'SCALPING', entry_order_id: 'entry-2' }
        ];
      }
      if (table === 'dd_orders') {
        return [
          { id: 'o1', client_order_id: 'pending-1', strategy: 'MOMENTUM', role: 'ENTRY', state: 'PENDING' },
          { id: 'o2', client_order_id: 'filled-1', strategy: 'MOMENTUM', role: 'ENTRY', state: 'FILLED', created_at: '2026-11-17T00:00:00.000Z' }
        ];
      }
      return [];
    }
  };

  const snapshot = await loadStrategyPositionCapSnapshot({
    database,
    settings: { max_momentum_positions: 5, max_scalping_positions: 5 },
    strategies: ['MOMENTUM', 'SCALPING'],
    now: Date.parse('2026-11-17T00:00:30.000Z')
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.table).sort(), ['dd_delta_positions', 'dd_orders']);
  assert.match(calls.find(call => call.table === 'dd_delta_positions').query, /status=eq\.OPEN/);
  const orderQuery = calls.find(call => call.table === 'dd_orders').query;
  assert.match(orderQuery, /role=eq\.ENTRY/);
  assert.match(orderQuery, /state\.in\.\(PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED\)/);
  assert.match(orderQuery, /state\.eq\.FILLED/);
  assert.equal(snapshot.MOMENTUM.openPositions, 1);
  assert.equal(snapshot.MOMENTUM.pendingReservations, 2);
  assert.equal(snapshot.MOMENTUM.exposure, 3);
  assert.equal(snapshot.MOMENTUM.status, 'PASS');
  assert.equal(snapshot.SCALPING.openPositions, 1);
  assert.equal(snapshot.SCALPING.exposure, 1);
  assert.equal(snapshot.SCALPING.status, 'PASS');
});

test('malformed database response rejects so the caller can fail closed', async () => {
  const database = { async select() { return null; } };
  await assert.rejects(
    loadStrategyPositionCapSnapshot({ database, strategies: ['MOMENTUM'] }),
    /malformed data/
  );
});
