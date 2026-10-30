import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsOrderCoordinator } from '../worker/execution/delta-options-order-coordinator.mjs';
import { makeOptionsClientOrderId } from '../worker/execution/delta-options-execution-policy.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const GROUP_ID = '0dbf8d7e-5a2c-4be1-a9d7-0f4a2d380101';
const CLIENT_ID = makeOptionsClientOrderId(GROUP_ID, 'LONG_PREMIUM', 1);

function makeHarness({
  reservation = {},
  attempt = {},
  submitError = null,
  lookupError = null,
  fillError = null,
  lockError = null
} = {}) {
  const calls = [];
  const baseReservation = {
    order_attempt_id: 41,
    group_id: GROUP_ID,
    leg_id: 7,
    leg_role: 'LONG_PREMIUM',
    intent: 'ENTRY',
    attempt_no: 1,
    product_id: 101,
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    qty: 2,
    limit_price: 100,
    reduce_only: false,
    client_order_id: CLIENT_ID,
    order_state: 'RESERVED'
  };
  const row = {
    id: 41,
    group_id: GROUP_ID,
    leg_id: 7,
    leg_role: 'LONG_PREMIUM',
    intent: 'ENTRY',
    attempt_no: 1,
    product_id: 101,
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    requested_qty: 2,
    limit_price: 100,
    reduce_only: false,
    client_order_id: CLIENT_ID,
    order_state: 'RESERVED',
    exchange_order_id: null,
    acknowledged_filled_qty: 0,
    filled_qty: 0,
    average_fill_price: null,
    created_at: new Date(NOW - 5_000).toISOString(),
    ...attempt
  };
  const manager = {
    assertExecutionAllowed() {
      calls.push('execution-gate');
      if (lockError) throw lockError;
    },
    async reserveOrderAttempt(input) {
      calls.push({ reserve: input });
      return { ...baseReservation, ...reservation };
    },
    async recordOrderAcknowledgement(input) {
      calls.push({ reconciliationLock: input });
      row.order_state = 'RECONCILIATION_REQUIRED';
      return { order_attempt_id: row.id, reconciliation_required: true };
    }
  };
  const acknowledgement = {
    id: '9001',
    client_order_id: CLIENT_ID,
    product_id: 101,
    product_symbol: 'C-BTC-90000-311026',
    side: 'buy',
    size: 2,
    unfilled_size: 0,
    state: 'closed'
  };
  const executor = {
    assertConfigured() { calls.push('configured'); },
    async placeOptionOrder(input) {
      calls.push({ place: input });
      if (submitError) throw submitError;
      return acknowledgement;
    },
    async getOptionOrderByClientId(clientOrderId) {
      calls.push({ lookup: clientOrderId });
      if (lookupError) throw lookupError;
      assert.equal(clientOrderId, CLIENT_ID);
      return acknowledgement;
    }
  };
  const ledger = {
    async getAttempt(clientOrderId) {
      calls.push({ getAttempt: clientOrderId });
      assert.equal(clientOrderId, CLIENT_ID);
      return { ...row };
    },
    async recordAcknowledgement(clientOrderId, ack) {
      calls.push({ recordAck: { clientOrderId, ack } });
      row.exchange_order_id = String(ack.id);
      row.order_state = ack.state === 'rejected' ? 'REJECTED' : 'SUBMITTED';
      return { ...row };
    },
    async markSubmissionUnknown(clientOrderId, error) {
      calls.push({ unknown: { clientOrderId, error: String(error.message) } });
      row.order_state = 'RECONCILIATION_REQUIRED';
      return { ...row };
    },
    async reconcileFills(clientOrderId, input) {
      calls.push({ reconcileFills: { clientOrderId, input } });
      if (fillError) throw fillError;
      row.order_state = 'FILLED';
      row.filled_qty = 2;
      row.average_fill_price = 99.5;
      return { ...row };
    }
  };
  const coordinator = createDeltaOptionsOrderCoordinator({
    manager, executor, ledger, now: () => NOW
  });
  return { coordinator, calls, row, manager, executor, ledger };
}

const INPUT = {
  groupId: GROUP_ID,
  legRole: 'LONG_PREMIUM',
  intent: 'ENTRY',
  attemptNo: 1,
  limitPrice: 100
};

