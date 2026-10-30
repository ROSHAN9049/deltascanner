import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isActiveOptionsExecutionState,
  makeOptionsClientOrderId,
  resolveCreditSpreadEntryProgress,
  resolveCreditSpreadExitProgress,
  resolveOptionExpiryExitDeadline,
  validateCreditSpreadEntryPlan,
  validateLongOptionEntryPlan
} from '../worker/execution/delta-options-execution-policy.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);

function ticker(symbol, optionType, productId) {
  return {
    symbol,
    underlying: 'BTC',
    product_id: productId,
    contract_type: optionType === 'CALL' ? 'call_options' : 'put_options',
    contract_value: '0.001',
    tick_size: '0.0001',
    state: 'live',
    testnet_product_verified: true
  };
}

test('long option plan requires a verified Testnet product and matching direction', () => {
  const call = ticker('C-BTC-90000-311026', 'CALL', 101);
  const plan = validateLongOptionEntryPlan({
    ticker: call,
    underlyingSide: 'BUY',
    qty: 2,
    maxLossUsd: 4,
    now: NOW
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.strategy, 'OPTIONS_BUY');
  assert.equal(plan.legs[0].role, 'LONG_PREMIUM');
  assert.equal(plan.legs[0].side, 'BUY');
  assert.equal(plan.legs[0].qty, 2);
  assert.deepEqual(plan.entrySequence, ['LONG_PREMIUM']);

  assert.equal(validateLongOptionEntryPlan({
    ticker: call, underlyingSide: 'SELL', qty: 2, maxLossUsd: 4, now: NOW
  }).valid, false);
  assert.equal(validateLongOptionEntryPlan({
    ticker: { ...call, testnet_product_verified: false },
    underlyingSide: 'BUY', qty: 2, maxLossUsd: 4, now: NOW
  }).valid, false);
});

test('long option plan fails closed for bad quantity, risk, product id or expiry', () => {
  const base = ticker('P-BTC-85000-311026', 'PUT', 102);
  const invalid = [
    { qty: 0 },
    { qty: 1.5 },
    { maxLossUsd: 0 },
    { ticker: { ...base, product_id: 0 } },
    { ticker: { ...base, state: 'expired' } },
    { ticker: ticker('P-BTC-85000-291026', 'PUT', 103) }
  ];
  for (const item of invalid) {
    const plan = validateLongOptionEntryPlan({
      ticker: base, underlyingSide: 'SELL', qty: 1, maxLossUsd: 2, now: NOW, ...item
    });
    assert.equal(plan.valid, false);
  }
});

test('bearish credit spread plan buys higher-strike CALL protection before selling CALL', () => {
  const short = ticker('C-BTC-90000-311026', 'CALL', 201);
  const wing = ticker('C-BTC-95000-311026', 'CALL', 202);
  const plan = validateCreditSpreadEntryPlan({
    shortTicker: short,
    protectiveTicker: wing,
    underlyingSide: 'SELL',
    qty: 2,
    maxLossUsd: 25,
    now: NOW
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.strategy, 'OPTIONS_SELL');
  assert.equal(plan.legs[0].role, 'PROTECTIVE_WING');
  assert.equal(plan.legs[0].side, 'BUY');
  assert.equal(plan.legs[1].role, 'SHORT_OPTION');
  assert.equal(plan.legs[1].side, 'SELL');
  assert.deepEqual(plan.entrySequence, ['PROTECTIVE_WING', 'SHORT_OPTION']);
});

test('bullish credit spread plan buys lower-strike PUT protection before selling PUT', () => {
  const short = ticker('P-BTC-90000-311026', 'PUT', 211);
  const wing = ticker('P-BTC-85000-311026', 'PUT', 212);
  const plan = validateCreditSpreadEntryPlan({
    shortTicker: short,
    protectiveTicker: wing,
    underlyingSide: 'BUY',
    qty: 1,
    maxLossUsd: 12,
    now: NOW
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.legs[0].strike, 85000);
  assert.equal(plan.legs[1].strike, 90000);
});

test('credit spread plan rejects mismatched expiry, type, multiplier, direction or unsafe wing', () => {
  const short = ticker('C-BTC-90000-311026', 'CALL', 301);
  const invalidWings = [
    ticker('C-BTC-95000-011126', 'CALL', 302),
    ticker('P-BTC-85000-311026', 'PUT', 303),
    { ...ticker('C-BTC-95000-311026', 'CALL', 304), contract_value: '0.01' },
    ticker('C-BTC-85000-311026', 'CALL', 305),
    { ...ticker('C-BTC-95000-311026', 'CALL', 306), testnet_product_verified: false },
    { ...ticker('C-BTC-95000-311026', 'CALL', 307), tick_size: 0 }
  ];
  for (const protectiveTicker of invalidWings) {
    const plan = validateCreditSpreadEntryPlan({
      shortTicker: short, protectiveTicker, underlyingSide: 'SELL',
      qty: 1, maxLossUsd: 5, now: NOW
    });
    assert.equal(plan.valid, false);
  }
  assert.equal(validateCreditSpreadEntryPlan({
    shortTicker: short,
    protectiveTicker: invalidWings[3],
    underlyingSide: 'BUY',
    qty: 1, maxLossUsd: 5, now: NOW
  }).valid, false);
});

test('spread entry never submits short until protective BUY is terminal and filled', () => {
  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'OPEN', protectiveFilledQty: 0
  }).state, 'HEDGE_ENTRY_PENDING');

  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'UNKNOWN', protectiveFilledQty: 1
  }).state, 'RECONCILIATION_REQUIRED');

  const ready = resolveCreditSpreadEntryProgress({
    protectiveState: 'CANCELLED', protectiveFilledQty: 3
  });
  assert.equal(ready.state, 'SHORT_ENTRY_READY');
  assert.equal(ready.shortOrderQty, 3);
});

