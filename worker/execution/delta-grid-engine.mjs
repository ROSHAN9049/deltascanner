import {
  createGridState,
  evaluateGridTick,
  normalizeGridConfig,
  detectOneWayMomentum
} from '../grid-strategy.mjs';
import {
  DELTA_TESTNET_MIN_SL_DISTANCE_PCT,
  resolveMinimumStopDistancePct,
  roundStopLossAwayFromEntry
} from '../../shared/delta-risk-policy.js';
import { indiaDateKey } from '../../src/date-utils.js';
import { assessStrategyPositionCap } from '../../shared/strategy-position-limits.js';
import { isAllowedDeltaTestnetFutureSymbol } from './execution-route-policy.mjs';

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const DELTA_GRID_MAX_AVAILABLE_MARGIN_FRACTION = 0.25;
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = value => String(value ?? '').trim();
const terminalOrderStates = new Set([
  'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'REJECTED', 'FAILED', 'EXPIRED', 'EXITED'
]);

function pushEvent(state, event, at) {
  const events = Array.isArray(state.events) ? state.events : [];
  state.events = [...events, { ...event, at }].slice(-80);
}

function roundPriceUp(price, tickSize) {
  const value = Number(price);
  const tick = Number(tickSize);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!Number.isFinite(tick) || tick <= 0) return value;
  return Number((Math.ceil((value / tick) - 1e-10) * tick).toPrecision(15));
}

function samePrice(a, b, tickSize) {
  const left = numberOrNull(a);
  const right = numberOrNull(b);
  if (left === null || right === null) return false;
  const tick = numberOrNull(tickSize);
  const tolerance = tick !== null && tick > 0 ? tick * 0.51 : Math.max(1e-8, Math.abs(right) * 1e-8);
  return Math.abs(left - right) <= tolerance;
}

const cancelledOrderStates = new Set(['CANCELLED', 'CANCELED']);

const GRID_PNL_VERIFY_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);
const defaultGridPnlSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry one Grid-only ledger read independently so a failed request is
 * identified precisely. Three backoff retries (500/1000/2000ms) follow the
 * initial request; all four ledger reads must still return validated results.
 */
export async function retryGridPnlRead({
  request, read, validate = () => true, database, sleepFn = defaultGridPnlSleep
} = {}) {
  if (typeof read !== 'function') throw new Error('Grid P&L read function is required');
  let lastError = null;
  for (let attempt = 0; attempt <= GRID_PNL_VERIFY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const value = await read();
      if (!validate(value)) {
        throw new Error('Grid P&L read returned an incomplete or non-exact response');
      }
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < GRID_PNL_VERIFY_RETRY_DELAYS_MS.length) {
        await sleepFn(GRID_PNL_VERIFY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  const detail = String(lastError?.message || lastError || 'Unknown database read failure').slice(0, 240);
  const diagnostic = {
    event: 'grid_pnl_verify_failed',
    request: String(request || 'unknown'),
    error: detail,
    attempts: GRID_PNL_VERIFY_RETRY_DELAYS_MS.length + 1
  };
  try {
    await database?.log?.(
      'WARN',
      'Grid P&L verification request failed after bounded retries',
      diagnostic
    );
  } catch {}
  const finalError = new Error('Grid P&L verification request ' +
    diagnostic.request + ' failed after ' + diagnostic.attempts + ' attempts: ' + detail);
  finalError.request = diagnostic.request;
  throw finalError;
}

export function hasVerifiedGridBracket(order, expectedStop, expectedTarget, tickSize) {
  const actualStop = numberOrNull(order?.bracket_stop_loss_price);
  const actualTarget = numberOrNull(order?.bracket_take_profit_price);
  return actualStop !== null && actualStop > 0 &&
    actualTarget !== null && actualTarget > 0 &&
    samePrice(actualStop, expectedStop, tickSize) &&
    samePrice(actualTarget, expectedTarget, tickSize);
}

export async function cancelAndVerifyGridOrder({ executor, orderId, clientOrderId } = {}) {
  if (!executor || typeof executor.cancelOrderById !== 'function' ||
      typeof executor.getOrderById !== 'function') {
    throw new Error('Grid order cancellation and exchange verification are unavailable');
  }
  let resolvedOrderId = numberOrNull(orderId);
  if (!(resolvedOrderId > 0) && clientOrderId &&
      typeof executor.getOrderByClientOrderId === 'function') {
    const byClientId = await executor.getOrderByClientOrderId(clientOrderId);
    resolvedOrderId = numberOrNull(byClientId?.id ?? byClientId?.order_id);
  }
  if (!Number.isSafeInteger(resolvedOrderId) || resolvedOrderId <= 0) {
    throw new Error('Grid order cancellation requires a verified exchange order ID');
  }

  let cancelRequestError = null;
  try {
    await executor.cancelOrderById(resolvedOrderId);
  } catch (error) {
    // A request timeout does not establish whether DELETE reached the exchange.
    // Still perform the required read-after-cancel before declaring failure.
    cancelRequestError = error;
  }
  // Deliberately perform a fresh read after the cancel helper, even when that
  // helper timed out. A FILLED or still-open state is not cancellation proof.
  const confirmedOrder = await executor.getOrderById(resolvedOrderId);
  const confirmedState = text(confirmedOrder?.state).toUpperCase();
  if (!cancelledOrderStates.has(confirmedState)) {
    const requestDetail = cancelRequestError
      ? '; cancel request error: ' + String(cancelRequestError?.message || cancelRequestError).slice(0, 180)
      : '';
    throw new Error('Grid entry cancellation is unconfirmed; exchange state is ' +
      (confirmedState || 'UNKNOWN') + requestDetail);
  }
  return { orderId: resolvedOrderId, order: confirmedOrder, state: 'CANCELLED' };
}

function emptyTestnetGridState(accountEquity, timestamp) {
  const state = createGridState();
  state.version = 2;
  state.executionMode = 'DELTA_TESTNET';
  state.executionStartedAt = new Date(timestamp).toISOString();
  // Do not start the Grid capital baseline while the strategy is still OFF.
  // The first explicit enable action sets the baseline to the current account equity.
  state.strategyStartEquity = 0;
  state.highWaterEquity = accountEquity;
  state.dayStartEquity = 0;
  state.currentEquity = accountEquity;
  state.tradeDate = indiaDateKey(new Date(timestamp));
  state.wasEnabled = false;
  return state;
}

function mapVerifiedTrades(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    id: row.execution_id || row.id,
    symbol: row.symbol,
    entryPrice: numberOrNull(row.entry_price),
    exitPrice: numberOrNull(row.exit_price),
    qty: numberOrNull(row.qty),
    feesAndSlippage: numberOrNull(row.fees),
    netPnl: numberOrNull(row.net_pnl),
    reason: row.exit_reason || row.result || 'EXCHANGE_CLOSED',
    openedAt: row.opened_at,
    closedAt: row.closed_at
  }));
}

export function sizeDeltaGridEntry({
  candidate,
  settings = {},
  account = {},
  product = {},
  riskEquity = 0,
  remainingDailyRisk = null,
  consecutiveLosses = 0,
  minStopDistancePct = DELTA_TESTNET_MIN_SL_DISTANCE_PCT,
  slippagePct = 0.02
} = {}) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'GRID_ENTRY_CANDIDATE_MISSING' };
  const entry = numberOrNull(candidate.entryPrice);
  const nativeStop = numberOrNull(candidate.stopPrice);
  const nativeTarget = numberOrNull(candidate.targetPrice);
  const tick = numberOrNull(product.tick_size ?? product.tickSize);
  const contractValue = numberOrNull(product.contract_value);
  const cv = contractValue !== null && contractValue > 0 ? contractValue : null;
  if (!(entry > 0 && nativeStop > 0 && nativeStop < entry && nativeTarget > entry && cv > 0)) {
    return { ok: false, reason: 'GRID_PRODUCT_OR_BRACKET_METADATA_INVALID' };
  }

  const floorPct = resolveMinimumStopDistancePct(minStopDistancePct);
  const floorStop = entry * (1 - floorPct / 100);
  // Grid targets the next rung. Normalize the protective stop to the shared 1.50% floor
  // so symmetric rung spacing does not become negative net R:R after fees and slippage.
  const atrBufferedStop = candidate.atrBufferedStop === true ? Math.min(nativeStop, floorStop) : floorStop;
  const stop = roundStopLossAwayFromEntry(atrBufferedStop, tick, 'BUY');
  const target = roundPriceUp(nativeTarget, tick);
  if (!(stop > 0 && stop < entry && target > entry)) {
    return { ok: false, reason: 'GRID_TICK_ROUNDED_BRACKET_INVALID' };
  }
  const stopDistancePct = (entry - stop) / entry * 100;
  if (stopDistancePct + 1e-9 < floorPct) {
    return { ok: false, reason: 'GRID_STOP_BELOW_DELTA_MINIMUM' };
  }

  const takerFee = numberOrNull(product.taker_commission_rate ?? product.taker_fee_rate);
  const makerFallback = numberOrNull(product.maker_commission_rate);
  const feeRate = takerFee !== null ? Math.max(0, takerFee)
    : makerFallback !== null ? Math.max(0, makerFallback) : 0.0006;
  const slipRate = Math.max(0, Math.min(0.0025, n(slippagePct) / 100));
  const roundTripCostsPerContract = entry * cv * 2 * (feeRate + slipRate);
  const riskPerContract = ((entry - stop) * cv) + roundTripCostsPerContract;
  const rewardPerContract = ((target - entry) * cv) - roundTripCostsPerContract;
  if (!(riskPerContract > 0 && rewardPerContract >= riskPerContract)) {
    return { ok: false, reason: 'GRID_REWARD_RISK_BELOW_MINIMUM' };
  }

  const normalized = normalizeGridConfig({ ...settings, grid_max_positions: 1 });
  const capital = numberOrNull(riskEquity) ?? numberOrNull(account.equity);
  const available = numberOrNull(account.available);
  if (!(capital > 0 && available > 0)) return { ok: false, reason: 'GRID_ACCOUNT_MARGIN_UNAVAILABLE' };
  const riskPct = Math.min(normalized.riskPerTradePct, normalized.dailyLossPct);
  let riskBudget = capital * riskPct / 100;
  if (normalized.reduceAfterLosses && n(consecutiveLosses) >= 2) riskBudget *= 0.5;
  if (numberOrNull(remainingDailyRisk) !== null) {
    riskBudget = Math.min(riskBudget, Math.max(0, n(remainingDailyRisk)));
  }
  const leverage = Math.max(1, n(settings.max_leverage) || 3);
  const notionalPerContract = entry * cv;
  const qtyByRisk = Math.floor(riskBudget / riskPerContract);
  const qtyByEquity = Math.floor((capital * leverage) / notionalPerContract);
  // Do not let a single Grid entry consume all remaining account margin, especially
  // when Momentum/Scalping positions are already open.
  const gridMarginBudget = available * DELTA_GRID_MAX_AVAILABLE_MARGIN_FRACTION;
  const qtyByMargin = Math.floor((gridMarginBudget * leverage) / notionalPerContract);
  const qty = Math.max(0, Math.min(qtyByRisk, qtyByEquity, qtyByMargin, n(candidate.qty)));
  if (qty < 1) return { ok: false, reason: 'GRID_MINIMUM_CONTRACT_EXCEEDS_RISK_BUDGET' };
  const riskUsd = qty * riskPerContract;
  if (riskUsd > riskBudget + 1e-8) return { ok: false, reason: 'GRID_ROUNDED_SIZE_EXCEEDS_RISK_BUDGET' };

  return {
    ok: true,
    qty,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    riskUsd,
    riskPerContract,
    rewardPerContract,
    rewardRiskRatio: rewardPerContract / riskPerContract,
    minStopDistancePct: floorPct,
    stopDistancePct,
    feeRate,
    slippageRate: slipRate,
    tickSize: tick,
    riskBudget
  };
}

