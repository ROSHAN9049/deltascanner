const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, n(value)));
export const GRID_SYMBOLS = Object.freeze(['BTCUSD', 'ETHUSD']);

export function buildGridLevels(lowerPrice, upperPrice, levelCount) {
  const lower = n(lowerPrice), upper = n(upperPrice), count = Math.round(n(levelCount));
  if (!(lower > 0) || !(upper > lower)) return [];
  if (count < 8 || count > 12) return [];
  const spacing = (upper - lower) / (count - 1);
  return Array.from({ length: count }, (_, index) => ({
    index,
    price: Number((lower + spacing * index).toPrecision(12)),
    entryEnabled: index < count - 1,
    targetIndex: index < count - 1 ? index + 1 : null
  }));
}

export function normalizeGridConfig(settings = {}) {
  const symbol = GRID_SYMBOLS.includes(String(settings.grid_symbol || '').toUpperCase())
    ? String(settings.grid_symbol || '').toUpperCase() : 'ETHUSD';
  const lowerPrice = n(settings.grid_lower_price);
  const upperPrice = n(settings.grid_upper_price);
  const levelCount = Math.round(clamp(settings.grid_levels_count || 10, 8, 12));
  const maxPositions = Math.round(clamp(settings.grid_max_positions || 4, 3, 4));
  const riskPerTradePct = clamp(settings.grid_risk_per_trade_pct || 1, 1, 1.5);
  const dailyLossPct = clamp(settings.grid_daily_loss_pct || 2, 2, 2.5);
  const maxDrawdownPct = clamp(settings.grid_max_drawdown_pct || 5, 0.5, 5);
  const breakoutExitPct = 1.2;
  const momentumPausePct = clamp(settings.grid_momentum_pause_pct || 2.5, 2.5, 3);
  const reduceAfterLosses = settings.grid_reduce_after_losses !== false;
  const enabled = settings.grid_enabled === true;
  const levels = buildGridLevels(lowerPrice, upperPrice, levelCount);
  return {
    enabled, symbol, lowerPrice, upperPrice, levelCount, maxPositions,
    riskPerTradePct, dailyLossPct, maxDrawdownPct, breakoutExitPct,
    momentumPausePct, reduceAfterLosses, levels,
    valid: lowerPrice > 0 && upperPrice > lowerPrice && levels.length === levelCount
  };
}

export function createGridState() {
  return {
    version: 1,
    status: 'OFF',
    positions: [],
    trades: [],
    events: [],
    realizedPnl: 0,
    dayPnl: 0,
    dayStartEquity: 0,
    strategyStartEquity: 0,
    highWaterEquity: 0,
    consecutiveLosses: 0,
    pausedReason: null,
    lastPrice: 0,
    currentPrice: 0,
    unrealizedPnl: 0,
    currentEquity: 0,
    drawdownPct: 0,
    openRiskUsd: 0,
    tradeDate: null,
    lastTickAt: null,
    wasEnabled: false,
    momentum: { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 }
  };
}

function indiaDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

export function detectOneWayMomentum(candles, thresholdPct = 2.5, maxReversalPct = 0.75) {
  const rows = Array.isArray(candles) ? candles.slice(-16) : [];
  const valid = rows.filter(row => n(row?.close) > 0);
  if (valid.length < 6) {
    return { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 };
  }
  const first = n(valid[0].close), last = n(valid[valid.length - 1].close);
  if (!(first > 0 && last > 0)) return { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 };
  const changePct = (last / first - 1) * 100;
  const high = Math.max(...valid.map(row => n(row.high) || n(row.close)));
  const low = Math.min(...valid.map(row => n(row.low) || n(row.close)));
  if (changePct >= thresholdPct && high > 0) {
    const retracementPct = Math.max(0, (high - last) / high * 100);
    return { paused: retracementPct <= maxReversalPct, direction: 'UP', movePct: changePct, retracementPct };
  }
  if (changePct <= -thresholdPct && low > 0) {
    const retracementPct = Math.max(0, (last - low) / low * 100);
    return { paused: retracementPct <= maxReversalPct, direction: 'DOWN', movePct: changePct, retracementPct };
  }
  return { paused: false, direction: 'NONE', movePct: changePct, retracementPct: 0 };
}

