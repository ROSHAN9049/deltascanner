import { createHash } from 'node:crypto';
import { parseDeltaOptionSymbol } from './delta-options-policy.mjs';

const TERMINAL_ORDER_STATES = new Set([
  'FILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'FAILED'
]);
const UNKNOWN_ORDER_STATES = new Set(['UNKNOWN', 'UNVERIFIED', '']);
const ACTIVE_GROUP_STATES = new Set([
  'RESERVED', 'BUY_ENTRY_PENDING', 'HEDGE_ENTRY_PENDING', 'SHORT_ENTRY_PENDING',
  'OPEN', 'LONG_EXIT_PENDING', 'SHORT_EXIT_PENDING', 'HEDGE_EXIT_PENDING',
  'UNWIND_PENDING', 'RECONCILIATION_REQUIRED'
]);

const finitePositive = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const wholeQuantity = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const normalized = value => String(value ?? '').trim().toUpperCase();

function verifiedProduct(ticker, now) {
  if (!ticker || ticker.testnet_product_verified !== true) return null;
  const symbol = normalized(ticker.symbol);
  const parsed = parseDeltaOptionSymbol(symbol, ticker.underlying, now);
  const productId = Number(ticker.product_id ?? ticker.id);
  const contractType = String(ticker.contract_type ?? '').toLowerCase();
  const optionContractType = parsed?.optionType === 'CALL' ? 'call_options'
    : parsed?.optionType === 'PUT' ? 'put_options' : '';
  const contractValue = finitePositive(ticker.contract_value);
  const tickSize = finitePositive(ticker.tick_size);
  const state = String(ticker.state ?? '').toLowerCase();

  if (!parsed || parsed.dte <= 0 || !['BTC', 'ETH'].includes(parsed.underlying) ||
      !Number.isSafeInteger(productId) || productId <= 0 ||
      contractType !== optionContractType ||
      state !== 'live' ||
      !contractValue || !tickSize) return null;

  return {
    ticker,
    productId,
    symbol,
    contractType,
    optionType: parsed.optionType,
    underlying: parsed.underlying,
    strike: parsed.strike,
    expiryMs: parsed.expiryMs,
    contractValue,
    tickSize
  };
}

export function validateLongOptionEntryPlan({
  ticker,
  underlyingSide,
  qty,
  maxLossUsd,
  now = Date.now()
} = {}) {
  const product = verifiedProduct(ticker, now);
  const quantity = wholeQuantity(qty);
  const maxLoss = finitePositive(maxLossUsd);
  const wantedType = normalized(underlyingSide) === 'BUY' ? 'CALL'
    : normalized(underlyingSide) === 'SELL' ? 'PUT' : null;

  if (!product) return { valid: false, reason: 'Long option does not match a live verified Delta Testnet product' };
  if (!quantity) return { valid: false, reason: 'Long option quantity must be a positive whole number' };
  if (!wantedType || product.optionType !== wantedType) {
    return { valid: false, reason: 'Long option type does not match the confirmed underlying direction' };
  }
  if (!maxLoss) return { valid: false, reason: 'Full-premium maximum loss must be known before entry' };

  return {
    valid: true,
    strategy: 'OPTIONS_BUY',
    qty: quantity,
    maxLossUsd: maxLoss,
    underlyingSymbol: product.underlying + 'USD',
    underlyingDirection: normalized(underlyingSide),
    optionType: product.optionType,
    expiryMs: product.expiryMs,
    legs: [{
      role: 'LONG_PREMIUM',
      symbol: product.symbol,
      productId: product.productId,
      contractType: product.contractType,
      optionType: product.optionType,
      strike: product.strike,
      contractValue: product.contractValue,
      tickSize: product.tickSize,
      side: 'BUY',
      qty: quantity,
      reduceOnlyOnExit: true
    }],
    entrySequence: ['LONG_PREMIUM']
  };
}