export function assessDeltaGridEntryFill({
  entryPrice,
  stopPrice,
  targetPrice,
  qty,
  product = {},
  riskBudget = null,
  feeRate = 0.0006,
  slippageRate = 0.0002,
  minStopDistancePct = DELTA_TESTNET_MIN_SL_DISTANCE_PCT
} = {}) {
  const entry = numberOrNull(entryPrice);
  const stop = numberOrNull(stopPrice);
  const target = numberOrNull(targetPrice);
  const quantity = numberOrNull(qty);
  const contractValue = numberOrNull(product.contract_value);
  if (!(entry > 0 && stop > 0 && stop < entry && target > entry &&
      Number.isSafeInteger(quantity) && quantity > 0 && contractValue > 0)) {
    return { ok: false, reason: 'GRID_FILLED_BRACKET_INVALID' };
  }
  const stopDistancePct = (entry - stop) / entry * 100;
  const minimum = resolveMinimumStopDistancePct(minStopDistancePct);
  if (stopDistancePct + 1e-9 < minimum) {
    return { ok: false, reason: 'GRID_FILLED_STOP_BELOW_DELTA_MINIMUM', stopDistancePct, minimum };
  }
  const costsPerContract = entry * contractValue * 2 *
    (Math.max(0, n(feeRate)) + Math.max(0, n(slippageRate)));
  const riskPerContract = (entry - stop) * contractValue + costsPerContract;
  const rewardPerContract = (target - entry) * contractValue - costsPerContract;
  const riskUsd = riskPerContract * quantity;
  const rewardUsd = rewardPerContract * quantity;
  if (!(rewardPerContract >= riskPerContract)) {
    return { ok: false, reason: 'GRID_FILLED_REWARD_RISK_BELOW_MINIMUM', riskUsd, rewardUsd, stopDistancePct };
  }
  if (numberOrNull(riskBudget) !== null && riskUsd > n(riskBudget) + 1e-8) {
    return { ok: false, reason: 'GRID_FILLED_RISK_BUDGET_EXCEEDED', riskUsd, riskBudget: n(riskBudget), rewardUsd, stopDistancePct };
  }
  return { ok: true, riskUsd, rewardUsd, riskPerContract, rewardPerContract, rewardRiskRatio: rewardUsd / riskUsd, stopDistancePct };
}

async function saveState(database, state, timestamp) {
  await database.update('dd_settings', 'id=eq.1', {
    grid_state: state,
    updated_at: timestamp
  });
}

async function findOpenPosition(executor, symbol) {
  const rows = await executor.getOpenPositions();
  if (!Array.isArray(rows)) throw new Error('Delta Testnet positions snapshot is not an array');
  return rows.find(row => text(row?.symbol).toUpperCase() === symbol && n(row?.qty) > 0) || null;
}

async function closeAndVerify(executor, symbol, expectedQty) {
  const before = await findOpenPosition(executor, symbol);
  if (!before) return { closed: true, order: null };
  const qty = n(before.qty) || n(expectedQty);
  if (!(qty > 0)) return { closed: false, reason: 'GRID_EXIT_QUANTITY_UNKNOWN' };
  const order = await executor.closePosition(symbol, qty);
  const after = await findOpenPosition(executor, symbol);
  return { closed: !after, order: order || null, remaining: after || null };
}