function pushEvent(state, event, at) {
  const events = Array.isArray(state.events) ? state.events : [];
  const last = events.at(-1);
  const ageMs = last ? new Date(at).getTime() - new Date(last.at || 0).getTime() : Infinity;
  const sameEvent = last && last.type === event.type &&
    last.reason === event.reason &&
    last.levelIndex === event.levelIndex;
  if (sameEvent && ageMs >= 0 && ageMs < 60000) return;
  state.events = [...events, { ...event, at }].slice(-80);
}
function openRisk(state) {
  return (state.positions || []).reduce((sum, position) => sum + Math.max(0, n(position.riskUsd)), 0);
}
function estimateUnrealized(state, price, contractValue, makerFeeRate, slippageRate) {
  return (state.positions || []).reduce((sum, position) => {
    const qty = n(position.qty), entry = n(position.entryPrice);
    const gross = (price - entry) * qty * contractValue;
    const costs = (entry + price) * qty * contractValue * (makerFeeRate + slippageRate);
    return sum + gross - costs;
  }, 0);
}

function closePosition(state, position, exitPrice, reason, {
  contractValue, makerFeeRate, slippageRate, at, symbol
}) {
  const qty = n(position.qty), entryPrice = n(position.entryPrice);
  const grossPnl = (exitPrice - entryPrice) * qty * contractValue;
  const feesAndSlippage = (entryPrice + exitPrice) * qty * contractValue * (makerFeeRate + slippageRate);
  const netPnl = grossPnl - feesAndSlippage;
  const trade = {
    id: position.id,
    symbol,
    levelIndex: position.levelIndex,
    entryPrice,
    exitPrice,
    targetPrice: position.targetPrice,
    qty,
    grossPnl,
    feesAndSlippage,
    netPnl,
    reason,
    openedAt: position.openedAt,
    closedAt: at
  };
  state.realizedPnl = n(state.realizedPnl) + netPnl;
  state.dayPnl = n(state.dayPnl) + netPnl;
  if (netPnl < 0) state.consecutiveLosses = n(state.consecutiveLosses) + 1;
  else if (netPnl > 0) state.consecutiveLosses = 0;
  state.trades = [...(Array.isArray(state.trades) ? state.trades : []), trade].slice(-100);
  pushEvent(state, {
    type: 'EXIT',
    symbol,
    levelIndex: position.levelIndex,
    price: exitPrice,
    qty,
    pnl: netPnl,
    reason
  }, at);
  return trade;
}

function closeAll(state, price, reason, costs) {
  const positions = [...(state.positions || [])];
  state.positions = [];
  for (const position of positions) closePosition(state, position, price, reason, costs);
}

function currentEquity(state, price, contractValue, makerFeeRate, slippageRate) {
  const unrealized = estimateUnrealized(state, price, contractValue, makerFeeRate, slippageRate);
  return {
    unrealized,
    equity: n(state.strategyStartEquity) + n(state.realizedPnl) + unrealized
  };
}