export function validateCreditSpreadEntryPlan({
  shortTicker,
  protectiveTicker,
  underlyingSide,
  qty,
  maxLossUsd,
  now = Date.now()
} = {}) {
  const short = verifiedProduct(shortTicker, now);
  const protective = verifiedProduct(protectiveTicker, now);
  const quantity = wholeQuantity(qty);
  const maxLoss = finitePositive(maxLossUsd);
  const direction = normalized(underlyingSide);
  const expectedShortType = direction === 'BUY' ? 'PUT' : direction === 'SELL' ? 'CALL' : null;

  if (!short || !protective) {
    return { valid: false, reason: 'Both credit-spread legs must match live verified Delta Testnet products' };
  }
  if (!quantity) return { valid: false, reason: 'Credit spread quantity must be a positive whole number' };
  if (!maxLoss) return { valid: false, reason: 'Combined credit-spread maximum loss must be known before entry' };
  if (!expectedShortType || short.optionType !== expectedShortType) {
    return { valid: false, reason: 'Short option type does not match the confirmed underlying direction' };
  }
  if (short.underlying !== protective.underlying ||
      short.optionType !== protective.optionType ||
      short.expiryMs !== protective.expiryMs) {
    return { valid: false, reason: 'Short and protective legs must share underlying, option type and exact expiry' };
  }

  const multiplierTolerance = Math.max(short.contractValue, protective.contractValue) * 1e-9;
  if (Math.abs(short.contractValue - protective.contractValue) > multiplierTolerance) {
    return { valid: false, reason: 'Short and protective option contract multipliers do not match' };
  }

  const correctWing = short.optionType === 'PUT'
    ? protective.strike < short.strike
    : protective.strike > short.strike;
  if (!correctWing) {
    return { valid: false, reason: 'Protective wing must be farther out of the money than the short option' };
  }

  return {
    valid: true,
    strategy: 'OPTIONS_SELL',
    qty: quantity,
    maxLossUsd: maxLoss,
    underlyingSymbol: short.underlying + 'USD',
    underlyingDirection: direction,
    optionType: short.optionType,
    expiryMs: short.expiryMs,
    legs: [
      {
        role: 'PROTECTIVE_WING',
        symbol: protective.symbol,
        productId: protective.productId,
        contractType: protective.contractType,
        optionType: protective.optionType,
        strike: protective.strike,
        contractValue: protective.contractValue,
        tickSize: protective.tickSize,
        side: 'BUY',
        qty: quantity,
        reduceOnlyOnExit: true
      },
      {
        role: 'SHORT_OPTION',
        symbol: short.symbol,
        productId: short.productId,
        contractType: short.contractType,
        optionType: short.optionType,
        strike: short.strike,
        contractValue: short.contractValue,
        tickSize: short.tickSize,
        side: 'SELL',
        qty: quantity,
        reduceOnlyOnExit: true
      }
    ],
    // Never place the short leg until the protective BUY is terminal and its
    // actual filled quantity is known from the exchange fills ledger.
    entrySequence: ['PROTECTIVE_WING', 'SHORT_OPTION']
  };
}

export function resolveCreditSpreadEntryProgress({
  protectiveState,
  protectiveFilledQty,
  shortSubmitted = false,
  shortState = null,
  shortFilledQty = 0,
  protectiveExcessUnwound = false,
  protectiveFullUnwindConfirmed = false
} = {}) {
  const protectiveQty = wholeQuantity(protectiveFilledQty);
  const shortQty = wholeQuantity(shortFilledQty);
  if (protectiveQty === null || shortQty === null) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Exchange fill quantity is missing or malformed' };
  }

  const hedgeState = normalized(protectiveState);
  if (UNKNOWN_ORDER_STATES.has(hedgeState)) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Protective-leg acknowledgement/fill state is unknown' };
  }
  if (!TERMINAL_ORDER_STATES.has(hedgeState)) {
    return { state: 'HEDGE_ENTRY_PENDING', reason: 'Protective BUY is not terminal; short leg must not be sent' };
  }
  if (protectiveQty === 0) {
    return { state: 'REJECTED', reason: 'Protective BUY has no confirmed fill; no short order may be placed' };
  }
  if (!shortSubmitted) {
    return {
      state: 'SHORT_ENTRY_READY',
      shortOrderQty: protectiveQty,
      reason: 'Protective BUY is terminal; short quantity is capped to its confirmed filled quantity'
    };
  }

  const shortOrderState = normalized(shortState);
  if (UNKNOWN_ORDER_STATES.has(shortOrderState)) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Short-leg acknowledgement/fill state is unknown; do not retry' };
  }
  if (!TERMINAL_ORDER_STATES.has(shortOrderState)) {
    return { state: 'SHORT_ENTRY_PENDING', reason: 'Short SELL is not terminal; wait for final IOC fill evidence' };
  }
  if (shortQty > protectiveQty) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Exchange short fill exceeds confirmed protective-leg quantity' };
  }
  if (shortQty === 0) {
    if (protectiveFullUnwindConfirmed) {
      return { state: 'REJECTED', matchedQty: 0, reason: 'Short SELL did not fill and the protective BUY was fully unwound' };
    }
    return {
      state: 'UNWIND_PENDING',
      unwindRole: 'PROTECTIVE_WING',
      unwindQty: protectiveQty,
      reason: 'Short SELL did not fill; close the protective long before releasing the group'
    };
  }

  const excessProtectiveQty = protectiveQty - shortQty;
  if (excessProtectiveQty > 0 && !protectiveExcessUnwound) {
    return {
      state: 'UNWIND_PENDING',
      unwindRole: 'PROTECTIVE_WING',
      unwindQty: excessProtectiveQty,
      matchedQty: shortQty,
      reason: 'Short SELL partially filled; unwind only the unmatched excess protective contracts'
    };
  }

  return {
    state: 'OPEN',
    matchedQty: shortQty,
    reason: 'Short and protective legs are matched at the exchange-confirmed filled quantity'
  };
}

