import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONS_MAX_LOSS_EQUITY_PCT,
  OPTIONS_EXECUTION_ALLOWED,
  getOptionsExecutionGate,
  isOptionsExecutionAllowed,
  getOptionsManualTestOverrideGate,
  assertOptionsManualTestOverrideAllowed
} from '../worker/options-execution-lock.mjs';
import {
  calculateLongOptionMaxLoss,
  calculateDefinedRiskSpreadMaxLoss,
  enforceOptionsMaxLoss,
  executeHedgedOptionSpread
} from '../worker/execution/delta-options-risk.mjs';

test('Options execution gate is default-off and requires both Testnet profile guards', () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  assert.equal(OPTIONS_MAX_LOSS_EQUITY_PCT, 0.5);
  assert.equal(isOptionsExecutionAllowed({}), false);
  assert.equal(isOptionsExecutionAllowed({
    DELTA_EXECUTION_MODE: 'testnet', DELTA_ENVIRONMENT: 'TESTNET'
  }), false);
  assert.equal(isOptionsExecutionAllowed({
    DELTA_EXECUTION_MODE: 'live', DELTA_ENVIRONMENT: 'TESTNET',
    OPTIONS_EXECUTION_ALLOWED: 'true'
  }), false);
  assert.equal(isOptionsExecutionAllowed({
    DELTA_EXECUTION_MODE: 'testnet', DELTA_ENVIRONMENT: 'SIGNAL_ONLY',
    OPTIONS_EXECUTION_ALLOWED: 'true'
  }), false);
  assert.equal(getOptionsExecutionGate({
    DELTA_EXECUTION_MODE: 'testnet', DELTA_ENVIRONMENT: 'TESTNET',
    OPTIONS_EXECUTION_ALLOWED: 'true'
  }).allowed, true);
});

test('manual Options override is default-off and requires an explicit Testnet-only flag', () => {
  assert.equal(getOptionsManualTestOverrideGate({}).allowed, false);
  assert.equal(getOptionsManualTestOverrideGate({
    DELTA_EXECUTION_MODE: 'live',
    DELTA_ENVIRONMENT: 'TESTNET',
    ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true'
  }).allowed, false);
  assert.equal(getOptionsManualTestOverrideGate({
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_ENVIRONMENT: 'SIGNAL_ONLY',
    ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'true'
  }).allowed, false);
  assert.equal(getOptionsManualTestOverrideGate({
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_ENVIRONMENT: 'TESTNET',
    ALLOW_MANUAL_OVERRIDE_FOR_TEST: 'TRUE'
  }).allowed, true);
  assert.throws(() => assertOptionsManualTestOverrideAllowed({}), /ALLOW_MANUAL_OVERRIDE_FOR_TEST=true/);
});

test('long-option maximum loss includes full premium and conservative fees', () => {
  const result = calculateLongOptionMaxLoss({
    premium: 120, contractValue: 0.001, qty: 2, takerFeeRate: 0.001
  });
  assert.ok(Math.abs(result.premiumNotional - 0.24) < 1e-12);
  assert.ok(Math.abs(result.estimatedFees - 0.00048) < 1e-12);
  assert.ok(Math.abs(result.maxLossUsd - 0.24048) < 1e-12);
});

test('defined-risk spread max loss includes vertical loss and hedge-only interim exposure', () => {
  const result = calculateDefinedRiskSpreadMaxLoss({
    optionType: 'CALL', shortStrike: 80000, hedgeStrike: 82000,
    shortPremium: 900, hedgePremium: 250, contractValue: 0.001,
    qty: 2, takerFeeRate: 0.001
  });
  assert.equal(result.width, 2000);
  assert.equal(result.netCredit, 650);
  assert.ok(Math.abs(result.spreadLossBeforeFees - 2.7) < 1e-12);
  assert.ok(Math.abs(result.hedgeOnlyExposure - 0.5) < 1e-12);
  assert.ok(result.maxLossUsd >= result.spreadLossBeforeFees);
  assert.ok(result.estimatedFees > 0);
});

test('0.5% hard equity cap blocks excess loss while preserving tighter configured budget', () => {
  assert.throws(() => enforceOptionsMaxLoss({
    maxLossUsd: 5.01, equity: 1000, optionsRiskPct: 0.5
  }), /exceeds the permitted/);
  const allowed = enforceOptionsMaxLoss({
    maxLossUsd: 3, equity: 1000, optionsRiskPct: 0.5
  });
  assert.equal(allowed.hardLimitUsd, 5);
  assert.equal(allowed.maxAllowedLossUsd, 5);
  const tighter = enforceOptionsMaxLoss({
    maxLossUsd: 2, equity: 1000, optionsRiskPct: 0.2
  });
  assert.equal(tighter.maxAllowedLossUsd, 2);
});

