import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsSupervisor } from '../worker/execution/delta-options-supervisor.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const GROUP_ID = '0dbf8d7e-5a2c-4be1-a9d7-0f4a2d380101';

function makeLeg(overrides = {}) {
  return {
    id: 12,
    group_id: GROUP_ID,
    leg_role: 'LONG_PREMIUM',
    product_id: 101,
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    requested_qty: 2,
    filled_qty: 1,
    exit_filled_qty: 0,
    order_state: 'PARTIALLY_FILLED',
    ...overrides
  };
}

function makeOrder(overrides = {}) {
  return {
    id: 55,
    group_id: GROUP_ID,
    leg_id: 12,
    leg_role: 'LONG_PREMIUM',
    intent: 'ENTRY',
    attempt_no: 1,
    product_id: 101,
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    requested_qty: 2,
    filled_qty: 1,
    limit_price: 100,
    reduce_only: false,
    order_state: 'CANCELLED',
    exchange_order_id: '7001',
    client_order_id: 'DDO-ABCD12345678-LP-1',
    created_at: new Date(NOW - 60_000).toISOString(),
    ...overrides
  };
}

function makeGroup(overrides = {}) {
  return {
    id: GROUP_ID,
    client_group_id: 'supervisor-group-12345',
    strategy: 'OPTIONS_BUY',
    state: 'OPEN',
    underlying_symbol: 'BTCUSD',
    expiry_at: new Date(NOW + 4 * 60 * 60 * 1000).toISOString(),
    created_at: new Date(NOW - 60_000).toISOString(),
    ...overrides
  };
}

function makeHarness({
  group = makeGroup(),
  legs = [makeLeg()],
  orders = [makeOrder()],
  positions = [{ symbol: 'C-BTC-90000-311026', product_id: 101, side: 'BUY', qty: 1 }],
  openOrders = [],
  orderLookupError = null,
  fillsError = null,
  snapshotError = null,
  now = NOW
} = {}) {
  const calls = { rpc: [], lookups: 0, reconciliations: 0 };
  const database = {
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name !== 'mark_dd_options_group_reconciliation_required') {
        throw new Error('Unexpected RPC: ' + name);
      }
      return {
        group_id: args.p_group_id,
        state: 'RECONCILIATION_REQUIRED',
        last_error_code: args.p_error_code
      };
    }
  };
  const manager = {
    async getActiveGroup() { return group; },
    async getGroupLegs() { return legs.map(row => ({ ...row })); },
    async getGroupOrders() { return orders.map(row => ({ ...row })); }
  };
  const executor = {
    assertConfigured() {},
    async getOpenOptionPositions() {
      if (snapshotError) throw snapshotError;
      return positions.map(row => ({ ...row }));
    },
    async getOpenOptionOrders() {
      if (snapshotError) throw snapshotError;
      return openOrders.map(row => ({ ...row }));
    },
    async getOptionOrderByClientId(id) {
      calls.lookups += 1;
      if (orderLookupError) throw orderLookupError;
      return {
        id: 7001,
        client_order_id: id,
        product_id: 101,
        product_symbol: 'C-BTC-90000-311026',
        side: 'buy',
        size: 2,
        state: 'open',
        unfilled_size: 1
      };
    },
    async getOptionFillsPage() {
      if (fillsError) throw fillsError;
      return { rows: [], after: null };
    }
  };
  const ledger = {
    async getAttempt(clientOrderId) {
      return orders.find(row => row.client_order_id === clientOrderId) || null;
    },
    async recordAcknowledgement(clientOrderId, ack) {
      const row = orders.find(item => item.client_order_id === clientOrderId);
      row.exchange_order_id = String(ack.id);
      // A successful lookup does not release an already locked attempt/group.
      if (String(row.order_state).toUpperCase() !== 'RECONCILIATION_REQUIRED') {
        row.order_state = 'OPEN';
      }
      return { ...row };
    },
    async reconcileFills(clientOrderId, args) {
      calls.reconciliations += 1;
      if (fillsError) throw fillsError;
      const row = orders.find(item => item.client_order_id === clientOrderId);
      return { ...row, raw: { fill_reconciliation: { status: 'COMPLETE' } } };
    },
    async markSubmissionUnknown(clientOrderId, error) {
      const row = orders.find(item => item.client_order_id === clientOrderId);
      if (row) row.order_state = 'RECONCILIATION_REQUIRED';
      calls.unknownError = String(error?.message || error);
      return row;
    }
  };
  const supervisor = createDeltaOptionsSupervisor({
    database, manager, executor, ledger, now: () => now
  });
  return { supervisor, calls, database, manager, executor, ledger };
}

test('reconciles a persisted position against exchange position, order and fill ledgers', async () => {
  const harness = makeHarness();
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.openQty, 1);
  assert.equal(harness.calls.reconciliations, 1);
  assert.equal(harness.calls.rpc.length, 0);
});