test('submits only after a fresh durable reservation is read back exactly', async () => {
  const harness = makeHarness();
  const result = await harness.coordinator.submit(INPUT);
  const reserveIndex = harness.calls.findIndex(item => item.reserve);
  const readIndex = harness.calls.findIndex(item => item.getAttempt);
  const submitIndex = harness.calls.findIndex(item => item.place);
  assert.ok(reserveIndex >= 0 && readIndex > reserveIndex && submitIndex > readIndex);
  assert.equal(result.status, 'FILLED');
  assert.equal(result.orderAttemptId, 41);
  assert.equal(result.filledQty, 2);
  assert.equal(result.exchangeOrderId, '9001');
  const place = harness.calls[submitIndex].place;
  assert.deepEqual(place, {
    symbol: 'C-BTC-90000-311026',
    side: 'BUY',
    qty: 2,
    limitPrice: 100,
    clientOrderId: CLIENT_ID,
    reduceOnly: false
  });
});

test('a reservation recovered after an ambiguous RPC is never blindly submitted', async () => {
  const harness = makeHarness({ reservation: { recoveredAfterAmbiguousRpc: true } });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'RECOVERED_RESERVATION_NOT_RESUBMITTED');
  assert.equal(result.blindRetryProhibited, true);
  assert.equal(harness.calls.some(item => item.place), false);
  assert.equal(harness.calls.some(item => item.getAttempt), false);
});

test('a pre-existing non-RESERVED attempt is read-only and is never submitted again', async () => {
  const harness = makeHarness({ attempt: { order_state: 'OPEN', exchange_order_id: '9001' } });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'ORDER_PENDING');
  assert.equal(result.blindRetryProhibited, true);
  assert.equal(harness.calls.some(item => item.place), false);
});

test('a mismatched reservation is durably parked and never reaches the exchange', async () => {
  const harness = makeHarness({ reservation: { qty: 3 } });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.reservationMismatch, true);
  assert.equal(harness.calls.some(item => item.place), false);
  assert.equal(harness.calls.some(item => item.reconciliationLock), true);
});

test('an ambiguous POST is recovered only by the exact client-order lookup', async () => {
  const harness = makeHarness({ submitError: new Error('socket timeout') });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'FILLED');
  assert.equal(result.recoveredByExactClientOrderLookup, true);
  assert.equal(harness.calls.filter(item => item.place).length, 1);
  assert.equal(harness.calls.filter(item => item.lookup).length, 1);
  assert.equal(harness.calls.some(item => item.unknown), false);
});

test('an unresolved POST and client-order lookup are durably locked without a retry', async () => {
  const harness = makeHarness({
    submitError: new Error('socket timeout'),
    lookupError: new Error('404 not found')
  });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.ambiguousSubmission, true);
  assert.equal(result.blindRetryProhibited, true);
  assert.equal(harness.calls.filter(item => item.place).length, 1);
  assert.equal(harness.calls.filter(item => item.lookup).length, 1);
  assert.equal(harness.calls.filter(item => item.unknown).length, 1);
});

test('fill reconciliation failure parks the durable order and group', async () => {
  const harness = makeHarness({ fillError: new Error('fills endpoint timeout') });
  const result = await harness.coordinator.submit(INPUT);
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.fillReconciliationError, 'fills endpoint timeout');
  assert.equal(harness.calls.some(item => item.reconciliationLock), true);
});

test('source-code execution gate rejects before configuration, reservation or exchange access', async () => {
  const harness = makeHarness({ lockError: new Error('Options execution locked') });
  await assert.rejects(harness.coordinator.submit(INPUT), /Options execution locked/);
  assert.equal(harness.calls.includes('configured'), false);
  assert.equal(harness.calls.some(item => item.reserve), false);
  assert.equal(harness.calls.some(item => item.place), false);
});

test('serializes order requests for the same execution group', async () => {
  let release;
  const harness = makeHarness();
  harness.manager.reserveOrderAttempt = async input => {
    harness.calls.push({ reserve: input });
    await new Promise(resolve => { release = resolve; });
    return {
      order_attempt_id: 41, group_id: GROUP_ID, leg_id: 7,
      leg_role: 'LONG_PREMIUM', intent: 'ENTRY', attempt_no: 1,
      product_id: 101, symbol: 'C-BTC-90000-311026', side: 'BUY',
      qty: 2, limit_price: 100, reduce_only: false,
      client_order_id: CLIENT_ID, order_state: 'RESERVED'
    };
  };
  const first = harness.coordinator.submit(INPUT);
  await Promise.resolve();
  await assert.rejects(
    harness.coordinator.submit({ ...INPUT, limitPrice: 101 }),
    /Another Options order request is already running/
  );
  release();
  await first;
});
