import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { closeTrackedPosition } from '../worker/execution/exit-lifecycle.mjs';
import { duplicatePositionBlocker } from '../worker/engine.mjs';

function closeRuntime({ flat = true } = {}) {
  const rows = [{
    id: 71, symbol: 'PAXGUSD', status: 'OPEN',
    client_order_id: 'DDM-PAXGUSD-abc', entry_order_id: '12345',
    side: 'BUY', product_id: 181689
  }];
  const updates = [];
  const database = {
    async select(table) { return table === 'dd_delta_positions' ? rows.map(row => ({ ...row })) : []; },
    async update(table, query, patch) {
      updates.push({ table, query, patch });
      Object.assign(rows[0], patch);
    }
  };
  const executor = {
    async closePosition() {
      return {
        id: 9001, state: 'FILLED', unfilled_size: 0,
        exchange_position_flat: flat, average_fill_price: 4000
      };
    }
  };
  return { rows, updates, database, executor };
}

test('same-direction duplicates block while opposite-side signals enter reversal path only', () => {
  const positions = [{ symbol: 'PAXGUSD', qty: 5, side: 'BUY' }];
  assert.equal(duplicatePositionBlocker(positions, 'PAXGUSD', 'BUY'), 'Duplicate symbol');
  assert.equal(duplicatePositionBlocker(positions, 'PAXGUSD', 'SELL'), '');
  assert.equal(duplicatePositionBlocker(positions, 'PAXGUSD', null), 'Duplicate symbol');
});

test('REVERSAL closes only an enrolled Engine position after exchange confirms flat', async () => {
  const rt = closeRuntime({ flat: true });
  const result = await closeTrackedPosition({
    database: rt.database,
    executor: rt.executor,
    position: {
      id: 71, delta_position_id: '71', origin: 'ENGINE', strategy: 'MOMENTUM',
      execution_id: 'DDM-PAXGUSD-abc', client_order_id: 'DDM-PAXGUSD-abc',
      opened_at: '2026-11-24T10:00:00.000Z'
    },
    symbol: 'PAXGUSD', productId: 181689, qty: 5, side: 'BUY',
    reason: 'REVERSAL',
    deploymentBoundaryMs: Date.parse('2026-11-24T09:00:00.000Z'),
    log: async () => {}
  });
  assert.equal(result.positionClosed, true);
  assert.equal(result.order.exchange_position_flat, true);
  assert.equal(rt.rows[0].status, 'CLOSED');
  assert.equal(rt.rows[0].exit_reason, 'REVERSAL');
});

test('REVERSAL never marks the canonical row closed when exchange flat confirmation fails', async () => {
  const rt = closeRuntime({ flat: false });
  const result = await closeTrackedPosition({
    database: rt.database,
    executor: rt.executor,
    position: {
      id: 71, delta_position_id: '71', origin: 'ENGINE', strategy: 'MOMENTUM',
      execution_id: 'DDM-PAXGUSD-abc', client_order_id: 'DDM-PAXGUSD-abc',
      opened_at: '2026-11-24T10:00:00.000Z'
    },
    symbol: 'PAXGUSD', productId: 181689, qty: 5, side: 'BUY',
    reason: 'REVERSAL',
    deploymentBoundaryMs: Date.parse('2026-11-24T09:00:00.000Z'),
    log: async () => {}
  });
  assert.equal(result.positionClosed, false);
  assert.equal(rt.rows[0].status, 'OPEN');
  assert.equal(rt.rows[0].requested_exit_reason, 'REVERSAL');
});

test('openTrade reversal path closes, polls flat, and refreshes settings/account/positions before riskGate', async () => {
  const source = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  const closeIndex = source.indexOf("reason: 'REVERSAL'");
  const freshAccountIndex = source.indexOf('deltaExecutor.getAccountSnapshot()', closeIndex);
  const freshPositionIndex = source.indexOf('deltaExecutor.getOpenPositions()', closeIndex);
  const riskGateIndex = source.indexOf('this.riskGate(signal, strategy, riskAccount, riskSettings, riskOpenPositions, riskTrades, null, guardedAutoEnabled)');
  assert.ok(closeIndex >= 0);
  assert.ok(freshAccountIndex > closeIndex);
  assert.ok(freshPositionIndex > closeIndex);
  assert.ok(riskGateIndex > freshAccountIndex);
});
