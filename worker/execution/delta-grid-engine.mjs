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

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
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
  const stop = roundStopLossAwayFromEntry(Math.min(nativeStop, floorStop), tick, 'BUY');
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
  const qtyByMargin = Math.floor((available * leverage) / notionalPerContract);
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
  now = () => Date.now()
} = {}) {
  const timestamp = now();
  const at = new Date(timestamp).toISOString();
  const symbol = ['BTCUSD', 'ETHUSD'].includes(text(settings.grid_symbol).toUpperCase())
    ? text(settings.grid_symbol).toUpperCase() : 'ETHUSD';
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
  try {
    const [closedPositions, closedPositionCount, trades, tradeCount] = await Promise.all([
      database.select('dd_delta_positions', closedPositionQuery),
      database.count('dd_delta_positions', 'strategy=eq.GRID&status=in.(CLOSED,CLOSED_EXTERNALLY)&select=id'),
      database.select('dd_trades', tradeQuery),
      database.count('dd_trades', 'strategy=eq.GRID&select=id')
    ]);
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
      symbol, error: String(error?.message || error).slice(0, 220)
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

  const exchangeGridPositions = exchangePositions.filter(row =>
    text(row?.client_order_id).toUpperCase().startsWith('DDG-') && n(row?.qty) > 0
  );
  if (exchangeGridPositions.length > 1 || dbOpenGridRows.length > 1 ||
      exchangeGridPositions.some(row => text(row.symbol).toUpperCase() !== symbol) ||
      dbOpenGridRows.some(row => text(row.symbol).toUpperCase() !== symbol)) {
    state.status = 'HALTED';
    state.pausedReason = 'GRID_SINGLE_POSITION_INVARIANT_BROKEN';
    return block('GRID_SINGLE_POSITION_INVARIANT_BROKEN');
  }

  const exchangeSymbolPosition = exchangePositions.find(row =>
    text(row?.symbol).toUpperCase() === symbol && n(row?.qty) > 0
  ) || null;
  const dbGridPosition = dbOpenGridRows.find(row => text(row?.symbol).toUpperCase() === symbol) || null;
  const dbSymbolPosition = dbOpenSameSymbolRows[0] || null;
  const clientOrderId = text(exchangeSymbolPosition?.client_order_id || dbGridPosition?.client_order_id);
  const exchangeLooksGrid = clientOrderId.toUpperCase().startsWith('DDG-') ||
    text(dbGridPosition?.strategy).toUpperCase() === 'GRID';
  const activeGridReservation = gridOrders.find(row =>
    !terminalOrderStates.has(text(row?.state).toUpperCase())
  ) || null;

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
  if (!exchangeSymbolPosition && activeGridReservation) {
    state.status = 'RECONCILING';
    state.lastPrice = mark;
    return block('GRID_ORDER_RESERVATION_PENDING');
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
    state.openRiskUsd = riskUsd;
    state.unrealizedPnl = numberOrNull(exchangeSymbolPosition.unrealized_pnl);
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
  state.unrealizedPnl = 0;
  state.realizedPnl = pnl.complete ? pnl.realizedPnl : null;
  state.dayPnl = pnl.complete ? pnl.dayPnl : null;
  state.trades = pnl.complete ? pnl.trades : [];
  state.currentEquity = pnl.complete
    ? (n(state.strategyStartEquity) > 0 ? n(state.strategyStartEquity) + n(pnl.realizedPnl) : n(account.equity))
    : null;
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

  const candidate = evaluation.entered[0];
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
      n(state.dayStartEquity) * config.dailyLossPct / 100 - Math.max(0, -n(pnl.dayPnl))),
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
  try {
    const order = await executor.placeBracketOrder(
      symbol, 'BUY', adjusted.qty, adjusted.entryPrice,
      adjusted.stopPrice, adjusted.targetPrice,
      { strategy: 'GRID', clientOrderId: executionClientId }
    );
    const orderId = order?.id ?? order?.order_id;
    if (!(numberOrNull(orderId) > 0) || !['CLOSED', 'FILLED'].includes(text(order?.state).toUpperCase()) ||
        numberOrNull(order?.unfilled_size) !== 0) {
      throw new Error('Grid market entry did not return a fully filled exchange order; outcome remains reserved');
    }
    if (typeof executor.getOrderById !== 'function') throw new Error('Exchange order detail lookup is unavailable for bracket verification');
    const detail = await executor.getOrderById(orderId);
    const verifiedStop = numberOrNull(detail?.bracket_stop_loss_price);
    const verifiedTarget = numberOrNull(detail?.bracket_take_profit_price);
    if (!samePrice(verifiedStop, adjusted.stopPrice, product.tick_size) ||
        !samePrice(verifiedTarget, adjusted.targetPrice, product.tick_size)) {
      throw new Error('Exchange order detail did not confirm both attached Grid bracket prices');
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