test('zero or ambiguous short fills require a protective-leg unwind or reconciliation', () => {
  const unwind = resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 2,
    shortSubmitted: true,
    shortState: 'CANCELLED',
    shortFilledQty: 0
  });
  assert.equal(unwind.state, 'UNWIND_PENDING');
  assert.equal(unwind.unwindQty, 2);
  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 2,
    shortSubmitted: true,
    shortState: 'CANCELLED',
    shortFilledQty: 0,
    protectiveFullUnwindConfirmed: true
  }).state, 'REJECTED');
  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 2,
    shortSubmitted: true,
    shortState: 'UNKNOWN',
    shortFilledQty: 0
  }).state, 'RECONCILIATION_REQUIRED');
});

test('partial short fill unwinds only excess protective quantity before opening matched spread', () => {
  const unwind = resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 5,
    shortSubmitted: true,
    shortState: 'CANCELLED',
    shortFilledQty: 3
  });
  assert.equal(unwind.state, 'UNWIND_PENDING');
  assert.equal(unwind.unwindQty, 2);
  assert.equal(unwind.matchedQty, 3);

  const opened = resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 5,
    shortSubmitted: true,
    shortState: 'CANCELLED',
    shortFilledQty: 3,
    protectiveExcessUnwound: true
  });
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.matchedQty, 3);
});

test('spread entry requires exact fill evidence and cannot overfill the short leg', () => {
  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 2,
    shortSubmitted: true,
    shortState: 'FILLED',
    shortFilledQty: 3
  }).state, 'RECONCILIATION_REQUIRED');
  assert.equal(resolveCreditSpreadEntryProgress({
    protectiveState: 'FILLED',
    protectiveFilledQty: 2,
    shortSubmitted: true,
    shortState: 'OPEN',
    shortFilledQty: 1
  }).state, 'SHORT_ENTRY_PENDING');
});

