import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsExpirySupervisor } from '../worker/execution/delta-options-expiry-supervisor.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const GROUP_ID = '0dbf8d7e-5a2c-4be1-a9d7-0f4a2d380101';
const DEADLINE = new Date(NOW - 60_000).toISOString();

function makeGroup(overrides = {}) {
  return {
    id: GROUP_ID,
    state: 'EXIT_REQUIRED',
    strategy: 'OPTIONS_BUY',
    expiry_at: new Date(NOW + 29 * 60_000).toISOString(),
    ...overrides
  };
}
function longLeg(overrides = {}) {
  return {
    group_id: GROUP_ID,
    leg_role: 'LONG_PREMIUM',
    side: 'BUY',
    requested_qty: 2,
    filled_qty: 2,
    exit_filled_qty: 0,
    tick_size: 0.5,
    ...overrides
  };
}
function spreadLegs() {
  return [
    {
      group_id: GROUP_ID,
      leg_role: 'PROTECTIVE_WING',
      side: 'BUY',
      requested_qty: 2,
      filled_qty: 2,
      exit_filled_qty: 0,
      tick_size: 0.5
    },
    {
      group_id: GROUP_ID,
      leg_role: 'SHORT_OPTION',
      side: 'SELL',
      requested_qty: 2,
      filled_qty: 2,
      exit_filled_qty: 0,
      tick_size: 0.5
    }
  ];
}
function fillOrder(role, qty = 2) {
  return {
    leg_role: role,
    intent: 'ENTRY',
    order_state: 'FILLED',
    attempt_no: 1,
    filled_qty: qty
  };
}
function quotes() {
  return {
    LONG_PREMIUM: { bid: 99, ask: 100, updatedAt: new Date(NOW - 1_000).toISOString() },
    PROTECTIVE_WING: { bid: 9, ask: 10, updatedAt: new Date(NOW - 1_000).toISOString() },
    SHORT_OPTION: { bid: 19, ask: 20, updatedAt: new Date(NOW - 1_000).toISOString() }
  };
}
function makeHarness({
  group = makeGroup(),
  legs = [longLeg()],
  orders = [fillOrder('LONG_PREMIUM')],
  quoteMap = quotes(),
  quoteError = null,
  now = NOW
} = {}) {
  const calls = { active: 0, legs: 0, orders: 0, quotes: 0 };
  const manager = {
    async getActiveGroup() { calls.active += 1; return group; },
    async getGroupLegs() { calls.legs += 1; return legs; },
    async getGroupOrders() { calls.orders += 1; return orders; }
  };
  const supervisor = createDeltaOptionsExpirySupervisor({
    manager,
    async getQuotes() {
      calls.quotes += 1;
      if (quoteError) throw quoteError;
      return quoteMap;
    },
    now: () => now,
    minutesBeforeExpiry: 30,
    maxQuoteAgeMs: 5_000
  });
  return { supervisor, calls };
}

test('does not inspect or plan exits before the pre-expiry deadline', async () => {
  const harness = makeHarness({
    group: makeGroup({ expiry_at: new Date(NOW + 2 * 60 * 60_000).toISOString() })
  });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'NOT_DUE');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.submitted, false);
  assert.equal(harness.calls.legs, 0);
  assert.equal(harness.calls.quotes, 0);
});

test('requires the restart supervisor to durably set EXIT_REQUIRED first', async () => {
  const harness = makeHarness({ group: makeGroup({ state: 'OPEN' }) });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'EXIT_REQUIRED_STATE_NOT_MARKED');
  assert.equal(result.submitted, false);
  assert.equal(harness.calls.legs, 0);
});

test('plans long-premium reduce-only SELL from a fresh quote only', async () => {
  const harness = makeHarness();
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'EXIT_ACTION_READY');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.action.legRole, 'LONG_PREMIUM');
  assert.equal(result.action.intent, 'EXIT');
  assert.equal(result.action.side, 'SELL');
  assert.equal(result.action.reduceOnly, true);
});

test('plans short BUY cover before any protective wing close for a credit spread', async () => {
  const harness = makeHarness({
    group: makeGroup({ strategy: 'OPTIONS_SELL' }),
    legs: spreadLegs(),
    orders: [fillOrder('PROTECTIVE_WING'), fillOrder('SHORT_OPTION')]
  });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'EXIT_ACTION_READY');
  assert.equal(result.action.legRole, 'SHORT_OPTION');
  assert.equal(result.action.intent, 'EXIT');
  assert.equal(result.action.side, 'BUY');
  assert.equal(result.action.reduceOnly, true);
});

test('does not create an exit action from stale quotes', async () => {
  const quoteMap = quotes();
  quoteMap.LONG_PREMIUM.updatedAt = new Date(NOW - 60_000).toISOString();
  const harness = makeHarness({ quoteMap });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'EXIT_WAITING_FOR_FRESH_QUOTE');
  assert.equal(result.submitted, false);
});

test('quote source failures stay read-only and return a blocked exit status', async () => {
  const harness = makeHarness({ quoteError: new Error('quote feed unavailable') });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'EXIT_WAITING_FOR_FRESH_QUOTE');
  assert.match(result.reason, /quote feed unavailable/);
  assert.equal(result.submitted, false);
});

test('reconciliation-locked groups cannot enter the expiry exit planner', async () => {
  const harness = makeHarness({ group: makeGroup({ state: 'RECONCILIATION_REQUIRED' }) });
  const result = await harness.supervisor.reviewOnce();
  assert.equal(result.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.submitted, false);
  assert.equal(harness.calls.legs, 0);
});

test('coalesces overlapping expiry reviews and never invokes an order coordinator', async () => {
  const harness = makeHarness();
  const [a, b] = await Promise.all([
    harness.supervisor.reviewOnce(),
    harness.supervisor.reviewOnce()
  ]);
  assert.deepEqual(a, b);
  assert.equal(harness.calls.active, 1);
  assert.equal(harness.calls.legs, 1);
  assert.equal(harness.calls.orders, 1);
  assert.equal(harness.calls.quotes, 1);
  assert.equal(a.submitted, false);
});