test('keeps a correctly tracked open IOC order pending without advancing the group', async () => {
  const openOrder = {
    id: '7001',
    client_order_id: 'DDO-ABCD12345678-LP-1',
    product_id: 101,
    product_symbol: 'C-BTC-90000-311026',
    side: 'buy',
    size: 2,
    state: 'open'
  };
  const harness = makeHarness({
    orders: [makeOrder({ order_state: 'OPEN' })],
    openOrders: [openOrder]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'ORDER_PENDING');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.pendingOrderCount, 1);
  assert.equal(harness.calls.rpc.length, 0);
});

test('locks an active ledger order that is missing from the exchange open-order snapshot', async () => {
  const harness = makeHarness({
    orders: [makeOrder({ order_state: 'OPEN' })],
    openOrders: []
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_ORDER_RECOVERY_UNRESOLVED');
});

test('parks the group when exchange position quantity differs from the durable fill ledger', async () => {
  const harness = makeHarness({
    positions: [{ symbol: 'C-BTC-90000-311026', product_id: 101, side: 'BUY', qty: 2 }]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_POSITION_RECONCILIATION_FAILED');
});

test('parks an untracked exchange open order before any further progression', async () => {
  const harness = makeHarness({
    openOrders: [{
      id: '9001',
      client_order_id: 'UNTRACKED-ORDER',
      product_id: 101,
      product_symbol: 'C-BTC-90000-311026',
      side: 'buy',
      size: 1,
      state: 'open'
    }]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_UNTRACKED_EXCHANGE_ORDER');
});

test('does not assume an unresolved reserved client order was never submitted', async () => {
  const order = makeOrder({ exchange_order_id: null, order_state: 'RESERVED' });
  const harness = makeHarness({
    orders: [order],
    orderLookupError: new Error('Delta Testnet Options GET /v2/orders/client_order_id failed (404): not_found')
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(harness.calls.lookups, 1);
  assert.equal(harness.calls.unknownError.includes('404'), true);
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_ORDER_RECOVERY_UNRESOLVED');
});

test('uses the exchange client-order lookup to recover a persisted reservation after restart', async () => {
  const order = makeOrder({ exchange_order_id: null, order_state: 'RESERVED' });
  const harness = makeHarness({
    orders: [order],
    openOrders: [{
      id: '7001',
      client_order_id: 'DDO-ABCD12345678-LP-1',
      product_id: 101,
      product_symbol: 'C-BTC-90000-311026',
      side: 'buy',
      size: 2,
      state: 'open'
    }]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'ORDER_PENDING');
  assert.equal(harness.calls.lookups, 1);
  assert.equal(harness.calls.reconciliations, 1);
});

test('requires expiry exit before settlement and durably locks the active group', async () => {
  const expiry = NOW + 20 * 60 * 1000;
  const harness = makeHarness({
    group: makeGroup({ expiry_at: new Date(expiry).toISOString() })
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'EXPIRY_EXIT_REQUIRED');
  assert.equal(result.executionEnabled, false);
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_EXPIRY_EXIT_REQUIRED');
});

test('does not label an empty exchange snapshot safe when no active ledger group exists but exchange exposure remains', async () => {
  const harness = makeHarness({
    group: null,
    legs: [],
    orders: [],
    positions: [{ symbol: 'C-BTC-90000-311026', product_id: 101, side: 'BUY', qty: 1 }]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'ORPHAN_EXCHANGE_EXPOSURE');
  assert.equal(result.executionEnabled, false);
  assert.equal(harness.calls.rpc.length, 0);
});

test('reports no active group only when both exchange positions and open orders are empty', async () => {
  const harness = makeHarness({ group: null, legs: [], orders: [], positions: [], openOrders: [] });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'NO_ACTIVE_GROUP');
  assert.equal(result.positionCount, 0);
  assert.equal(result.openOrderCount, 0);
});

test('durably parks an active group when private exchange snapshots are unavailable', async () => {
  const harness = makeHarness({ snapshotError: new Error('private options API timeout') });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.executionEnabled, false);
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_EXCHANGE_SNAPSHOT_UNAVAILABLE');
});

test('coalesces overlapping supervisor cycles into one exchange/database reconciliation', async () => {
  const harness = makeHarness();
  const first = harness.supervisor.reconcileOnce();
  const second = harness.supervisor.reconcileOnce();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(harness.calls.reconciliations, 1);
});


test('continues exact client-order lookup for a locked attempt but does not auto-unlock it', async () => {
  const order = makeOrder({
    exchange_order_id: null,
    order_state: 'RECONCILIATION_REQUIRED'
  });
  const harness = makeHarness({
    orders: [order],
    openOrders: [{
      id: '7001',
      client_order_id: 'DDO-ABCD12345678-LP-1',
      product_id: 101,
      product_symbol: 'C-BTC-90000-311026',
      side: 'buy',
      size: 2,
      state: 'open'
    }]
  });
  const result = await harness.supervisor.reconcileOnce();
  assert.equal(harness.calls.lookups, 1);
  assert.equal(harness.calls.reconciliations, 1);
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.executionEnabled, false);
  assert.equal(order.order_state, 'RECONCILIATION_REQUIRED');
  assert.equal(order.exchange_order_id, '7001');
  assert.equal(harness.calls.rpc[0].args.p_error_code, 'OPTIONS_ORDER_TERMINALITY_UNVERIFIED');
});