test('spread exit always covers short first and never sells hedge while short remains', () => {
  const first = resolveCreditSpreadExitProgress({
    shortPositionQty: 3,
    protectivePositionQty: 3
  });
  assert.equal(first.state, 'SHORT_EXIT_PENDING');
  assert.equal(first.nextRole, 'SHORT_OPTION');
  assert.equal(first.nextSide, 'BUY');
  assert.equal(first.nextQty, 3);

  const partial = resolveCreditSpreadExitProgress({
    shortPositionQty: 3,
    shortCloseSubmitted: true,
    shortCloseState: 'CANCELLED',
    shortCloseFilledQty: 2,
    protectivePositionQty: 3
  });
  assert.equal(partial.state, 'SHORT_EXIT_PENDING');
  assert.equal(partial.nextQty, 1);
  assert.equal(partial.nextSide, 'BUY');
  assert.equal(partial.nextRole, 'SHORT_OPTION');
});

test('protective wing exit begins only after the short is confirmed flat', () => {
  const wingExit = resolveCreditSpreadExitProgress({
    shortPositionQty: 2,
    shortCloseSubmitted: true,
    shortCloseState: 'FILLED',
    shortCloseFilledQty: 2,
    protectivePositionQty: 2
  });
  assert.equal(wingExit.state, 'HEDGE_EXIT_PENDING');
  assert.equal(wingExit.nextRole, 'PROTECTIVE_WING');
  assert.equal(wingExit.nextSide, 'SELL');
  assert.equal(wingExit.nextQty, 2);

  const closed = resolveCreditSpreadExitProgress({
    shortPositionQty: 2,
    shortCloseSubmitted: true,
    shortCloseState: 'FILLED',
    shortCloseFilledQty: 2,
    protectivePositionQty: 2,
    protectiveCloseSubmitted: true,
    protectiveCloseState: 'CANCELLED',
    protectiveCloseFilledQty: 2
  });
  assert.equal(closed.state, 'CLOSED');
});

test('unknown or excess exit fills block the spread as reconciliation-required', () => {
  assert.equal(resolveCreditSpreadExitProgress({
    shortPositionQty: 2,
    shortCloseSubmitted: true,
    shortCloseState: 'UNKNOWN',
    shortCloseFilledQty: 1,
    protectivePositionQty: 2
  }).state, 'RECONCILIATION_REQUIRED');
  assert.equal(resolveCreditSpreadExitProgress({
    shortPositionQty: 2,
    shortCloseSubmitted: true,
    shortCloseState: 'FILLED',
    shortCloseFilledQty: 3,
    protectivePositionQty: 2
  }).state, 'RECONCILIATION_REQUIRED');
});

test('option exit deadline is before expiry and invalid or late windows fail closed', () => {
  const expiry = NOW + 6 * 60 * 60 * 1000;
  assert.equal(resolveOptionExpiryExitDeadline(expiry, { now: NOW, minutesBeforeExpiry: 30 }),
    expiry - 30 * 60 * 1000);
  assert.equal(resolveOptionExpiryExitDeadline(expiry, { now: expiry - 10 * 60 * 1000, minutesBeforeExpiry: 30 }), null);
  assert.equal(resolveOptionExpiryExitDeadline(expiry, { now: NOW, minutesBeforeExpiry: 2 }), null);
});

test('Options order client IDs are unique by leg and attempt and remain within 32 characters', () => {
  const id1 = makeOptionsClientOrderId('group-id-123456789', 'PROTECTIVE_WING', 1);
  const id2 = makeOptionsClientOrderId('group-id-123456789', 'PROTECTIVE_WING', 2);
  const id3 = makeOptionsClientOrderId('group-id-123456789', 'SHORT_OPTION', 1);
  assert.ok(id1.length <= 32);
  assert.notEqual(id1, id2);
  assert.notEqual(id1, id3);
  assert.throws(() => makeOptionsClientOrderId('x', 'BAD_ROLE', 1), /Cannot create/);
});

test('only non-terminal Options groups occupy the exclusive account slot', () => {
  for (const state of ['OPEN', 'RESERVED', 'UNWIND_PENDING', 'RECONCILIATION_REQUIRED']) {
    assert.equal(isActiveOptionsExecutionState(state), true);
  }
  for (const state of ['CLOSED', 'REJECTED', 'FAILED']) {
    assert.equal(isActiveOptionsExecutionState(state), false);
  }
});
