import { OPTIONS_MAX_LOSS_EQUITY_PCT } from '../options-execution-lock.mjs';

const positive = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const nonNegative = value => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function calculateLongOptionMaxLoss({
  premium, contractValue, qty, takerFeeRate
} = {}) {
  const price = positive(premium);
  const multiplier = positive(contractValue);
  const quantity = Number(qty);
  const feeRate = nonNegative(takerFeeRate);
  if (!price || !multiplier || !Number.isSafeInteger(quantity) || quantity < 1 ||
      feeRate === null || feeRate > 0.02) {
    throw new Error('Long-option maximum loss requires verified premium, contract value, quantity and fee metadata.');
  }
  const premiumNotional = price * multiplier * quantity;
  // Reserve two fee events at the product's Testnet taker rate.
  const estimatedFees = premiumNotional * feeRate * 2;
  return {
    premiumNotional,
    estimatedFees,
    maxLossUsd: premiumNotional + estimatedFees
  };
}

export function calculateDefinedRiskSpreadMaxLoss({
  optionType, shortStrike, hedgeStrike, shortPremium, hedgePremium,
  contractValue, qty, takerFeeRate
} = {}) {
  const type = String(optionType || '').trim().toUpperCase();
  const shortK = positive(shortStrike);
  const hedgeK = positive(hedgeStrike);
  const shortPrice = positive(shortPremium);
  const hedgePrice = positive(hedgePremium);
  const multiplier = positive(contractValue);
  const quantity = Number(qty);
  const feeRate = nonNegative(takerFeeRate);
  const validDirection = type === 'CALL'
    ? shortK !== null && hedgeK !== null && hedgeK > shortK
    : type === 'PUT'
      ? shortK !== null && hedgeK !== null && hedgeK < shortK
      : false;

  if (!validDirection || !shortPrice || !hedgePrice || !multiplier ||
      !Number.isSafeInteger(quantity) || quantity < 1 ||
      feeRate === null || feeRate > 0.02) {
    throw new Error('Defined-risk spread requires matching type, correct protective strike direction and verified product metadata.');
  }

  const netCredit = shortPrice - hedgePrice;
  if (!(netCredit > 0)) {
    throw new Error('Defined-risk spread is blocked because the verified quotes do not produce a positive net credit.');
  }

  const width = Math.abs(shortK - hedgeK);
  const spreadLossBeforeFees = Math.max(0, width - netCredit) * multiplier * quantity;
  // The BUY hedge exists on its own before the short can be placed. It must
  // remain within the cap even if the second leg is rejected or ambiguous.
  const hedgeOnlyExposure = hedgePrice * multiplier * quantity;
  const totalPremiumNotional = (shortPrice + hedgePrice) * multiplier * quantity;
  // Four fee events conservatively reserve both sides for both spread legs.
  const estimatedFees = totalPremiumNotional * feeRate * 4;
  const maxLossUsd = Math.max(spreadLossBeforeFees, hedgeOnlyExposure) + estimatedFees;

  return {
    width, netCredit, spreadLossBeforeFees, hedgeOnlyExposure,
    estimatedFees, maxLossUsd
  };
}

export function enforceOptionsMaxLoss({
  maxLossUsd, equity, optionsRiskPct = 0.30
} = {}) {
  const loss = positive(maxLossUsd);
  const accountEquity = positive(equity);
  const configuredPct = Number(optionsRiskPct);
  if (!loss || !accountEquity || !Number.isFinite(configuredPct) || configuredPct <= 0) {
    throw new Error('Options maximum-loss gate requires positive loss/equity and a valid existing Options risk percentage.');
  }

  const hardLimitUsd = accountEquity * OPTIONS_MAX_LOSS_EQUITY_PCT / 100;
  // Preserve the existing Options risk budget. It is never increased here.
  const configuredLimitUsd = accountEquity * Math.min(configuredPct, OPTIONS_MAX_LOSS_EQUITY_PCT) / 100;
  const maxAllowedLossUsd = Math.min(hardLimitUsd, configuredLimitUsd);
  if (loss > maxAllowedLossUsd + 1e-9) {
    const error = new Error(
      'Options order blocked: maximum loss USD ' + loss.toFixed(6) +
      ' exceeds the permitted USD ' + maxAllowedLossUsd.toFixed(6) +
      ' (hard cap 0.5% of equity; the existing Options risk setting is not increased).'
    );
    error.code = 'OPTIONS_MAX_LOSS_EXCEEDED';
    error.statusCode = 409;
    error.details = { maxLossUsd: loss, equity: accountEquity, hardLimitUsd, configuredLimitUsd, maxAllowedLossUsd };
    throw error;
  }
  return { maxLossUsd: loss, equity: accountEquity, hardLimitUsd, configuredLimitUsd, maxAllowedLossUsd };
}

/**
 * Injected order lifecycle used by the executor and deterministic mock tests.
 * An ambiguous acknowledgement never triggers an unwind of the hedge.
 */
