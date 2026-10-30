import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeltaOptionsLifecycle } from '../worker/execution/delta-options-lifecycle.mjs';
import { getOptionsOrderClientIdRole, makeOptionsClientOrderId } from '../worker/execution/delta-options-execution-policy.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const GROUP = {
  id: '0dbf8d7e-5a2c-4be1-a9d7-0f4a2d380101',
  state: 'RESERVED',
  strategy: 'OPTIONS_BUY'
};
const QUOTES = {
  LONG_PREMIUM: { bid: 99, ask: 100, updatedAt: new Date(NOW - 1000).toISOString() },
  PROTECTIVE_WING: { bid: 9, ask: 10, updatedAt: new Date(NOW - 1000).toISOString() },
  SHORT_OPTION: { bid: 19, ask: 20, updatedAt: new Date(NOW - 1000).toISOString() }
};

function longLeg(overrides = {}) {
  return {
    group_id: GROUP.id, leg_role: 'LONG_PREMIUM', side: 'BUY',
    requested_qty: 2, filled_qty: 0, exit_filled_qty: 0, tick_size: 0.5,
    ...overrides
  };
}
function spreadLegs({ protective = {}, short = {} } = {}) {
  return [
    {
      group_id: GROUP.id, leg_role: 'PROTECTIVE_WING', side: 'BUY',
      requested_qty: 3, filled_qty: 0, exit_filled_qty: 0, tick_size: 0.5,
      ...protective
    },
    {
      group_id: GROUP.id, leg_role: 'SHORT_OPTION', side: 'SELL',
      requested_qty: 3, filled_qty: 0, exit_filled_qty: 0, tick_size: 0.5,
      ...short
    }
  ];
}
function order(role, intent, state, filledQty, attemptNo = 1) {
  return {
    leg_role: role, intent, order_state: state, filled_qty: filledQty,
    attempt_no: attemptNo
  };
}
const plan = (overrides = {}) => planDeltaOptionsLifecycle({
  group: GROUP, legs: [longLeg()], orders: [], quotes: QUOTES,
  entrySignalReady: true, now: NOW, ...overrides
});

test('long-premium BUY/PUT entry requires a ready signal and fresh quote', () => {
  const result = plan({ entrySignalReady: false });
  assert.equal(result.status, 'WAITING_FOR_CONFIRMED_ENTRY');
  const ready = plan();
  assert.equal(ready.status, 'ACTION_READY');
  assert.equal(ready.nextAction.legRole, 'LONG_PREMIUM');
  assert.equal(ready.nextAction.intent, 'ENTRY');
  assert.equal(ready.nextAction.side, 'BUY');
  assert.equal(ready.nextAction.limitPrice, 100);
  assert.equal(ready.nextAction.reduceOnly, false);
});

test('long-premium entry waits for an unresolved IOC and never duplicates it', () => {
  const result = plan({
    orders: [order('LONG_PREMIUM', 'ENTRY', 'PARTIALLY_FILLED', 1)]
  });
  assert.equal(result.status, 'ORDER_PENDING');
});

test('long-premium exit uses reduce-only SELL after exit request or expiry deadline', () => {
  const result = plan({
    legs: [longLeg({ filled_qty: 2 })],
    orders: [order('LONG_PREMIUM', 'ENTRY', 'FILLED', 2)],
    exitRequested: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.intent, 'EXIT');
  assert.equal(result.nextAction.side, 'SELL');
  assert.equal(result.nextAction.reduceOnly, true);
  assert.equal(result.nextAction.limitPrice, 99);
});

test('long-premium exit retries only after a terminal partial IOC', () => {
  const result = plan({
    legs: [longLeg({ filled_qty: 2 })],
    orders: [
      order('LONG_PREMIUM', 'ENTRY', 'FILLED', 2),
      order('LONG_PREMIUM', 'EXIT', 'CANCELLED', 1)
    ],
    expiryExitDue: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.intent, 'EXIT');
  assert.equal(result.nextAction.attemptNo, 2);
});

test('SELL spread always starts with protective BUY; no short SELL is planned first', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL' },
    legs: spreadLegs(),
    orders: [],
    entrySignalReady: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'PROTECTIVE_WING');
  assert.equal(result.nextAction.side, 'BUY');
});

test('SELL spread short SELL waits for terminal protective BUY and uses persisted fill authority', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL' },
    legs: spreadLegs({ protective: { filled_qty: 2 } }),
    orders: [order('PROTECTIVE_WING', 'ENTRY', 'CANCELLED', 2)]
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'SHORT_OPTION');
  assert.equal(result.nextAction.intent, 'ENTRY');
  assert.equal(result.nextAction.side, 'SELL');
});