test('protective BUY is fully confirmed before a short SELL is submitted', async () => {
  const events = [];
  const result = await executeHedgedOptionSpread({
    qty: 1,
    placeProtectiveBuy: async () => { events.push('hedge-buy'); return { id: 10 }; },
    waitForProtectiveFill: async () => { events.push('hedge-filled'); return { fullyFilled: true, filledQty: 1 }; },
    cancelProtectiveOrder: async () => ({ confirmed: true, filledQty: 1 }),
    unwindProtectiveFill: async () => ({ id: 12 }),
    placeShortSell: async () => { events.push('short-sell'); return { id: 11 }; }
  });
  assert.deepEqual(events, ['hedge-buy', 'hedge-filled', 'short-sell']);
  assert.equal(result.success, true);
  assert.equal(result.hedgeOrder.id, 10);
  assert.equal(result.shortOrder.id, 11);
});

test('partial protective fill is canceled and only filled quantity is unwound', async () => {
  const events = [];
  const result = await executeHedgedOptionSpread({
    qty: 2,
    placeProtectiveBuy: async () => ({ id: 20 }),
    waitForProtectiveFill: async () => ({ fullyFilled: false, filledQty: 1 }),
    cancelProtectiveOrder: async () => { events.push('cancel'); return { confirmed: true, filledQty: 1 }; },
    unwindProtectiveFill: async (_order, qty) => { events.push('unwind:' + qty); return { id: 21 }; },
    placeShortSell: async () => { events.push('short-sell'); throw new Error('must not be reached'); }
  });
  assert.deepEqual(events, ['cancel', 'unwind:1']);
  assert.equal(result.shortSubmitted, false);
  assert.equal(result.state, 'HEDGE_PARTIAL_UNWOUND');
});

test('unknown protective BUY fill quantity remains locked even after a cancellation acknowledgement', async () => {
  const result = await executeHedgedOptionSpread({
    qty: 1,
    placeProtectiveBuy: async () => ({ id: 50 }),
    waitForProtectiveFill: async () => ({ fullyFilled: false, filledQty: null }),
    cancelProtectiveOrder: async () => ({ confirmed: true, filledQty: null }),
    unwindProtectiveFill: async () => { throw new Error('must not guess the filled quantity'); },
    placeShortSell: async () => { throw new Error('short leg must never be sent'); }
  });
  assert.equal(result.state, 'HEDGE_CANCEL_UNCONFIRMED');
  assert.equal(result.hedgeExposureRemains, true);
  assert.equal(result.shortSubmitted, false);
});

test('ambiguous short acknowledgement retains protective BUY', async () => {
  const events = [];
  const result = await executeHedgedOptionSpread({
    qty: 1,
    placeProtectiveBuy: async () => ({ id: 30 }),
    waitForProtectiveFill: async () => ({ fullyFilled: true, filledQty: 1 }),
    cancelProtectiveOrder: async () => ({ confirmed: true, filledQty: 1 }),
    unwindProtectiveFill: async () => { events.push('unsafe-unwind'); },
    placeShortSell: async () => { const error = new Error('timeout'); error.ambiguous = true; throw error; }
  });
  assert.deepEqual(events, []);
  assert.equal(result.state, 'SHORT_ORDER_UNKNOWN_KEEP_HEDGE');
  assert.equal(result.hedgeExposureRemains, true);
});

test('definitive short rejection attempts reduce-only protective-leg unwind', async () => {
  const events = [];
  const result = await executeHedgedOptionSpread({
    qty: 1,
    placeProtectiveBuy: async () => ({ id: 40 }),
    waitForProtectiveFill: async () => ({ fullyFilled: true, filledQty: 1 }),
    cancelProtectiveOrder: async () => ({ confirmed: true, filledQty: 1 }),
    unwindProtectiveFill: async (_order, qty) => { events.push('unwind:' + qty); return { id: 41 }; },
    placeShortSell: async () => { const error = new Error('exchange rejected'); error.status = 400; throw error; }
  });
  assert.deepEqual(events, ['unwind:1']);
  assert.equal(result.state, 'SHORT_REJECTED_HEDGE_UNWOUND');
});