export function resolveCreditSpreadExitProgress({
  shortPositionQty,
  shortCloseSubmitted = false,
  shortCloseState = null,
  shortCloseFilledQty = 0,
  protectivePositionQty,
  protectiveCloseSubmitted = false,
  protectiveCloseState = null,
  protectiveCloseFilledQty = 0
} = {}) {
  const shortQty = wholeQuantity(shortPositionQty);
  const shortClosed = wholeQuantity(shortCloseFilledQty);
  const protectiveQty = wholeQuantity(protectivePositionQty);
  const protectiveClosed = wholeQuantity(protectiveCloseFilledQty);
  if ([shortQty, shortClosed, protectiveQty, protectiveClosed].some(value => value === null)) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Exit position/fill quantity is missing or malformed' };
  }
  if (shortClosed > shortQty || protectiveClosed > protectiveQty) {
    return { state: 'RECONCILIATION_REQUIRED', reason: 'Exit fill exceeds the exchange-confirmed position quantity' };
  }

  const shortRemaining = shortQty - shortClosed;
  if (shortRemaining > 0) {
    if (!shortCloseSubmitted) {
      return {
        state: 'SHORT_EXIT_PENDING',
        nextRole: 'SHORT_OPTION',
        nextSide: 'BUY',
        nextQty: shortRemaining,
        reason: 'Cover the short option first; leave the protective long untouched'
      };
    }
    const shortState = normalized(shortCloseState);
    if (UNKNOWN_ORDER_STATES.has(shortState)) {
      return { state: 'RECONCILIATION_REQUIRED', reason: 'Short close outcome is unknown; protective leg must not be sold' };
    }
    if (!TERMINAL_ORDER_STATES.has(shortState)) {
      return { state: 'SHORT_EXIT_PENDING', reason: 'Short close is still pending; protective leg must remain open' };
    }
    return {
      state: 'SHORT_EXIT_PENDING',
      nextRole: 'SHORT_OPTION',
      nextSide: 'BUY',
      nextQty: shortRemaining,
      reason: 'Short close IOC was partial; retry only the confirmed remaining short quantity'
    };
  }

  const protectiveRemaining = protectiveQty - protectiveClosed;
  if (protectiveRemaining > 0) {
    if (!protectiveCloseSubmitted) {
      return {
        state: 'HEDGE_EXIT_PENDING',
        nextRole: 'PROTECTIVE_WING',
        nextSide: 'SELL',
        nextQty: protectiveRemaining,
        reason: 'Short is confirmed flat; the protective long may now be sold'
      };
    }
    const protectiveState = normalized(protectiveCloseState);
    if (UNKNOWN_ORDER_STATES.has(protectiveState)) {
      return { state: 'RECONCILIATION_REQUIRED', reason: 'Protective-leg close outcome is unknown' };
    }
    if (!TERMINAL_ORDER_STATES.has(protectiveState)) {
      return { state: 'HEDGE_EXIT_PENDING', reason: 'Protective close is still pending' };
    }
    return {
      state: 'HEDGE_EXIT_PENDING',
      nextRole: 'PROTECTIVE_WING',
      nextSide: 'SELL',
      nextQty: protectiveRemaining,
      reason: 'Protective close IOC was partial; retry only the confirmed remaining long quantity'
    };
  }

  return { state: 'CLOSED', nextQty: 0, reason: 'Both spread legs are confirmed flat' };
}

export function resolveOptionExpiryExitDeadline(expiryMs, {
  now = Date.now(),
  minutesBeforeExpiry = 30
} = {}) {
  const expiry = Number(expiryMs);
  const current = Number(now);
  const minutes = Number(minutesBeforeExpiry);
  if (!Number.isFinite(expiry) || expiry <= 0 ||
      !Number.isFinite(current) || !Number.isFinite(minutes) ||
      minutes < 5 || minutes > 240) return null;
  const deadline = expiry - minutes * 60 * 1000;
  return deadline > current ? deadline : null;
}

export function makeOptionsClientOrderId(groupId, legRole, attempt = 1) {
  const group = String(groupId || '').trim();
  const role = normalized(legRole);
  const attemptNumber = wholeQuantity(attempt);
  const roleCode = ({
    LONG_PREMIUM: 'LP',
    PROTECTIVE_WING: 'PW',
    SHORT_OPTION: 'SH',
    CLOSE_SHORT: 'CS',
    CLOSE_LONG: 'CL',
    CLOSE_WING: 'CW'
  })[role];
  if (group.length < 4 || !roleCode || !attemptNumber || attemptNumber < 1) {
    throw new Error('Cannot create a unique Delta Options client order ID from the supplied group/leg/attempt');
  }
  // Use a digest rather than the first group characters so UUID prefix
  // collisions cannot accidentally reuse another group's idempotency key.
  const digest = createHash('sha256').update(group).digest('hex').slice(0, 12).toUpperCase();
  const id = ('DDO-' + digest + '-' + roleCode + '-' + attemptNumber.toString(36)).slice(0, 32);
  return id;
}

export function isActiveOptionsExecutionState(state) {
  return ACTIVE_GROUP_STATES.has(normalized(state));
}