export async function executeHedgedOptionSpread({
  qty, placeProtectiveBuy, waitForProtectiveFill, cancelProtectiveOrder,
  unwindProtectiveFill, placeShortSell
} = {}) {
  const quantity = Number(qty);
  const operations = [
    placeProtectiveBuy, waitForProtectiveFill, cancelProtectiveOrder,
    unwindProtectiveFill, placeShortSell
  ];
  if (!Number.isSafeInteger(quantity) || quantity < 1 ||
      operations.some(operation => typeof operation !== 'function')) {
    throw new Error('Hedged Options lifecycle dependencies or quantity are invalid.');
  }

  const hedgeOrder = await placeProtectiveBuy();
  let fill;
  try {
    fill = await waitForProtectiveFill(hedgeOrder, quantity);
  } catch (error) {
    return {
      success: false,
      state: 'HEDGE_FILL_UNKNOWN',
      hedgeOrder,
      shortOrder: null,
      reason: String(error?.message || error),
      shortSubmitted: false,
      hedgeExposureRemains: true
    };
  }

  if (fill?.fullyFilled !== true || Number(fill?.filledQty) !== quantity) {
    let canceled;
    try {
      canceled = await cancelProtectiveOrder(hedgeOrder);
    } catch (error) {
      canceled = { confirmed: false, error: String(error?.message || error) };
    }
    if (canceled?.confirmed !== true) {
      return {
        success: false,
        state: 'HEDGE_CANCEL_UNCONFIRMED',
        hedgeOrder,
        shortOrder: null,
        reason: 'Protective BUY was not fully filled and its cancellation could not be confirmed.',
        shortSubmitted: false,
        hedgeExposureRemains: true
      };
    }
    const observedFilledQty = canceled.filledQty ?? fill?.filledQty;
    if (observedFilledQty === null || observedFilledQty === undefined ||
        !Number.isSafeInteger(Number(observedFilledQty)) ||
        Number(observedFilledQty) < 0 || Number(observedFilledQty) > quantity) {
      return {
        success: false,
        state: 'HEDGE_CANCEL_UNCONFIRMED',
        hedgeOrder,
        shortOrder: null,
        reason: 'Protective BUY cancellation was reported but its filled quantity is unknown; retain exposure for reconciliation.',
        shortSubmitted: false,
        hedgeExposureRemains: true
      };
    }
    const filledQty = Number(observedFilledQty);
    if (filledQty > 0) {
      try {
        const unwindOrder = await unwindProtectiveFill(hedgeOrder, filledQty);
        return {
          success: false,
          state: 'HEDGE_PARTIAL_UNWOUND',
          hedgeOrder,
          unwindOrder,
          shortOrder: null,
          reason: 'Partial protective BUY was canceled and its filled quantity was sent for reduce-only unwind. Short leg was not submitted.',
          shortSubmitted: false
        };
      } catch (error) {
        return {
          success: false,
          state: 'HEDGE_PARTIAL_UNWIND_FAILED',
          hedgeOrder,
          shortOrder: null,
          reason: 'Partial protective BUY unwind failed: ' + String(error?.message || error),
          shortSubmitted: false,
          hedgeExposureRemains: true
        };
      }
    }
    return {
      success: false,
      state: 'HEDGE_NOT_FILLED',
      hedgeOrder,
      shortOrder: null,
      reason: 'Protective BUY was not fully filled. Short leg was not submitted.',
      shortSubmitted: false
    };
  }

  try {
    const shortOrder = await placeShortSell(hedgeOrder, fill);
    return { success: true, state: 'SHORT_SUBMITTED', hedgeOrder, shortOrder, shortSubmitted: true };
  } catch (error) {
    const status = Number(error?.status);
    const ambiguous = error?.ambiguous === true || status === 408 || status === 429 || status >= 500;
    if (ambiguous) {
      return {
        success: false,
        state: 'SHORT_ORDER_UNKNOWN_KEEP_HEDGE',
        hedgeOrder,
        shortOrder: null,
        reason: 'Short order acknowledgement is ambiguous; protective BUY is retained until exchange reconciliation.',
        shortSubmitted: true,
        hedgeExposureRemains: true
      };
    }
    try {
      const unwindOrder = await unwindProtectiveFill(hedgeOrder, quantity);
      return {
        success: false,
        state: 'SHORT_REJECTED_HEDGE_UNWOUND',
        hedgeOrder,
        unwindOrder,
        shortOrder: null,
        reason: 'Short order was definitively rejected; protective BUY unwind was submitted.',
        shortSubmitted: false
      };
    } catch (unwindError) {
      return {
        success: false,
        state: 'SHORT_REJECTED_UNWIND_FAILED',
        hedgeOrder,
        shortOrder: null,
        reason: 'Short order was rejected but protective BUY unwind failed: ' + String(unwindError?.message || unwindError),
        shortSubmitted: false,
        hedgeExposureRemains: true
      };
    }
  }
}