export function evaluateGridTick({
  settings = {}, state: priorState = null, price, equity = 0, available = 0,
  contractValue = 1, makerFeeRate = 0.0002, slippagePct = 0.02,
  candles = [], dataFresh = true, emergencyStop = false, timestamp = Date.now(), maxLeverage = 3
} = {}) {
  const cfg = normalizeGridConfig(settings);
  const base = createGridState();
  const prior = priorState && typeof priorState === 'object' ? priorState : {};
  const state = {
    ...base, ...prior,
    positions: Array.isArray(prior.positions) ? prior.positions.map(position => ({ ...position })) : [],
    trades: Array.isArray(prior.trades) ? [...prior.trades] : [],
    events: Array.isArray(prior.events) ? [...prior.events] : []
  };
  const currentPrice = n(price);
  const capital = n(equity);
  const cv = n(contractValue) > 0 ? n(contractValue) : 1;
  const feeRate = Number.isFinite(Number(makerFeeRate)) && n(makerFeeRate) >= 0 ? n(makerFeeRate) : 0.0002;
  const slipRate = clamp(slippagePct, 0, 0.25) / 100;
  const at = new Date(timestamp).toISOString();
  const day = indiaDate(timestamp);
  if (!(currentPrice > 0)) return { state, events: [], entered: [], exited: [], config: cfg };

  if (!(state.strategyStartEquity > 0) && capital > 0) {
    state.strategyStartEquity = capital;
    state.highWaterEquity = capital;
    state.dayStartEquity = capital;
  }
  if (state.tradeDate !== day) {
    state.tradeDate = day;
    state.dayPnl = 0;
    const equityAtDayStart = n(state.strategyStartEquity) + n(state.realizedPnl);
    state.dayStartEquity = equityAtDayStart > 0 ? equityAtDayStart : capital;
    if (state.pausedReason === 'DAILY_LOSS_LIMIT') state.pausedReason = null;
    if (!state.pausedReason && cfg.enabled) pushEvent(state, { type: 'INFO', reason: 'NEW_TRADING_DAY' }, at);
  }

  const previousPrice = n(state.lastPrice);
  const wasEnabled = state.wasEnabled === true;
  const entered = [];
  const exited = [];
  const costArgs = { contractValue: cv, makerFeeRate: feeRate, slippageRate: slipRate, at, symbol: cfg.symbol };

  if (!state.pausedReason && cfg.valid && (cfg.enabled || state.positions.length > 0) &&
      (currentPrice < cfg.lowerPrice * (1 - cfg.breakoutExitPct / 100) ||
       currentPrice > cfg.upperPrice * (1 + cfg.breakoutExitPct / 100))) {
    closeAll(state, currentPrice, 'GRID_RANGE_BREAK', costArgs);
    state.pausedReason = 'GRID_RANGE_BREAK';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice }, at);
  }

  if (emergencyStop && state.positions.length) {
    closeAll(state, currentPrice, 'EMERGENCY_STOP', costArgs);
  }
  if (emergencyStop) {
    state.pausedReason = 'EMERGENCY_STOP';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice }, at);
  }

  const initialMark = currentEquity(state, currentPrice, cv, feeRate, slipRate);
  state.unrealizedPnl = initialMark.unrealized;
  state.currentEquity = initialMark.equity;
  state.highWaterEquity = Math.max(n(state.highWaterEquity), initialMark.equity);

  const dayCap = Math.max(0, n(state.dayStartEquity)) * cfg.dailyLossPct / 100;
  const ddPct = n(state.highWaterEquity) > 0
    ? Math.max(0, (n(state.highWaterEquity) - initialMark.equity) / n(state.highWaterEquity) * 100) : 0;
  state.drawdownPct = ddPct;
  if (!state.pausedReason && state.dayStartEquity > 0 && n(state.dayPnl) + initialMark.unrealized <= -dayCap) {
    closeAll(state, currentPrice, 'DAILY_LOSS_LIMIT', costArgs);
    state.pausedReason = 'DAILY_LOSS_LIMIT';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice }, at);
  }
  if (!state.pausedReason && ddPct >= cfg.maxDrawdownPct) {
    closeAll(state, currentPrice, 'OVERALL_DRAWDOWN_STOP', costArgs);
    state.pausedReason = 'OVERALL_DRAWDOWN_STOP';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice, drawdownPct: ddPct }, at);
  }

  const momentum = detectOneWayMomentum(candles, cfg.momentumPausePct, 0.75);
  state.momentum = momentum;

  // Existing positions continue to be managed even while new entries are paused.
  if (!state.pausedReason) {
    const remaining = [];
    for (const position of state.positions) {
      if (currentPrice >= n(position.targetPrice)) {
        const trade = closePosition(state, position, n(position.targetPrice), 'NEXT_GRID_LEVEL', costArgs);
        exited.push(trade);
      } else remaining.push(position);
    }
    state.positions = remaining;
  }

  const afterExits = currentEquity(state, currentPrice, cv, feeRate, slipRate);
  state.unrealizedPnl = afterExits.unrealized;
  state.currentEquity = afterExits.equity;
  state.highWaterEquity = Math.max(n(state.highWaterEquity), afterExits.equity);
  const dailyBreach = state.dayStartEquity > 0 && n(state.dayPnl) + afterExits.unrealized <= -n(state.dayStartEquity) * cfg.dailyLossPct / 100;
  const ddNow = n(state.highWaterEquity) > 0
    ? Math.max(0, (n(state.highWaterEquity) - afterExits.equity) / n(state.highWaterEquity) * 100) : 0;
  state.drawdownPct = ddNow;
  if (!state.pausedReason && dailyBreach) {
    closeAll(state, currentPrice, 'DAILY_LOSS_LIMIT', costArgs);
    state.pausedReason = 'DAILY_LOSS_LIMIT';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice }, at);
  }
  if (!state.pausedReason && ddNow >= cfg.maxDrawdownPct) {
    closeAll(state, currentPrice, 'OVERALL_DRAWDOWN_STOP', costArgs);
    state.pausedReason = 'OVERALL_DRAWDOWN_STOP';
    pushEvent(state, { type: 'HALT', reason: state.pausedReason, price: currentPrice, drawdownPct: ddNow }, at);
  }

  const firstEnabledTick = cfg.enabled && !wasEnabled;
  const canEnter = cfg.enabled && cfg.valid && !state.pausedReason && !momentum.paused &&
    dataFresh && previousPrice > 0 && !firstEnabledTick && !emergencyStop;
  if (cfg.enabled && !cfg.valid) {
    pushEvent(state, { type: 'BLOCK', reason: 'SET_VALID_GRID_RANGE' }, at);
  }
  if (cfg.enabled && !dataFresh && !state.pausedReason) {
    pushEvent(state, { type: 'BLOCK', reason: 'GRID_CANDLE_DATA_STALE' }, at);
  }
  if (cfg.enabled && momentum.paused && !state.pausedReason) {
    pushEvent(state, { type: 'PAUSE', reason: 'STRONG_ONE_WAY_MOMENTUM', direction: momentum.direction, movePct: momentum.movePct }, at);
  }

  if (canEnter) {
    const levels = cfg.levels;
    const occupied = new Set(state.positions.map(position => n(position.levelIndex)));
    const maxLev = Math.max(1, n(maxLeverage) || 3);
    const capitalForRisk = n(state.dayStartEquity) > 0 ? n(state.dayStartEquity) : capital;
    const desiredPct = Math.min(cfg.riskPerTradePct, cfg.dailyLossPct / cfg.maxPositions);
    let riskBudget = capitalForRisk * desiredPct / 100;
    if (cfg.reduceAfterLosses && n(state.consecutiveLosses) >= 2) riskBudget *= 0.5;
    const dailyRiskLimit = Math.max(0, capitalForRisk * cfg.dailyLossPct / 100);
    const entryLevels = levels.filter(level => level.entryEnabled).sort((a, b) => b.index - a.index);
    for (const level of entryLevels) {
      if (state.positions.length >= cfg.maxPositions) break;
      if (!(previousPrice > level.price && currentPrice <= level.price)) continue;
      if (occupied.has(level.index)) continue;
      const stopPrice = cfg.lowerPrice * (1 - cfg.breakoutExitPct / 100);
      const riskPerContract = Math.max(0, (level.price - stopPrice) * cv) +
        level.price * cv * 2 * (feeRate + slipRate);
      if (!(riskPerContract > 0)) continue;
      const remainingRisk = dailyRiskLimit - Math.max(0, -n(state.dayPnl)) - openRisk(state);
      const slotCount = Math.max(1, cfg.maxPositions - state.positions.length);
      const budget = Math.min(riskBudget, Math.max(0, remainingRisk) / slotCount);
      if (budget < riskPerContract) {
        pushEvent(state, { type: 'BLOCK', reason: 'RISK_BUDGET_BELOW_MINIMUM', levelIndex: level.index, price: level.price }, at);
        continue;
      }
      let qty = Math.floor(budget / riskPerContract);
      const notionalCapQty = Math.floor((capitalForRisk * maxLev) / Math.max(1e-12, level.price * cv));
      const availableMargin = n(available) > 0 ? n(available) : capitalForRisk;
      const marginCapQty = Math.floor((availableMargin * maxLev) / Math.max(1e-12, level.price * cv));
      qty = Math.max(0, Math.min(qty, notionalCapQty, marginCapQty));
      if (qty < 1) {
        pushEvent(state, { type: 'BLOCK', reason: 'MINIMUM_CONTRACT_SIZE', levelIndex: level.index, price: level.price }, at);
        continue;
      }
      const positionRisk = qty * riskPerContract;
      if (openRisk(state) + positionRisk > dailyRiskLimit + 1e-8) continue;
      const position = {
        id: 'GRID-' + cfg.symbol + '-' + level.index + '-' + timestamp,
        symbol: cfg.symbol,
        levelIndex: level.index,
        entryPrice: level.price,
        targetPrice: levels[level.index + 1].price,
        stopPrice,
        qty,
        riskUsd: positionRisk,
        openedAt: at
      };
      state.positions.push(position);
      occupied.add(level.index);
      entered.push(position);
      pushEvent(state, { type: 'ENTRY', symbol: cfg.symbol, levelIndex: level.index, price: level.price,
        targetPrice: position.targetPrice, qty, riskUsd: positionRisk, orderPreference: 'LIMIT' }, at);
    }
  }

  state.lastPrice = currentPrice;
  state.currentPrice = currentPrice;
  state.lastTickAt = at;
  state.openRiskUsd = openRisk(state);
  const finalMark = currentEquity(state, currentPrice, cv, feeRate, slipRate);
  state.unrealizedPnl = finalMark.unrealized;
  state.currentEquity = finalMark.equity;
  state.highWaterEquity = Math.max(n(state.highWaterEquity), finalMark.equity);
  state.drawdownPct = n(state.highWaterEquity) > 0
    ? Math.max(0, (n(state.highWaterEquity) - finalMark.equity) / n(state.highWaterEquity) * 100) : 0;
  state.wasEnabled = cfg.enabled;
  if (state.pausedReason) state.status = 'HALTED';
  else if (!cfg.valid) state.status = cfg.enabled ? 'NEEDS_RANGE' : 'OFF';
  else if (!cfg.enabled) state.status = 'OFF';
  else if (momentum.paused) state.status = 'MOMENTUM_PAUSE';
  else state.status = 'ACTIVE';
  return { state, events: state.events, entered, exited, config: cfg };
}