test('partial short fill schedules unwind of unmatched protective quantity only', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL', state: 'SHORT_ENTRY_PENDING' },
    legs: spreadLegs({ protective: { filled_qty: 3 }, short: { filled_qty: 2 } }),
    orders: [
      order('PROTECTIVE_WING', 'ENTRY', 'FILLED', 3),
      order('SHORT_OPTION', 'ENTRY', 'CANCELLED', 2)
    ]
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'PROTECTIVE_WING');
  assert.equal(result.nextAction.intent, 'UNWIND');
  assert.equal(result.nextAction.side, 'SELL');
  assert.equal(result.nextAction.reduceOnly, true);
});

test('short-first exit: short BUY is planned before protective wing SELL', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL', state: 'OPEN' },
    legs: spreadLegs({ protective: { filled_qty: 2 }, short: { filled_qty: 2 } }),
    orders: [
      order('PROTECTIVE_WING', 'ENTRY', 'FILLED', 2),
      order('SHORT_OPTION', 'ENTRY', 'FILLED', 2)
    ],
    exitRequested: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'SHORT_OPTION');
  assert.equal(result.nextAction.intent, 'EXIT');
  assert.equal(result.nextAction.side, 'BUY');
  assert.equal(result.nextAction.reduceOnly, true);
});

test('protective wing cannot be sold while any short quantity remains', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL', state: 'OPEN' },
    legs: spreadLegs({
      protective: { filled_qty: 2, exit_filled_qty: 0 },
      short: { filled_qty: 2, exit_filled_qty: 1 }
    }),
    orders: [
      order('PROTECTIVE_WING', 'ENTRY', 'FILLED', 2),
      order('SHORT_OPTION', 'ENTRY', 'FILLED', 2),
      order('SHORT_OPTION', 'EXIT', 'CANCELLED', 1)
    ],
    exitRequested: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'SHORT_OPTION');
  assert.equal(result.nextAction.intent, 'EXIT');
  assert.equal(result.nextAction.attemptNo, 2);
});

test('after confirmed short-flat, protective wing may be closed', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL', state: 'OPEN' },
    legs: spreadLegs({
      protective: { filled_qty: 2, exit_filled_qty: 0 },
      short: { filled_qty: 2, exit_filled_qty: 2 }
    }),
    orders: [
      order('PROTECTIVE_WING', 'ENTRY', 'FILLED', 2),
      order('SHORT_OPTION', 'ENTRY', 'FILLED', 2),
      order('SHORT_OPTION', 'EXIT', 'FILLED', 2)
    ],
    expiryExitDue: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'PROTECTIVE_WING');
  assert.equal(result.nextAction.intent, 'EXIT');
  assert.equal(result.nextAction.side, 'SELL');
});

test('stale quote blocks all planned order actions', () => {
  const result = plan({
    quotes: {
      LONG_PREMIUM: { bid: 99, ask: 100, updatedAt: new Date(NOW - 20_000).toISOString() }
    }
  });
  assert.equal(result.status, 'WAITING_FOR_FRESH_QUOTE');
});

test('durable reconciliation lock and malformed fill balances fail closed', () => {
  const locked = plan({ group: { ...GROUP, state: 'RECONCILIATION_REQUIRED' } });
  assert.equal(locked.status, 'RECONCILIATION_REQUIRED');
  const malformed = plan({ legs: [longLeg({ exit_filled_qty: 1, filled_qty: 0 })] });
  assert.equal(malformed.status, 'RECONCILIATION_REQUIRED');
});

test('protective UNWIND and normal EXIT use different immutable client-order IDs', () => {
  const unwindRole = getOptionsOrderClientIdRole('UNWIND', 'PROTECTIVE_WING');
  const exitRole = getOptionsOrderClientIdRole('EXIT', 'PROTECTIVE_WING');
  assert.equal(unwindRole, 'UNWIND_WING');
  assert.equal(exitRole, 'CLOSE_WING');
  assert.notEqual(
    makeOptionsClientOrderId(GROUP.id, unwindRole, 1),
    makeOptionsClientOrderId(GROUP.id, exitRole, 1)
  );
});

test('expiry exit unwinds a protective-only credit-spread leg and never opens the short', () => {
  const result = plan({
    group: { ...GROUP, strategy: 'OPTIONS_SELL', state: 'EXIT_REQUIRED' },
    legs: spreadLegs({ protective: { filled_qty: 2 } }),
    orders: [order('PROTECTIVE_WING', 'ENTRY', 'CANCELLED', 2)],
    expiryExitDue: true
  });
  assert.equal(result.status, 'ACTION_READY');
  assert.equal(result.nextAction.legRole, 'PROTECTIVE_WING');
  assert.equal(result.nextAction.intent, 'UNWIND');
  assert.equal(result.nextAction.side, 'SELL');
  assert.equal(result.nextAction.reduceOnly, true);
});

test('EXIT_REQUIRED blocks all new entries unless explicit expiry exit planning is active', () => {
  const result = plan({
    group: { ...GROUP, state: 'EXIT_REQUIRED' },
    entrySignalReady: true
  });
  assert.equal(result.status, 'EXIT_REQUIRED');
  assert.equal(result.exitOnly, true);
});