function parseOrderRaw(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

export function calculateTrailingGridRange({
  direction, lowerPrice, upperPrice, breakoutExitPct = 1.2, shiftPct = 10,
  minRangePct = 2, maxRangePct = 20
} = {}) {
  const lower = numberOrNull(lowerPrice);
  const upper = numberOrNull(upperPrice);
  const breakoutPct = numberOrNull(breakoutExitPct);
  const shift = numberOrNull(shiftPct);
  const normalizedDirection = text(direction).toUpperCase();
  if (!(lower > 0 && upper > lower && breakoutPct >= 0 && shift > 0) ||
      !['UP', 'DOWN'].includes(normalizedDirection)) {
    return { ok: false, reason: 'GRID_TRAILING_RANGE_INVALID' };
  }
  const upperBreakPrice = upper * (1 + breakoutPct / 100);
  const lowerBreakPrice = lower * (1 - breakoutPct / 100);
  const nextLower = normalizedDirection === 'UP'
    ? upper * (1 - shift / 100)
    : lowerBreakPrice * (1 - shift / 100);
  let nextUpper = normalizedDirection === 'UP'
    ? upperBreakPrice * (1 + shift / 100)
    : lower * (1 + shift / 100);
  if (!(Number.isFinite(nextLower) && nextLower > 0 &&
      Number.isFinite(nextUpper) && nextUpper > nextLower)) {
    return { ok: false, reason: 'GRID_TRAILING_RANGE_INVALID' };
  }
  const minPct = numberOrNull(minRangePct) ?? 2;
  const maxPct = numberOrNull(maxRangePct) ?? 20;
  if (!(minPct > 0 && maxPct >= minPct && maxPct < 100)) {
    return { ok: false, reason: 'GRID_TRAILING_RANGE_LIMITS_INVALID' };
  }
  const center = (nextLower + nextUpper) / 2;
  const rawWidthPct = (nextUpper - nextLower) / center * 100;
  const clampedWidthPct = Math.max(minPct, Math.min(maxPct, rawWidthPct));
  const halfWidth = center * clampedWidthPct / 200;
  nextUpper = center + halfWidth;
  const clampedLower = center - halfWidth;
  return {
    ok: true,
    direction: normalizedDirection,
    breakoutPrice: normalizedDirection === 'UP' ? upperBreakPrice : lowerBreakPrice,
    lowerPrice: Number(clampedLower.toPrecision(12)),
    upperPrice: Number(nextUpper.toPrecision(12)),
    widthPct: clampedWidthPct,
    rawWidthPct,
    clamped: Math.abs(clampedWidthPct - rawWidthPct) > 1e-9
  };
}

export function getTrailingGridBreakoutDirection(markPrice, config = {}) {
  const mark = numberOrNull(markPrice);
  const lower = numberOrNull(config.lowerPrice);
  const upper = numberOrNull(config.upperPrice);
  const breakoutPct = numberOrNull(config.breakoutExitPct ?? 1.2);
  if (!(mark > 0 && lower > 0 && upper > lower && breakoutPct >= 0)) return null;
  if (mark >= upper * (1 + breakoutPct / 100)) return 'UP';
  if (mark <= lower * (1 - breakoutPct / 100)) return 'DOWN';
  return null;
}

export function pruneTrailingGridShiftTimestamps(values, now = Date.now()) {
  const current = numberOrNull(now) ?? Date.now();
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(value => {
      const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter(value => value !== null && value <= current && value > current - 60 * 60 * 1000)
    .sort((a, b) => a - b)
    .filter(value => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .map(value => new Date(value).toISOString());
}

export async function executeTrailingGridShift({
  executor, database, state, settings = {}, symbol, configuredSymbols = [],
  currentConfig = {}, markPrice, direction, dbOpenGridRows = [], gridOrders = [],
  now = () => Date.now()
} = {}) {
  const timestamp = now();
  const at = new Date(timestamp).toISOString();
  const normalizedSymbol = text(symbol).toUpperCase();
  const symbols = [...new Set((Array.isArray(configuredSymbols) ? configuredSymbols : [])
    .map(value => text(value).toUpperCase()).filter(Boolean))];
  const mark = numberOrNull(markPrice);
  const shift = calculateTrailingGridRange({
    direction, lowerPrice: currentConfig.lowerPrice, upperPrice: currentConfig.upperPrice,
    breakoutExitPct: currentConfig.breakoutExitPct, shiftPct: 10,
    minRangePct: Number(settings.grid_min_range_pct ?? process.env.GRID_MIN_RANGE_PCT ?? 2),
    maxRangePct: Number(settings.grid_max_range_pct ?? process.env.GRID_MAX_RANGE_PCT ?? 20)
  });
  const fail = async (reason, error = null, level = 'CRITICAL') => {
    state.status = 'HALTED';
    state.pausedReason = reason;
    state.lastTickAt = at;
    pushEvent(state, {
      type: 'HALT', reason, symbol: normalizedSymbol, price: mark,
      ...(error ? { error: String(error?.message || error).slice(0, 220) } : {})
    }, at);
    await database.update('dd_settings', 'id=eq.1', {
      grid_state: state, updated_at: at
    }).catch(() => {});
    await database.log(level, 'Grid trailing shift failed closed; manual review/reset is required', {
      symbol: normalizedSymbol, direction, price: mark, reason,
      error: error ? String(error?.message || error).slice(0, 220) : null,
      executionBlocked: true, doNotResumeAutomatically: true
    }).catch(() => {});
    return { ok: false, halted: true, reason, state };
  };
  const globalTimestamps = Array.isArray(settings.gridGlobalTrailingShiftTimestamps)
    ? settings.gridGlobalTrailingShiftTimestamps : [];
  const recentShifts = pruneTrailingGridShiftTimestamps([
    ...globalTimestamps,
    ...(Array.isArray(state.trailingShiftTimestamps) ? state.trailingShiftTimestamps : [])
  ], timestamp);
  state.trailingShiftTimestamps = recentShifts;
  if (recentShifts.length >= 3) {
    state.status = 'HALTED';
    state.pausedReason = 'GRID_TRAILING_SHIFT_LIMIT';
    state.lastTickAt = at;
    pushEvent(state, {
      type: 'HALT', reason: 'GRID_TRAILING_SHIFT_LIMIT', symbol: normalizedSymbol,
      direction, price: mark, shiftsInPreviousHour: recentShifts.length, maximumShiftsPerHour: 3
    }, at);
    await database.update('dd_settings', 'id=eq.1', { grid_state: state, updated_at: at }).catch(() => {});
    await database.log('CRITICAL',
      'Grid halted: maximum of 3 trailing shifts in one hour exceeded; manual reset required',
      { symbol: normalizedSymbol, direction, price: mark, shiftsInPreviousHour: recentShifts.length,
        maximumShiftsPerHour: 3, executionBlocked: true }).catch(() => {});
    return { ok: false, halted: true, reason: 'GRID_TRAILING_SHIFT_LIMIT', state };
  }

  if (!shift.ok || !symbols.includes(normalizedSymbol) || !(mark > 0) ||
      !executor || typeof executor.getOpenPositions !== 'function' ||
      typeof executor.getOrderById !== 'function' || !database ||
      typeof database.select !== 'function' ||
      typeof database.update !== 'function' || typeof database.log !== 'function') {
    return fail('GRID_TRAILING_SHIFT_UNCONFIRMED',
      new Error(shift.reason || 'Trailing Grid dependencies or symbol configuration are invalid'));
  }

  try {
    const configured = new Set(symbols);
    const gridOrderClientIds = new Set((Array.isArray(gridOrders) ? gridOrders : [])
      .filter(row => text(row?.strategy).toUpperCase() === 'GRID')
      .map(row => text(row?.client_order_id)).filter(Boolean));

    // Preflight every configured symbol against both exchange and database state.
    // A stale Grid row alone is never sufficient to claim another strategy's position.
    const beforePositions = await executor.getOpenPositions();
    if (!Array.isArray(beforePositions)) throw new Error('Exchange position snapshot is malformed before trailing shift');
    const configuredExposure = beforePositions.filter(position =>
      configured.has(text(position?.symbol).toUpperCase()) && n(position?.qty) > 0
    );
    const openRowsBySymbol = new Map();
    for (const configuredSymbol of symbols) {
      const rows = await database.select(
        'dd_delta_positions',
        'symbol=eq.' + encodeURIComponent(configuredSymbol) +
          '&status=eq.OPEN&select=id,symbol,strategy,qty,side,entry_price,client_order_id,entry_order_id&limit=10'
      );
      if (!Array.isArray(rows)) {
        throw new Error('Database position ownership snapshot is malformed for ' + configuredSymbol);
      }
      const activeRows = rows.filter(row => n(row?.qty) > 0);
      if (activeRows.length > 1) {
        throw new Error('Multiple open database positions exist for configured Grid symbol ' + configuredSymbol);
      }
      if (activeRows.some(row => text(row?.strategy).toUpperCase() !== 'GRID')) {
        throw new Error('Non-Grid database exposure exists on ' + configuredSymbol +
          '; trailing shift refused to touch another strategy position');
      }
      openRowsBySymbol.set(configuredSymbol, activeRows[0] || null);
    }

    for (const position of configuredExposure) {
      const positionSymbol = text(position?.symbol).toUpperCase();
      const dbPosition = openRowsBySymbol.get(positionSymbol);
      const positionClientId = text(position?.client_order_id);
      const dbClientId = text(dbPosition?.client_order_id);
      const gridIdentityVerified = Boolean(dbPosition) &&
        dbClientId.toUpperCase().startsWith('DDG-') &&
        (!positionClientId || positionClientId === dbClientId ||
          gridOrderClientIds.has(positionClientId));
      if (!gridIdentityVerified) {
        throw new Error('Grid ownership could not be verified for exchange position on ' + positionSymbol);
      }
      if (Math.abs(n(dbPosition.qty) - n(position.qty)) > 0) {
        throw new Error('Exchange/database Grid quantity mismatch on ' + positionSymbol);
      }
      if (text(dbPosition.side).toUpperCase() !== text(position.side).toUpperCase()) {
        throw new Error('Exchange/database Grid side mismatch on ' + positionSymbol);
      }
      const dbEntry = numberOrNull(dbPosition.entry_price);
      const exchangeEntry = numberOrNull(position.entry_price);
      if (dbEntry !== null && exchangeEntry !== null &&
          Math.abs(dbEntry - exchangeEntry) > Math.max(1e-8, Math.abs(exchangeEntry) * 1e-6)) {
        throw new Error('Exchange/database Grid entry-price mismatch on ' + positionSymbol);
      }
      if (text(position.side).toUpperCase() !== 'BUY') {
        throw new Error('Unexpected non-BUY Grid exposure found on ' + positionSymbol);
      }
    }

    for (const [configuredSymbol, dbPosition] of openRowsBySymbol.entries()) {
      const exchangePosition = configuredExposure.find(position =>
        text(position?.symbol).toUpperCase() === configuredSymbol
      );
      if (dbPosition && !exchangePosition) {
        throw new Error('Database reports an open Grid position but Delta reports no matching exposure on ' + configuredSymbol);
      }
    }

    // Cancel pending Grid ENTRY orders on both configured symbols. If an order
    // filled before cancellation, the subsequent exchange position refresh closes it.
    const pendingGridEntries = (Array.isArray(gridOrders) ? gridOrders : []).filter(row =>
      configured.has(text(row?.symbol).toUpperCase()) &&
      text(row?.strategy).toUpperCase() === 'GRID' &&
      text(row?.role).toUpperCase() === 'ENTRY' &&
      !terminalOrderStates.has(text(row?.state).toUpperCase())
    );
    for (const row of pendingGridEntries) {
      const clientOrderId = text(row?.client_order_id);
      const raw = parseOrderRaw(row?.raw);
      let orderId = numberOrNull(raw?.testnet_order_id ?? raw?.order_id ?? row?.exchange_order_id ?? row?.order_id);
      if (!(Number.isSafeInteger(orderId) && orderId > 0) &&
          clientOrderId && typeof executor.getOrderByClientOrderId === 'function') {
        const byClientId = await executor.getOrderByClientOrderId(clientOrderId);
        orderId = numberOrNull(byClientId?.id ?? byClientId?.order_id);
      }
      if (!(Number.isSafeInteger(orderId) && orderId > 0)) {
        throw new Error('Pending Grid entry has no verifiable Delta order ID; reservation was not released');
      }
      let confirmedOrder = await executor.getOrderById(orderId);
      let confirmedState = text(confirmedOrder?.state).toUpperCase();
      if (!confirmedState) throw new Error('Delta returned no state for pending Grid entry ' + orderId);
      if (!terminalOrderStates.has(confirmedState)) {
        const cancellation = await cancelAndVerifyGridOrder({ executor, orderId, clientOrderId });
        confirmedOrder = cancellation.order;
        confirmedState = cancellation.state;
      }
      if (!terminalOrderStates.has(confirmedState)) {
        throw new Error('Grid entry order ' + orderId + ' remains active after cancellation attempt');
      }
      const rowId = numberOrNull(row?.id);
      const query = clientOrderId
        ? 'client_order_id=eq.' + encodeURIComponent(clientOrderId)
        : rowId !== null ? 'id=eq.' + encodeURIComponent(String(rowId)) : '';
      if (!query) throw new Error('Cannot persist terminal status for Grid entry without its database identity');
      await database.update('dd_orders', query, {
        state: confirmedState, unfilled_size: numberOrNull(confirmedOrder?.unfilled_size), updated_at: at,
        raw: {
          ...raw, reservation: false, accepted: true, exchange_state: confirmedState,
          cancelledByTrailingGrid: confirmedState === 'CANCELLED' || confirmedState === 'CANCELED',
          trailingGridShiftAt: at
        }
      });
    }

    // Close each Grid-owned position with a reduce-only market exit and verify
    // each symbol flat from a fresh exchange position snapshot.
    const afterCancels = await executor.getOpenPositions();
    if (!Array.isArray(afterCancels)) throw new Error('Exchange position snapshot is malformed after Grid order cancellation');
    const remainingConfiguredExposure = afterCancels.filter(position =>
      configured.has(text(position?.symbol).toUpperCase()) && n(position?.qty) > 0
    );
    for (const position of remainingConfiguredExposure) {
      const positionSymbol = text(position?.symbol).toUpperCase();
      const dbPosition = openRowsBySymbol.get(positionSymbol);
      const positionClientId = text(position?.client_order_id);
      const dbClientId = text(dbPosition?.client_order_id);
      if (!dbPosition || !dbClientId.toUpperCase().startsWith('DDG-') ||
          (positionClientId && positionClientId !== dbClientId &&
            !gridOrderClientIds.has(positionClientId)) ||
          Math.abs(n(dbPosition.qty) - n(position.qty)) > 0 ||
          text(dbPosition.side).toUpperCase() !== text(position.side).toUpperCase()) {
        throw new Error('Grid ownership/reconciliation changed during cancellation on ' + positionSymbol);
      }
    }
    const closeSymbols = [...new Set(remainingConfiguredExposure.map(position =>
      text(position?.symbol).toUpperCase()
    ))];
    for (const closeSymbol of closeSymbols) {
      const position = remainingConfiguredExposure.find(row => text(row?.symbol).toUpperCase() === closeSymbol);
      const close = await closeAndVerify(executor, closeSymbol, n(position?.qty));
      if (!close.closed) throw new Error('Market close could not be verified flat for ' + closeSymbol);
    }
    const finalPositions = await executor.getOpenPositions();
    if (!Array.isArray(finalPositions)) throw new Error('Final exchange position snapshot is malformed after trailing shift');
    const residualExposure = finalPositions.filter(position =>
      configured.has(text(position?.symbol).toUpperCase()) && n(position?.qty) > 0
    );
    if (residualExposure.length) throw new Error('Exchange still reports configured-symbol exposure after trailing shift market closes');

    const oldConfigMap = settings.grid_symbol_configs && typeof settings.grid_symbol_configs === 'object'
      ? settings.grid_symbol_configs : {};
    const nextConfigMap = { ...oldConfigMap };
    const existing = oldConfigMap[normalizedSymbol] || {};
    const levelsCountValue = Number(existing.levelsCount ?? existing.grid_levels_count ?? settings.grid_levels_count ?? 10);
    const levelsCount = Number.isInteger(levelsCountValue) && levelsCountValue >= 8 && levelsCountValue <= 12
      ? levelsCountValue : 10;
    nextConfigMap[normalizedSymbol] = {
      ...existing, lowerPrice: shift.lowerPrice, upperPrice: shift.upperPrice, levelsCount
    };
    const nextShiftTimestamps = [...recentShifts, at];
    state.positions = [];
    state.pendingEntries = [];
    state.openRiskUsd = 0;
    state.unrealizedPnl = 0;
    state.lastPrice = 0;
    state.currentPrice = mark;
    state.lastTickAt = at;
    state.wasEnabled = true;
    state.status = 'ACTIVE';
    state.pausedReason = null;
    state.momentum = { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 };
    state.trailingShiftTimestamps = nextShiftTimestamps;
    state.lastTrailingShiftAt = at;
    state.lastTrailingShiftSymbol = normalizedSymbol;
    state.lastTrailingShiftDirection = direction;
    state.lastTrailingShiftPrice = mark;
    const event = {
      type: 'SHIFT', reason: 'TRAILING_GRID_SHIFT_' + direction, direction,
      symbol: normalizedSymbol, price: mark,
      previousLowerPrice: numberOrNull(currentConfig.lowerPrice),
      previousUpperPrice: numberOrNull(currentConfig.upperPrice),
      newLowerPrice: shift.lowerPrice, newUpperPrice: shift.upperPrice,
      shiftCountInLastHour: nextShiftTimestamps.length,
      realizedPnl: null, pnlPendingReconciliation: true
    };
    pushEvent(state, event, at);
    await database.log('INFO', '[GRID] Trailing Shift triggered. New Range: [' +
      shift.lowerPrice + '] - [' + shift.upperPrice + '] (Width: ' +
      Number(shift.widthPct).toFixed(2) + '%)', {
      symbol: normalizedSymbol, direction, lowerPrice: shift.lowerPrice,
      upperPrice: shift.upperPrice, widthPct: shift.widthPct, atrClamped: shift.clamped
    }).catch(() => {});
    const update = {
      grid_symbol_configs: nextConfigMap, grid_state: state, updated_at: at
    };
    if (symbols[0] === normalizedSymbol) {
      update.grid_symbol = normalizedSymbol;
      update.grid_lower_price = shift.lowerPrice;
      update.grid_upper_price = shift.upperPrice;
      update.grid_levels_count = levelsCount;
    }
    await database.update('dd_settings', 'id=eq.1', update);
    await database.log('INFO',
      'Shifted Grid ' + direction + ' at price ' + mark +
      '; exchange market exits verified flat; realized P&L pending Delta trade-ledger reconciliation',
      {
        symbol: normalizedSymbol, direction, markPrice: mark,
        previousRange: { lowerPrice: numberOrNull(currentConfig.lowerPrice), upperPrice: numberOrNull(currentConfig.upperPrice) },
        nextRange: { lowerPrice: shift.lowerPrice, upperPrice: shift.upperPrice },
        closedGridSymbols: closeSymbols, cancelledGridEntryCount: pendingGridEntries.length,
        shiftCountInLastHour: nextShiftTimestamps.length, realizedPnlVerified: false, orderRoutingAttempted: true
      }
    ).catch(() => {});
    return { ok: true, shifted: true, state, event, closedGridSymbols: closeSymbols };
  } catch (error) {
    return fail('GRID_TRAILING_SHIFT_UNCONFIRMED', error);
  }
}


export async function cancelUnverifiedGridEntry({
  executor, database, state, symbol, orderId, clientOrderId,
  expectedStop, expectedTarget, raw = {}, now = () => Date.now(), mark = null,
  verificationError = null
} = {}) {
  const at = new Date(now()).toISOString();
  const normalizedSymbol = text(symbol).toUpperCase();
  const normalizedClientId = text(clientOrderId);
  const reservationRaw = parseOrderRaw(raw);
  let confirmedOrder = null;
  let resolvedOrderId = numberOrNull(orderId);

  try {
    const cancellation = await cancelAndVerifyGridOrder({
      executor, orderId: resolvedOrderId, clientOrderId: normalizedClientId
    });
    resolvedOrderId = cancellation.orderId;
    confirmedOrder = cancellation.order;

    // A partially filled limit entry may leave an open position after the
    // unfilled remainder is cancelled. Close and verify any resulting exposure
    // before releasing the reservation.
    const remainingPosition = await findOpenPosition(executor, normalizedSymbol);
    if (remainingPosition) {
      const close = await closeAndVerify(executor, normalizedSymbol, remainingPosition.qty);
      if (!close.closed) {
        throw new Error('Entry order was cancelled but its partial-fill position could not be closed and verified');
      }
    }

    if (!normalizedClientId) {
      throw new Error('Cannot release Grid reservation without its client order ID');
    }
    await database.update(
      'dd_orders',
      'client_order_id=eq.' + encodeURIComponent(normalizedClientId),
      {
        state: 'CANCELLED',
        unfilled_size: numberOrNull(confirmedOrder?.unfilled_size),
        updated_at: at,
        raw: {
          ...reservationRaw,
          reservation: false,
          accepted: true,
          exchange_state: 'CANCELLED',
          cancelledByGridSafety: true,
          bracketVerificationFailed: true,
          bracketVerificationError: String(verificationError || 'SL/TP mismatch or missing'),
          cancelVerifiedAt: at
        }
      }
    );

    state.pendingEntries = (Array.isArray(state.pendingEntries) ? state.pendingEntries : [])
      .filter(row => text(row?.symbol).toUpperCase() !== normalizedSymbol);
    state.positions = (Array.isArray(state.positions) ? state.positions : [])
      .filter(row => text(row?.symbol).toUpperCase() !== normalizedSymbol);
    state.status = 'HALTED';
    state.pausedReason = 'GRID_BRACKET_UNVERIFIED_CANCELLED';
    pushEvent(state, {
      type: 'HALT', reason: state.pausedReason, symbol: normalizedSymbol,
      orderId: String(resolvedOrderId), price: mark
    }, at);
    await database.log('WARN', 'Grid entry bracket verification failed; exchange cancellation confirmed and reservation released', {
      symbol: normalizedSymbol, orderId: resolvedOrderId,
      clientOrderId: normalizedClientId,
      expectedStop: numberOrNull(expectedStop), expectedTarget: numberOrNull(expectedTarget),
      actualStop: numberOrNull(confirmedOrder?.bracket_stop_loss_price),
      actualTarget: numberOrNull(confirmedOrder?.bracket_take_profit_price),
      partialFillClosed: Boolean(remainingPosition),
      reservationReleased: true,
      executionBlocked: true
    }).catch(() => {});
    return { cancelled: true, reason: state.pausedReason, orderId: resolvedOrderId };
  } catch (error) {
    state.status = 'HALTED';
    state.pausedReason = 'GRID_BRACKET_CANCEL_UNCONFIRMED';
    const pending = Array.isArray(state.pendingEntries) ? [...state.pendingEntries] : [];
    if (!pending.some(row => text(row?.symbol).toUpperCase() === normalizedSymbol)) {
      pending.push({
        symbol: normalizedSymbol,
        exchangeOrderId: resolvedOrderId ? String(resolvedOrderId) : null,
        clientOrderId: normalizedClientId || null,
        stopPrice: numberOrNull(expectedStop),
        targetPrice: numberOrNull(expectedTarget),
        state: 'UNKNOWN',
        createdAt: at
      });
    }
    state.pendingEntries = pending;
    pushEvent(state, {
      type: 'HALT', reason: state.pausedReason, symbol: normalizedSymbol,
      orderId: resolvedOrderId ? String(resolvedOrderId) : null, price: mark
    }, at);
    await database.log('CRITICAL', 'CRITICAL: Grid bracket verification failed and exchange cancellation could not be confirmed; both Grid symbols must remain halted', {
      symbol: normalizedSymbol, orderId: resolvedOrderId,
      clientOrderId: normalizedClientId || null,
      expectedStop: numberOrNull(expectedStop), expectedTarget: numberOrNull(expectedTarget),
      verificationError: String(verificationError || '').slice(0, 220),
      cancellationError: String(error?.message || error).slice(0, 240),
      reservationReleased: false,
      doNotRetryOrRelease: true,
      executionBlocked: true
    }).catch(() => {});
    return {
      cancelled: false, reason: state.pausedReason,
      orderId: resolvedOrderId, error: String(error?.message || error)
    };
  }
}

function verifiedPnlSnapshot({ closedPositions, closedPositionCount, trades, tradeCount, todayStart }) {
  const closedRows = Array.isArray(closedPositions) ? closedPositions : [];
  const tradeRows = Array.isArray(trades) ? trades : [];
  const complete = Number.isInteger(closedPositionCount) &&
    Number.isInteger(tradeCount) &&
    closedPositionCount === closedRows.length &&
    tradeCount === tradeRows.length &&
    closedPositionCount === tradeCount &&
    tradeRows.every(row =>
      row?.net_pnl_verified === true &&
      numberOrNull(row?.net_pnl) !== null &&
      numberOrNull(row?.net_pnl) !== undefined &&
      row?.closed_at
    );
  if (!complete) return { complete: false, realizedPnl: null, dayPnl: null, consecutiveLosses: 0, trades: [] };
  const ordered = [...tradeRows].sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
  const realizedPnl = ordered.reduce((sum, row) => sum + n(row.net_pnl), 0);
  const todayRows = ordered.filter(row => {
    const closedAt = Date.parse(String(row.closed_at));
    return Number.isFinite(closedAt) && closedAt >= Date.parse(todayStart);
  });
  const dayPnl = todayRows.reduce((sum, row) => sum + n(row.net_pnl), 0);
  let consecutiveLosses = 0;
  for (const row of ordered) {
    if (n(row.net_pnl) < 0) consecutiveLosses += 1;
    else break;
    if (consecutiveLosses >= 10) break;
  }
  return {
    complete: true,
    realizedPnl,
    dayPnl,
    consecutiveLosses,
    trades: mapVerifiedTrades(ordered.slice(0, 100))
  };
}

export async function manageDeltaTestnetGrid({
  settings = {},
  account = {},
  ticker = {},
  product = {},
  candles = [],
  dataFresh = true,
  database,
  executor,
  now = () => Date.now(),
  sleepFn = defaultGridPnlSleep
} = {}) {
  const timestamp = now();
  const at = new Date(timestamp).toISOString();
  const symbol = text(settings.grid_symbol).toUpperCase();
  const safety = {
    executionMode: 'testnet',
    configured: account.privateApiAvailable === true,
    trusted: account.privateApiAvailable === true,
    blocked: false,
    reason: null
  };

  let state = settings.grid_state;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { state = null; }
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.executionMode !== 'DELTA_TESTNET' || Number(state.version) < 2) {
    state = emptyTestnetGridState(n(account.equity), timestamp);
  } else {
    state = {
      ...createGridState(),
      ...state,
      version: 2,
      executionMode: 'DELTA_TESTNET',
      positions: Array.isArray(state.positions) ? state.positions.map(position => ({ ...position })) : [],
      events: Array.isArray(state.events) ? state.events.slice(-80) : [],
      trades: Array.isArray(state.trades) ? state.trades.slice(0, 100) : []
    };
  }

  const persist = async () => saveState(database, state, at);
  const block = async reason => {
    safety.blocked = true;
    safety.reason = reason;
    await persist();
    return { state, safety };
  };

  if (!isAllowedDeltaTestnetFutureSymbol(symbol)) {
    state.status = 'BLOCKED';
    return block('GRID_SYMBOL_NOT_IN_DELTA_TESTNET_ALLOWLIST');
  }

  if (account.privateApiAvailable !== true || !(n(account.equity) > 0) || !(n(account.available) > 0)) {
    state.status = 'SCAN_ONLY';
    state.pausedReason = state.positions.length ? (state.pausedReason || 'PRIVATE_API_UNAVAILABLE') : null;
    return block('PRIVATE_API_UNAVAILABLE');
  }

  if (!(n(state.strategyStartEquity) > 0) && settings.grid_enabled === true) {
    state.strategyStartEquity = n(account.equity);
    state.highWaterEquity = n(account.equity);
    state.dayStartEquity = n(account.equity);
    state.currentEquity = n(account.equity);
    state.tradeDate = indiaDateKey(new Date(timestamp));
  }
  const today = indiaDateKey(new Date(timestamp));
  const todayStart = today + 'T00:00:00+05:30';
  const closedPositionQuery = 'strategy=eq.GRID&status=in.(CLOSED,CLOSED_EXTERNALLY)&select=id,symbol,closed_at&order=closed_at.desc&limit=1000';
  const tradeQuery = 'strategy=eq.GRID&select=id,execution_id,symbol,qty,entry_price,exit_price,fees,net_pnl,net_pnl_verified,exit_reason,result,opened_at,closed_at&order=closed_at.desc&limit=1000';
  let pnl;
  let allTrades = [];
  let gridPnlPauseRecovered = false;
  try {
    const pnlReadResults = await Promise.allSettled([
      retryGridPnlRead({
        request: 'closed_positions',
        read: () => database.select('dd_delta_positions', closedPositionQuery),
        validate: Array.isArray,
        database,
        sleepFn
      }),
      retryGridPnlRead({
        request: 'closed_positions_count',
        read: () => database.count('dd_delta_positions', 'strategy=eq.GRID&status=in.(CLOSED,CLOSED_EXTERNALLY)&select=id'),
        validate: value => Number.isInteger(value) && value >= 0,
        database,
        sleepFn
      }),
      retryGridPnlRead({
        request: 'grid_trades',
        read: () => database.select('dd_trades', tradeQuery),
        validate: Array.isArray,
        database,
        sleepFn
      }),
      retryGridPnlRead({
        request: 'grid_trades_count',
        read: () => database.count('dd_trades', 'strategy=eq.GRID&select=id'),
        validate: value => Number.isInteger(value) && value >= 0,
        database,
        sleepFn
      })
    ]);
    const failedPnlRead = pnlReadResults.find(result => result.status === 'rejected');
    if (failedPnlRead) throw failedPnlRead.reason;
    const [closedPositions, closedPositionCount, trades, tradeCount] =
      pnlReadResults.map(result => result.value);
    allTrades = Array.isArray(trades) ? trades : [];
    pnl = verifiedPnlSnapshot({
      closedPositions,
      closedPositionCount,
      trades: allTrades,
      tradeCount,
      todayStart
    });
  } catch (error) {
    await database.log('WARN', 'Delta Testnet Grid P&L verification unavailable; entries remain blocked', {
      symbol,
      request: error?.request || null,
      error: String(error?.message || error).slice(0, 260)
    }).catch(() => {});
    return block('GRID_PNL_UNVERIFIED');
  }

  if (state.tradeDate !== today && pnl.complete) {
    state.tradeDate = today;
    state.dayStartEquity = n(state.strategyStartEquity) + pnl.realizedPnl - pnl.dayPnl;
    state.dayPnl = 0;
    if (state.pausedReason === 'DAILY_LOSS_LIMIT') state.pausedReason = null;
  }
  state.realizedPnl = pnl.complete ? pnl.realizedPnl : null;
  state.dayPnl = pnl.complete ? pnl.dayPnl : null;
  if (pnl.complete) state.trades = pnl.trades;

  const config = normalizeGridConfig({ ...settings, grid_symbol: symbol, grid_max_positions: 1 });
  const mark = numberOrNull(ticker?.mark_price ?? ticker?.close);
  if (!(mark > 0)) return block('GRID_MARK_PRICE_UNAVAILABLE');
  state.symbol = symbol;
  state.currentPrice = mark;
  state.lastTickAt = at;

  let exchangePositions;
  let dbOpenGridRows;
  let dbOpenSameSymbolRows;
  let gridOrders;
  try {
    [exchangePositions, dbOpenGridRows, dbOpenSameSymbolRows, gridOrders] = await Promise.all([
      executor.getOpenPositions(),
      database.select('dd_delta_positions', 'strategy=eq.GRID&status=eq.OPEN&select=id,symbol,qty,side,entry_price,current_price,unrealized_pnl,sl_price,tp_price,order_id,entry_order_id,client_order_id,opened_at&limit=100'),
      database.select('dd_delta_positions', 'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&select=id,symbol,strategy,qty,side,entry_price,sl_price,tp_price,order_id,entry_order_id,client_order_id&limit=10'),
      database.select('dd_orders', 'strategy=eq.GRID&order=created_at.desc&limit=50')
    ]);
    if (!Array.isArray(exchangePositions) || !Array.isArray(dbOpenGridRows) ||
        !Array.isArray(dbOpenSameSymbolRows) || !Array.isArray(gridOrders)) {
      throw new Error('Grid position/order reconciliation returned malformed data');
    }
  } catch (error) {
    await database.log('ERROR', 'Delta Testnet Grid exchange reconciliation failed closed', {
      symbol, error: String(error?.message || error).slice(0, 220)
    }).catch(() => {});
    return block('GRID_EXCHANGE_RECONCILIATION_UNAVAILABLE');
  }

  const configuredGridSymbols = Array.isArray(settings.gridSymbols)
    ? settings.gridSymbols.map(value => text(value).toUpperCase()) : [symbol];
  const exchangeGridPositions = exchangePositions.filter(row => {
    const rowSymbol = text(row?.symbol).toUpperCase();
    return n(row?.qty) > 0 && (
      text(row?.client_order_id).toUpperCase().startsWith('DDG-') ||
      dbOpenGridRows.some(position => text(position?.symbol).toUpperCase() === rowSymbol)
    );
  });

  // A prior P&L network failure is recoverable only after a complete fresh
  // ledger verification and an authoritative flat/no-pending snapshot across
  // every configured Grid symbol. Unrelated strategies' ledger rows are never
  // queried or modified here.
  if (state.pausedReason === 'GRID_PNL_UNVERIFIED') {
    const exchangeConfiguredPositions = exchangePositions.filter(row =>
      configuredGridSymbols.includes(text(row?.symbol).toUpperCase()) && n(row?.qty) > 0
    );
    const pendingGridOrders = gridOrders.filter(row =>
      !terminalOrderStates.has(text(row?.state).toUpperCase())
    );
    const hasOpenGridExposure = dbOpenGridRows.length > 0 || exchangeConfiguredPositions.length > 0;
    const hasPendingGridReservation = pendingGridOrders.length > 0 ||
      (Array.isArray(state.pendingEntries) && state.pendingEntries.length > 0);
    if (pnl.complete && !hasOpenGridExposure && !hasPendingGridReservation) {
      gridPnlPauseRecovered = true;
      state.pausedReason = null;
      state.positions = [];
      state.pendingEntries = [];
      state.openRiskUsd = 0;
      state.unrealizedPnl = 0;
      state.status = 'PAUSED';
      pushEvent(state, { type: 'INFO', reason: 'GRID_PNL_VERIFY_RECOVERED', symbol }, at);
      await database.log('INFO', '[GRID] P&L verification recovered; resuming Grid cycle', {
        event: 'grid_pnl_verify_recovered',
        symbol,
        verifiedTradeCount: allTrades.length
      }).catch(() => {});
    } else {
      state.status = 'HALTED';
      return block('GRID_PNL_UNVERIFIED');
    }
  }
  const capOpenPositions = [
    ...dbOpenGridRows,
    ...exchangeGridPositions.filter(exchangePosition =>
      !dbOpenGridRows.some(dbPosition => text(dbPosition?.symbol).toUpperCase() === text(exchangePosition?.symbol).toUpperCase())
    ).map(position => {
      const rowSymbol = text(position.symbol).toUpperCase();
      const matchingOrder = gridOrders.find(order =>
        text(order?.symbol).toUpperCase() === rowSymbol &&
        text(order?.strategy).toUpperCase() === 'GRID' &&
        text(order?.client_order_id).toUpperCase().startsWith('DDG-')
      );
      let raw = matchingOrder?.raw;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
      }
      return {
        symbol: rowSymbol,
        status: 'OPEN',
        strategy: 'GRID',
        client_order_id: position.client_order_id || matchingOrder?.client_order_id || null,
        entry_order_id: raw?.testnet_order_id || null
      };
    })
  ];
  const gridPositionCap = assessStrategyPositionCap({
    strategy: 'GRID',
    settings,
    openPositions: capOpenPositions,
    pendingOrders: gridOrders,
    now: timestamp
  });
  const gridPositionCapBlocked = gridPositionCap.status !== 'PASS';
  if (gridPositionCapBlocked) {
    await database.log('WARN', 'Delta Testnet Grid new entry blocked by per-strategy position cap; existing positions remain managed', {
      symbol,
      exposure: gridPositionCap.exposure,
      maxGridPositions: gridPositionCap.limit,
      reason: gridPositionCap.reason,
      executionBlocked: true
    }).catch(() => {});
  }

  const unexpectedGridSymbol = [...exchangeGridPositions, ...dbOpenGridRows]
    .map(row => text(row?.symbol).toUpperCase())
    .find(rowSymbol => !configuredGridSymbols.includes(rowSymbol) ||
      !isAllowedDeltaTestnetFutureSymbol(rowSymbol));
  const exchangeSameSymbolCount = exchangeGridPositions.filter(row =>
    text(row?.symbol).toUpperCase() === symbol
  ).length;
  const dbSameSymbolCount = dbOpenGridRows.filter(row =>
    text(row?.symbol).toUpperCase() === symbol
  ).length;
  if (unexpectedGridSymbol || exchangeSameSymbolCount > 1 || dbSameSymbolCount > 1 ||
      dbOpenGridRows.some(row => !exchangePositions.some(position =>
        text(position?.symbol).toUpperCase() === text(row?.symbol).toUpperCase() &&
        n(position?.qty) > 0
      ))) {
    state.status = 'HALTED';
    state.pausedReason = 'GRID_MULTI_SYMBOL_RECONCILIATION_FAILED';
    return block('GRID_MULTI_SYMBOL_RECONCILIATION_FAILED');
  }
  const totalGridUnrealizedPnl = exchangeGridPositions.reduce((sum, position) => {
    const value = numberOrNull(position?.unrealized_pnl);
    return value === null ? null : sum + value;
  }, 0);
  if (totalGridUnrealizedPnl === null) {
    state.status = 'BLOCKED';
    return block('GRID_COMBINED_UNREALIZED_PNL_UNAVAILABLE');
  }
  const sharedRealizedPnl = pnl.complete ? pnl.realizedPnl : null;
  const sharedDayPnl = pnl.complete ? pnl.dayPnl : null;
  const sharedCurrentEquity = sharedRealizedPnl !== null && n(state.strategyStartEquity) > 0
    ? n(state.strategyStartEquity) + sharedRealizedPnl + totalGridUnrealizedPnl : null;
  if (sharedCurrentEquity !== null) {
    state.highWaterEquity = Math.max(n(state.highWaterEquity), sharedCurrentEquity);
    state.currentEquity = sharedCurrentEquity;
    state.unrealizedPnl = totalGridUnrealizedPnl;
    state.drawdownPct = state.highWaterEquity > 0
      ? Math.max(0, (state.highWaterEquity - sharedCurrentEquity) / state.highWaterEquity * 100) : 0;
  }
  const sharedDailyCap = n(state.dayStartEquity) * config.dailyLossPct / 100;
  const sharedDailyLossBreach = sharedDayPnl !== null && state.dayStartEquity > 0 &&
    sharedDayPnl + totalGridUnrealizedPnl <= -sharedDailyCap;
  const sharedDrawdownBreach = sharedCurrentEquity !== null &&
    state.highWaterEquity > 0 && state.drawdownPct >= config.maxDrawdownPct;
  const sharedGridStopReason = sharedDailyLossBreach ? 'DAILY_LOSS_LIMIT'
    : sharedDrawdownBreach ? 'OVERALL_DRAWDOWN_STOP' : null;

  const exchangeSymbolPosition = exchangePositions.find(row =>
    text(row?.symbol).toUpperCase() === symbol && n(row?.qty) > 0
  ) || null;
  const dbGridPosition = dbOpenGridRows.find(row => text(row?.symbol).toUpperCase() === symbol) || null;
  const dbSymbolPosition = dbOpenSameSymbolRows[0] || null;
  const matchingGridOrder = gridOrders.find(row =>
    text(row?.symbol).toUpperCase() === symbol &&
    text(row?.strategy).toUpperCase() === 'GRID' &&
    text(row?.client_order_id).toUpperCase().startsWith('DDG-')
  ) || null;
  const clientOrderId = text(
    exchangeSymbolPosition?.client_order_id ||
    dbGridPosition?.client_order_id ||
    matchingGridOrder?.client_order_id
  );
  const exchangeLooksGrid = clientOrderId.toUpperCase().startsWith('DDG-') ||
    text(dbGridPosition?.strategy).toUpperCase() === 'GRID';
  const symbolGridOrders = gridOrders.filter(row =>
    text(row?.symbol).toUpperCase() === symbol &&
    text(row?.strategy).toUpperCase() === 'GRID'
  );
  const pendingState = Array.isArray(state.pendingEntries)
    ? state.pendingEntries.find(row => text(row?.symbol).toUpperCase() === symbol) : null;
  const ambiguousGridOrder = symbolGridOrders.find(row =>
    pendingState && text(row?.client_order_id) === text(pendingState.clientOrderId) &&
    ['FAILED', 'UNKNOWN', 'REJECTED'].includes(text(row?.state).toUpperCase())
  ) || null;
  if (!exchangeSymbolPosition && ambiguousGridOrder) {
    state.status = 'HALTED';
    state.pausedReason = 'GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW';
    return block('GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW');
  }
  const activeGridReservation = symbolGridOrders.find(row =>
    text(row?.role).toUpperCase() === 'ENTRY' &&
    !terminalOrderStates.has(text(row?.state).toUpperCase())
  ) || null;
  const trailingDirection = getTrailingGridBreakoutDirection(mark, config);
  const canExecuteTrailingShift = settings.grid_enabled === true &&
    settings.gridTrailingEnvironmentEnabled === true &&
    settings.grid_trailing_enabled === true &&
    dataFresh === true && pnl.complete === true &&
    sharedCurrentEquity !== null && state.highWaterEquity > 0 &&
    settings.emergency_stop !== true &&
    !settings.gridGlobalHardStopReason && !settings.gridGlobalPauseReason &&
    !sharedGridStopReason && !state.pausedReason &&
    Boolean(trailingDirection);
  if (canExecuteTrailingShift) {
    const shifted = await executeTrailingGridShift({
      executor, database, state, settings, symbol,
      // A trailing shift may only inspect/cancel/close this symbol. Other pool symbols
      // retain their independent positions and their own trailing/risk state.
      configuredSymbols: [symbol], currentConfig: config,
      markPrice: mark, direction: trailingDirection,
      dbOpenGridRows, gridOrders, now
    });
    state = shifted.state;
    if (!shifted.ok) return block(shifted.reason);
    await persist();
    safety.trailingShift = {
      shifted: true, symbol, direction: trailingDirection, at: state.lastTrailingShiftAt
    };
    return { state, safety, trailingShift: safety.trailingShift };
  }

  if (exchangeSymbolPosition && !exchangeLooksGrid) {
    state.status = 'BLOCKED';
    state.lastPrice = mark;
    return block('SAME_SYMBOL_POSITION_NOT_OWNED_BY_GRID');
  }
  if (!exchangeSymbolPosition && dbGridPosition) {
    state.status = 'RECONCILING';
    state.lastPrice = mark;
    return block('GRID_POSITION_RECONCILIATION_PENDING');
  }
  if (!exchangeSymbolPosition && dbSymbolPosition) {
    state.status = 'BLOCKED';
    state.lastPrice = mark;
    return block('SAME_SYMBOL_POSITION_NOT_OWNED_BY_GRID');
  }
  if (!activeGridReservation && !exchangeSymbolPosition && pendingState) {
    const pendingOrderId = numberOrNull(pendingState.exchangeOrderId);
    if (!pendingOrderId || typeof executor.getOrderById !== 'function') {
      state.status = 'HALTED';
      state.pausedReason = 'GRID_ORDER_RECONCILIATION_UNAVAILABLE';
      return block('GRID_ORDER_RECONCILIATION_UNAVAILABLE');
    }
    try {
      const pendingOrder = await executor.getOrderById(pendingOrderId);
      const pendingOrderState = text(pendingOrder?.state).toUpperCase();
      if (!terminalOrderStates.has(pendingOrderState)) {
        if (!hasVerifiedGridBracket(
          pendingOrder, pendingState.stopPrice, pendingState.targetPrice, product.tick_size
        )) {
          const result = await cancelUnverifiedGridEntry({
            executor, database, state, symbol, orderId: pendingOrderId,
            clientOrderId: pendingState.clientOrderId,
            expectedStop: pendingState.stopPrice, expectedTarget: pendingState.targetPrice,
            raw: { stop_price: pendingState.stopPrice, tp_price: pendingState.targetPrice },
            now, mark, verificationError: 'Persisted pending Grid order is missing or has mismatched SL/TP'
          });
          return block(result.reason);
        }
        state.pendingEntries = [{
          ...pendingState,
          unfilledSize: numberOrNull(pendingOrder?.unfilled_size),
          state: pendingOrderState || 'UNKNOWN'
        }];
        state.status = 'ENTRY_PENDING';
        await persist();
        return { state, safety };
      }
      state.status = 'HALTED';
      state.pausedReason = ['FAILED', 'REJECTED', 'EXPIRED'].includes(pendingOrderState)
        ? 'GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW'
        : 'GRID_FILLED_ORDER_WITHOUT_POSITION';
      return block(state.pausedReason);
    } catch (error) {
      state.status = 'HALTED';
      state.pausedReason = 'GRID_ORDER_RECONCILIATION_UNAVAILABLE';
      await database.log('ERROR', 'Persisted Grid entry could not be reconciled with Delta; no retry will be attempted', {
        symbol, pendingOrderId,
        error: String(error?.message || error).slice(0, 220)
      }).catch(() => {});
      return block('GRID_ORDER_RECONCILIATION_UNAVAILABLE');
    }
  }

  if (activeGridReservation && !exchangeSymbolPosition) {
    let raw = activeGridReservation.raw;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const exchangeOrderId = numberOrNull(raw?.testnet_order_id);
    if (!exchangeOrderId || typeof executor.getOrderById !== 'function') {
      state.status = 'HALTED';
      state.pausedReason = 'GRID_ORDER_RECONCILIATION_UNAVAILABLE';
      return block('GRID_ORDER_RECONCILIATION_UNAVAILABLE');
    }
    let exchangeOrder;
    try {
      exchangeOrder = await executor.getOrderById(exchangeOrderId);
    } catch (error) {
      state.status = 'HALTED';
      state.pausedReason = 'GRID_ORDER_RECONCILIATION_UNAVAILABLE';
      await database.log('ERROR', 'Delta Testnet Grid pending order could not be reconciled; no retry will be attempted', {
        symbol, exchangeOrderId,
        error: String(error?.message || error).slice(0, 220)
      }).catch(() => {});
      return block('GRID_ORDER_RECONCILIATION_UNAVAILABLE');
    }
    const exchangeOrderState = text(exchangeOrder?.state).toUpperCase();
    const terminalState = terminalOrderStates.has(exchangeOrderState);
    if (!terminalState && !hasVerifiedGridBracket(
      exchangeOrder,
      pendingState?.stopPrice ?? raw?.stop_price,
      pendingState?.targetPrice ?? raw?.tp_price,
      product.tick_size
    )) {
      const result = await cancelUnverifiedGridEntry({
        executor, database, state, symbol, orderId: exchangeOrderId,
        clientOrderId: activeGridReservation.client_order_id,
        expectedStop: pendingState?.stopPrice ?? raw?.stop_price,
        expectedTarget: pendingState?.targetPrice ?? raw?.tp_price,
        raw, now, mark,
        verificationError: 'Reconciled pending Grid order is missing or has mismatched SL/TP'
      });
      return block(result.reason);
    }
    if (!terminalState && (settings.emergency_stop === true || settings.grid_enabled !== true ||
        settings.auto_trade !== true || settings.enabled === false || settings.continuous_mode === false)) {
      try {
        if (typeof executor.cancelOrderById !== 'function') {
          throw new Error('Cancel-and-verify is unavailable');
        }
        const cancelled = await executor.cancelOrderById(exchangeOrderId);
        const cancelledState = text(cancelled?.state).toUpperCase();
        if (!terminalOrderStates.has(cancelledState)) {
          throw new Error('Exchange order did not reach a terminal cancelled state');
        }
        await database.update('dd_orders',
          'client_order_id=eq.' + encodeURIComponent(text(activeGridReservation.client_order_id)),
          {
            state: cancelledState,
            updated_at: new Date(now()).toISOString(),
            raw: { ...raw, reservation: false, accepted: true, exchange_state: cancelledState, cancelledByGridSafety: true }
          });
        state.pendingEntries = (Array.isArray(state.pendingEntries) ? state.pendingEntries : [])
          .filter(row => text(row?.symbol).toUpperCase() !== symbol);
        if (settings.emergency_stop === true) {
          state.pausedReason = 'EMERGENCY_STOP';
          state.status = 'HALTED';
          pushEvent(state, { type: 'HALT', reason: 'EMERGENCY_STOP', symbol, price: mark }, at);
          await persist();
          return block('EMERGENCY_STOP');
        }
        state.status = 'PAUSED';
        state.lastTickAt = at;
        await persist();
        return block(settings.grid_enabled !== true ? 'GRID_DISABLED'
          : 'AUTO_TRADE_DISABLED');
      } catch (error) {
        state.status = 'HALTED';
        state.pausedReason = 'GRID_ORDER_CANCEL_UNCONFIRMED';
        await database.log('ERROR', 'Delta Testnet Grid entry cancellation is unconfirmed; Grid halted with no retry', {
          symbol, exchangeOrderId,
          error: String(error?.message || error).slice(0, 220),
          doNotBlindlyRetry: true
        }).catch(() => {});
        return block('GRID_ORDER_CANCEL_UNCONFIRMED');
      }
    }
    if (terminalState) {
      if (['FAILED', 'REJECTED', 'EXPIRED'].includes(exchangeOrderState)) {
        state.status = 'HALTED';
        state.pausedReason = 'GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW';
        return block('GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW');
      }
      if (!exchangeSymbolPosition) {
        state.status = 'RECONCILING';
        state.pausedReason = 'GRID_FILLED_ORDER_WITHOUT_POSITION';
        return block('GRID_FILLED_ORDER_WITHOUT_POSITION');
      }
    } else if (!exchangeSymbolPosition) {
      state.pendingEntries = [{
        ...(pendingState || {}),
        symbol, exchangeOrderId: String(exchangeOrderId),
        clientOrderId: text(activeGridReservation.client_order_id),
        unfilledSize: numberOrNull(exchangeOrder?.unfilled_size),
        state: exchangeOrderState || 'UNKNOWN'
      }];
      state.status = 'ENTRY_PENDING';
      state.lastPrice = mark;
      await persist();
      return { state, safety };
    }
  }

  let livePosition = null;
  if (exchangeSymbolPosition) {
    if (exchangeSymbolPosition.side !== 'BUY') {
      state.status = 'HALTED';
      state.pausedReason = 'GRID_UNSUPPORTED_POSITION_SIDE';
      return block('GRID_UNSUPPORTED_POSITION_SIDE');
    }
    const parentOrderId = dbGridPosition?.entry_order_id ||
      (clientOrderId && gridOrders.find(row => row.client_order_id === clientOrderId)?.raw?.testnet_order_id) ||
      dbGridPosition?.order_id;
    let parentOrder = null;
    try {
      if (!parentOrderId || typeof executor.getOrderById !== 'function') {
        throw new Error('Entry order identity lookup is unavailable');
      }
      parentOrder = await executor.getOrderById(parentOrderId);
    } catch (error) {
      await database.log('WARN', 'Delta Testnet Grid bracket verification failed; position will be closed fail-closed', {
        symbol, parentOrderId: parentOrderId || null,
        error: String(error?.message || error).slice(0, 200)
      }).catch(() => {});
    }
    const actualStop = numberOrNull(parentOrder?.bracket_stop_loss_price);
    const actualTarget = numberOrNull(parentOrder?.bracket_take_profit_price);
    const expectedStop = numberOrNull(dbGridPosition?.sl_price);
    const expectedTarget = numberOrNull(dbGridPosition?.tp_price);
    const protectionVerified = actualStop !== null && actualTarget !== null &&
      actualStop > 0 && actualTarget > 0 &&
      (expectedStop === null || samePrice(actualStop, expectedStop, product.tick_size)) &&
      (expectedTarget === null || samePrice(actualTarget, expectedTarget, product.tick_size)) &&
      actualStop < n(exchangeSymbolPosition.entry_price) &&
      actualTarget > n(exchangeSymbolPosition.entry_price);

    if (!protectionVerified) {
      let closed = false;
      try {
        const result = await closeAndVerify(executor, symbol, exchangeSymbolPosition.qty);
        closed = result.closed;
      } catch (error) {
        await database.log('ERROR', 'Delta Testnet Grid position protection could not be verified or closed', {
          symbol, qty: exchangeSymbolPosition.qty,
          error: String(error?.message || error).slice(0, 220)
        }).catch(() => {});
      }
      state.positions = closed ? [] : [{
        ...(state.positions[0] || {}),
        symbol, qty: exchangeSymbolPosition.qty,
        entryPrice: exchangeSymbolPosition.entry_price,
        stopPrice: expectedStop, targetPrice: expectedTarget
      }];
      state.status = 'HALTED';
      state.pausedReason = 'GRID_PROTECTION_UNVERIFIED';
      pushEvent(state, { type: 'HALT', reason: state.pausedReason, symbol, price: mark }, at);
      await persist();
      return block(closed ? 'GRID_PROTECTION_UNVERIFIED_POSITION_CLOSED' : 'GRID_PROTECTION_UNVERIFIED_EXIT_FAILED');
    }

    const priorPosition = state.positions.find(position =>
      text(position?.bridgeExecutionId) === clientOrderId
    ) || state.positions[0] || {};
    const levels = config.levels;
    const entryPrice = n(exchangeSymbolPosition.entry_price);
    const nearestLevel = levels.reduce((best, level) =>
      Math.abs(level.price - entryPrice) < Math.abs(best.price - entryPrice) ? level : best
    , levels[0] || { index: 0 });
    const levelIndex = Number.isInteger(Number(priorPosition.levelIndex))
      ? Number(priorPosition.levelIndex) : n(nearestLevel.index);
    const qty = n(exchangeSymbolPosition.qty);
    const cv = n(product.contract_value) || 1;
    const riskUsd = Math.max(0, (entryPrice - actualStop) * qty * cv);
    livePosition = {
      id: priorPosition.id || clientOrderId || 'DDG-' + symbol,
      bridgeExecutionId: clientOrderId || null,
      symbol, levelIndex, entryPrice, targetPrice: actualTarget, stopPrice: actualStop, qty,
      riskUsd,
      openedAt: dbGridPosition?.opened_at || exchangeSymbolPosition.opened_at || at,
      exchangeOrderId: String(parentOrderId)
    };
    state.positions = [livePosition];
    state.pendingEntries = (Array.isArray(state.pendingEntries) ? state.pendingEntries : [])
      .filter(row => text(row?.symbol).toUpperCase() !== symbol);
    state.openRiskUsd = riskUsd;
    state.unrealizedPnl = totalGridUnrealizedPnl;
    state.currentEquity = pnl.complete && state.unrealizedPnl !== null
      ? n(state.strategyStartEquity) + n(pnl.realizedPnl) + state.unrealizedPnl : null;
    if (state.currentEquity !== null) {
      state.highWaterEquity = Math.max(n(state.highWaterEquity), state.currentEquity);
      state.drawdownPct = state.highWaterEquity > 0
        ? Math.max(0, (state.highWaterEquity - state.currentEquity) / state.highWaterEquity * 100) : 0;
    }
    const dailyCap = n(state.dayStartEquity) * config.dailyLossPct / 100;
    const dailyBreach = pnl.complete && state.unrealizedPnl !== null &&
      n(pnl.dayPnl) + state.unrealizedPnl <= -dailyCap;
    const drawdownBreach = state.currentEquity !== null &&
      n(state.highWaterEquity) > 0 && state.drawdownPct >= config.maxDrawdownPct;
    const rangeBreak = config.valid && (
      mark < config.lowerPrice * (1 - config.breakoutExitPct / 100) ||
      mark > config.upperPrice * (1 + config.breakoutExitPct / 100)
    );
    const exitReason = settings.emergency_stop === true ? 'EMERGENCY_STOP'
      : settings.gridGlobalHardStopReason || sharedGridStopReason
        ? (settings.gridGlobalHardStopReason || sharedGridStopReason)
        : rangeBreak ? 'GRID_RANGE_BREAK'
          : dailyBreach ? 'DAILY_LOSS_LIMIT'
            : drawdownBreach ? 'OVERALL_DRAWDOWN_STOP' : null;

    if (exitReason) {
      try {
        const close = await closeAndVerify(executor, symbol, qty);
        if (!close.closed) throw new Error('Exchange still reports an open Grid position after reduce-only exit');
        state.positions = [];
        state.openRiskUsd = 0;
        state.unrealizedPnl = 0;
        state.pausedReason = exitReason;
        state.status = 'HALTED';
        pushEvent(state, { type: 'HALT', reason: exitReason, symbol, price: mark }, at);
        await database.log('WARN', 'Delta Testnet Grid hard-stop exit verified flat on exchange', {
          symbol, qty, reason: exitReason, orderId: close.order?.id ?? null
        }).catch(() => {});
      } catch (error) {
        state.pausedReason = 'GRID_EXIT_UNCONFIRMED';
        state.status = 'HALTED';
        safety.blocked = true;
        safety.reason = 'GRID_EXIT_UNCONFIRMED';
        await database.log('ERROR', 'Delta Testnet Grid hard-stop exit is unconfirmed; no new entry will be attempted', {
          symbol, qty, reason: exitReason,
          error: String(error?.message || error).slice(0, 220)
        }).catch(() => {});
      }
    } else {
      state.lastPrice = mark;
      state.currentPrice = mark;
      state.lastTickAt = at;
      state.wasEnabled = settings.grid_enabled === true;
      state.status = settings.grid_enabled === true ? 'ACTIVE' : 'PAUSED';
      if (!pnl.complete || state.unrealizedPnl === null) {
        safety.blocked = true;
        safety.reason = 'GRID_PNL_UNVERIFIED';
      }
    }
    await persist();
    return { state, safety };
  }

  state.positions = [];
  state.openRiskUsd = 0;
  state.unrealizedPnl = totalGridUnrealizedPnl;
  state.realizedPnl = pnl.complete ? pnl.realizedPnl : null;
  state.dayPnl = pnl.complete ? pnl.dayPnl : null;
  state.trades = pnl.complete ? pnl.trades : [];
  state.currentEquity = sharedCurrentEquity !== null
    ? sharedCurrentEquity
    : (pnl.complete
      ? (n(state.strategyStartEquity) > 0 ? n(state.strategyStartEquity) + n(pnl.realizedPnl) : n(account.equity))
      : null);
  if (state.currentEquity !== null) {
    state.highWaterEquity = Math.max(n(state.highWaterEquity), state.currentEquity);
    state.drawdownPct = state.highWaterEquity > 0
      ? Math.max(0, (state.highWaterEquity - state.currentEquity) / state.highWaterEquity * 100) : 0;
  }
  if (state.tradeDate !== today) {
    state.tradeDate = today;
    state.dayStartEquity = n(state.strategyStartEquity) +
      n(pnl.complete ? pnl.realizedPnl - pnl.dayPnl : 0);
  }

  const momentum = detectOneWayMomentum(candles, config.momentumPausePct, 0.75);
  state.momentum = momentum;
  state.lastPrice = mark;
  state.currentPrice = mark;
  state.lastTickAt = at;

  if (settings.emergency_stop === true) {
    state.pausedReason = 'EMERGENCY_STOP';
    state.status = 'HALTED';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, symbol, price: mark }, at);
    await persist();
    return block('EMERGENCY_STOP');
  }
  const gridGlobalPauseReason = gridPnlPauseRecovered &&
    settings.gridGlobalPauseReason === 'GRID_PNL_UNVERIFIED'
    ? null : settings.gridGlobalPauseReason;
  if (sharedGridStopReason || gridGlobalPauseReason) {
    const reason = gridGlobalPauseReason || sharedGridStopReason;
    state.pausedReason = reason;
    state.status = 'HALTED';
    pushEvent(state, { type: 'HALT', reason, symbol, price: mark }, at);
    await persist();
    return block(reason);
  }
  if (!settings.grid_enabled) {
    state.status = state.pausedReason ? 'HALTED' : 'OFF';
    state.wasEnabled = false;
    await persist();
    return { state, safety };
  }
  if (state.pausedReason) {
    state.status = 'HALTED';
    await persist();
    return block(state.pausedReason);
  }
  if (!config.valid) {
    state.status = 'NEEDS_RANGE';
    state.wasEnabled = false;
    await persist();
    return block('GRID_RANGE_NOT_CONFIGURED');
  }
  if (!pnl.complete) {
    state.status = 'BLOCKED';
    state.wasEnabled = true;
    pushEvent(state, { type: 'BLOCK', reason: 'GRID_PNL_UNVERIFIED', symbol, price: mark }, at);
    await persist();
    return block('GRID_PNL_UNVERIFIED');
  }
  if (settings.enabled === false || settings.auto_trade !== true || settings.continuous_mode === false) {
    state.status = 'PAUSED';
    state.wasEnabled = false;
    await persist();
    return block('AUTO_TRADE_DISABLED');
  }
  if (!dataFresh || !Array.isArray(candles) || candles.length < 6) {
    state.status = 'BLOCKED';
    state.wasEnabled = true;
    pushEvent(state, { type: 'BLOCK', reason: 'GRID_CANDLE_DATA_STALE', symbol, price: mark }, at);
    await persist();
    return block('GRID_CANDLE_DATA_STALE');
  }
  if (momentum.paused) {
    state.status = 'MOMENTUM_PAUSE';
    state.wasEnabled = true;
    pushEvent(state, { type: 'PAUSE', reason: 'STRONG_ONE_WAY_MOMENTUM', direction: momentum.direction, movePct: momentum.movePct, symbol }, at);
    await persist();
    return block('STRONG_ONE_WAY_MOMENTUM');
  }

  const evaluation = evaluateGridTick({
    settings: { ...settings, grid_enabled: true, grid_symbol: symbol, grid_max_positions: 1 },
    state,
    price: mark,
    equity: n(account.equity),
    available: n(account.available),
    contractValue: n(product.contract_value) || 1,
    makerFeeRate: numberOrNull(product.taker_commission_rate) ?? numberOrNull(product.maker_commission_rate) ?? 0.0006,
    slippagePct: 0.02,
    candles,
    dataFresh,
    emergencyStop: false,
    timestamp,
    maxLeverage: n(settings.max_leverage) || 3
  });
  state = evaluation.state;
  state.executionMode = 'DELTA_TESTNET';
  state.realizedPnl = pnl.realizedPnl;
  state.dayPnl = pnl.dayPnl;
  state.trades = pnl.trades;
  state.positions = [];
  state.openRiskUsd = 0;
  state.unrealizedPnl = totalGridUnrealizedPnl;
  state.currentEquity = sharedCurrentEquity;
  if (state.currentEquity !== null) {
    state.highWaterEquity = Math.max(n(state.highWaterEquity), state.currentEquity);
    state.drawdownPct = state.highWaterEquity > 0
      ? Math.max(0, (state.highWaterEquity - state.currentEquity) / state.highWaterEquity * 100) : 0;
  }

  const candidate = evaluation.entered[0];
  if (candidate && gridPositionCapBlocked) {
    state.status = 'BLOCKED';
    await persist();
    return block(gridPositionCap.reason || 'GRID_STRATEGY_POSITION_CAP_UNAVAILABLE');
  }
  if (!candidate) {
    await persist();
    return { state, safety };
  }
  const adjusted = sizeDeltaGridEntry({
    candidate: { ...candidate, entryPrice: mark },
    settings: { ...settings, grid_max_positions: 1 },
    account,
    product,
    riskEquity: n(state.dayStartEquity) || n(account.equity),
    remainingDailyRisk: Math.max(0,
      n(state.dayStartEquity) * config.dailyLossPct / 100 -
      Math.max(0, -n(pnl.dayPnl)) -
      Math.max(0, -n(totalGridUnrealizedPnl)) -
      Math.max(0, n(settings.gridGlobalOpenRiskUsd))),
    consecutiveLosses: pnl.consecutiveLosses,
    minStopDistancePct: resolveMinimumStopDistancePct(process.env.DELTA_MIN_SL_DISTANCE_PCT)
  });
  if (!adjusted.ok) {
    pushEvent(state, { type: 'BLOCK', reason: adjusted.reason, symbol, price: mark, levelIndex: candidate.levelIndex }, at);
    state.status = 'BLOCKED';
    state.wasEnabled = true;
    await persist();
    return block(adjusted.reason);
  }

  const executionClientId = 'DDG-' + symbol + '-G' +
    (n(candidate.levelIndex) + 1) + '-' + Math.floor(timestamp / 1000).toString(36);
  let submittedOrder = null;
  let submittedOrderId = null;
  let bracketVerified = false;
  try {
    submittedOrder = await executor.placeBracketOrder(
      symbol, 'BUY', adjusted.qty, adjusted.entryPrice,
      adjusted.stopPrice, adjusted.targetPrice,
      { strategy: 'GRID', clientOrderId: executionClientId, orderType: 'limit_order' }
    );
    const orderId = submittedOrder?.id ?? submittedOrder?.order_id;
    submittedOrderId = numberOrNull(orderId);
    if (!(numberOrNull(orderId) > 0)) {
      throw new Error('Grid limit entry did not return an exchange order identity; outcome remains reserved');
    }
    if (typeof executor.getOrderById !== 'function') throw new Error('Exchange order detail lookup is unavailable for bracket verification');
    const detail = await executor.getOrderById(orderId);
    const verifiedStop = numberOrNull(detail?.bracket_stop_loss_price);
    const verifiedTarget = numberOrNull(detail?.bracket_take_profit_price);
    if (!hasVerifiedGridBracket(detail, adjusted.stopPrice, adjusted.targetPrice, product.tick_size)) {
      const result = await cancelUnverifiedGridEntry({
        executor, database, state, symbol, orderId,
        clientOrderId: executionClientId,
        expectedStop: adjusted.stopPrice, expectedTarget: adjusted.targetPrice,
        raw: { stop_price: adjusted.stopPrice, tp_price: adjusted.targetPrice },
        now, mark,
        verificationError: 'Freshly accepted Grid order did not confirm both requested bracket prices'
      });
      await persist();
      return block(result.reason);
    }
    bracketVerified = true;
    const orderState = text(submittedOrder?.state || detail?.state).toUpperCase();
    const unfilledSize = numberOrNull(submittedOrder?.unfilled_size ?? detail?.unfilled_size);
    if (['OPEN', 'PENDING', 'NEW', 'PARTIALLY_FILLED'].includes(orderState) &&
        unfilledSize !== null && unfilledSize > 0) {
      state.pendingEntries = [{
        symbol, levelIndex: n(candidate.levelIndex), qty: adjusted.qty,
        limitPrice: adjusted.entryPrice, stopPrice: verifiedStop, targetPrice: verifiedTarget,
        exchangeOrderId: String(orderId), clientOrderId: executionClientId,
        unfilledSize, riskUsd: n(adjusted.riskUsd), state: orderState, createdAt: at
      }];
      state.status = 'ENTRY_PENDING';
      state.wasEnabled = true;
      state.lastPrice = mark;
      pushEvent(state, {
        type: 'ENTRY_PENDING', symbol, levelIndex: n(candidate.levelIndex),
        price: adjusted.entryPrice, qty: adjusted.qty, orderId: String(orderId)
      }, at);
      await persist();
      return { state, safety };
    }
    if (!['CLOSED', 'FILLED'].includes(orderState) || unfilledSize !== 0) {
      throw new Error('Grid limit order acknowledgement is ambiguous; reservation retained and Grid halted');
    }
    const filledPosition = await findOpenPosition(executor, symbol);
    if (!filledPosition || filledPosition.side !== 'BUY' || !(n(filledPosition.qty) > 0)) {
      throw new Error('Filled Grid entry has no matching open Delta Testnet position snapshot');
    }
    const entryFill = n(filledPosition.entry_price) || adjusted.entryPrice;
    const fillAssessment = assessDeltaGridEntryFill({
      entryPrice: entryFill,
      stopPrice: verifiedStop,
      targetPrice: verifiedTarget,
      qty: filledPosition.qty,
      product,
      riskBudget: adjusted.riskBudget,
      feeRate: adjusted.feeRate,
      slippageRate: adjusted.slippageRate,
      minStopDistancePct: adjusted.minStopDistancePct
    });
    if (!fillAssessment.ok) {
      const close = await closeAndVerify(executor, symbol, filledPosition.qty);
      if (!close.closed) {
        throw new Error(fillAssessment.reason + '; immediate reduce-only close is not confirmed');
      }
      state.positions = [];
      state.openRiskUsd = 0;
      state.unrealizedPnl = 0;
      state.pausedReason = 'GRID_FILLED_RISK_REJECTED';
      state.status = 'HALTED';
      pushEvent(state, { type: 'HALT', reason: state.pausedReason, symbol, price: mark }, at);
      await database.log('ERROR', 'Delta Testnet Grid fill breached its pre-trade risk envelope; position closed and Grid halted', {
        symbol, clientOrderId: executionClientId, orderId: String(orderId),
        entry: entryFill, stop: verifiedStop, target: verifiedTarget,
        fillAssessment, closeOrderId: close.order?.id ?? null
      }).catch(() => {});
      await persist();
      return block('GRID_FILLED_RISK_REJECTED_POSITION_CLOSED');
    }
    const actualRiskUsd = fillAssessment.riskUsd;
    state.positions = [{
      id: executionClientId,
      bridgeExecutionId: executionClientId,
      symbol,
      levelIndex: n(candidate.levelIndex),
      entryPrice: entryFill,
      targetPrice: verifiedTarget,
      stopPrice: verifiedStop,
      qty: n(filledPosition.qty),
      riskUsd: Math.max(0, actualRiskUsd),
      openedAt: filledPosition.opened_at || at,
      exchangeOrderId: String(orderId)
    }];
    state.openRiskUsd = Math.max(0, actualRiskUsd);
    state.unrealizedPnl = numberOrNull(filledPosition.unrealized_pnl);
    state.currentPrice = numberOrNull(filledPosition.current_price) ?? mark;
    state.lastPrice = mark;
    state.currentEquity = n(state.strategyStartEquity) + n(state.realizedPnl) + n(state.unrealizedPnl);
    state.highWaterEquity = Math.max(n(state.highWaterEquity), state.currentEquity);
    state.drawdownPct = state.highWaterEquity > 0
      ? Math.max(0, (state.highWaterEquity - state.currentEquity) / state.highWaterEquity * 100) : 0;
    state.wasEnabled = true;
    state.status = 'ACTIVE';
    pushEvent(state, {
      type: 'ENTRY', symbol, levelIndex: n(candidate.levelIndex),
      price: entryFill, targetPrice: verifiedTarget, stopPrice: verifiedStop,
      qty: n(filledPosition.qty), riskUsd: state.openRiskUsd,
      executionMode: 'DELTA_TESTNET', orderId: String(orderId)
    }, at);
    await database.log('INFO', 'Delta Testnet Grid entry filled with exchange bracket protection verified', {
      symbol, side: 'BUY', qty: n(filledPosition.qty), entry: entryFill,
      stop: verifiedStop, target: verifiedTarget, orderId: String(orderId),
      clientOrderId: executionClientId, gridLevel: n(candidate.levelIndex) + 1,
      riskUsd: state.openRiskUsd, rewardRiskRatio: fillAssessment.rewardRiskRatio
    }).catch(() => {});
    await persist();
    return { state, safety };
  } catch (error) {
    if (!bracketVerified) {
      let reservation = null;
      let reservationLookupFailed = false;
      if (submittedOrder || submittedOrderId) {
        reservation = { state: 'PENDING', raw: {} };
      } else if (typeof database.select === 'function') {
        try {
          const rows = await database.select(
            'dd_orders',
            'client_order_id=eq.' + encodeURIComponent(executionClientId) +
              '&select=state,raw&limit=1'
          );
          reservation = Array.isArray(rows) ? rows[0] || null : null;
        } catch {
          reservationLookupFailed = true;
        }
      }
      const reservationState = text(reservation?.state).toUpperCase();
      const mayHaveBeenAccepted = Boolean(submittedOrder || submittedOrderId || reservationLookupFailed ||
        (reservation && !['FAILED', 'REJECTED', 'EXPIRED'].includes(reservationState)));
      if (mayHaveBeenAccepted) {
        const raw = parseOrderRaw(reservation?.raw);
        const result = await cancelUnverifiedGridEntry({
          executor, database, state, symbol,
          orderId: submittedOrderId ?? raw.testnet_order_id,
          clientOrderId: executionClientId,
          expectedStop: adjusted.stopPrice, expectedTarget: adjusted.targetPrice,
          raw: { ...raw, stop_price: adjusted.stopPrice, tp_price: adjusted.targetPrice },
          now, mark,
          verificationError: String(error?.message || error).slice(0, 220)
        });
        await persist();
        return block(result.reason);
      }
    }
    state.positions = [];
    state.pausedReason = 'GRID_ENTRY_UNCONFIRMED';
    state.status = 'HALTED';
    state.wasEnabled = true;
    state.lastPrice = mark;
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, symbol, price: mark }, at);
    await database.log('ERROR', 'Delta Testnet Grid entry or bracket verification failed; reservation retained and no retry will be attempted', {
      symbol, clientOrderId: executionClientId, qty: adjusted.qty,
      stop: adjusted.stopPrice, target: adjusted.targetPrice,
      error: String(error?.message || error).slice(0, 240),
      doNotBlindlyRetry: true
    }).catch(() => {});
    await persist();
    return block('GRID_ENTRY_UNCONFIRMED');
  }
}
