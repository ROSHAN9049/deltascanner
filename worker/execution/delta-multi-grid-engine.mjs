import { manageDeltaTestnetGrid } from './delta-grid-engine.mjs';
import { isAllowedDeltaTestnetFutureSymbol } from './execution-route-policy.mjs';
import { classifyGridSymbolOwnership, gridSymbolMarketMetrics, selectGridSymbolsByPriority } from '../../shared/grid-symbol-pool.js';

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = value => String(value ?? '').trim();

function parseState(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueBy(rows, keyOf) {
  const seen = new Set();
  return rows.filter(row => {
    const key = keyOf(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const GLOBAL_GRID_PROTECTION_HALT_REASONS = new Set([
  'GRID_RANGE_BREAK',
  'GRID_BRACKET_UNVERIFIED_CANCELLED',
  'GRID_BRACKET_CANCEL_UNCONFIRMED',
  'GRID_TRAILING_SHIFT_LIMIT',
  'GRID_TRAILING_SHIFT_UNCONFIRMED'
]);

export function applyGlobalGridProtectionHalt(symbolStates, symbols, reason, at) {
  if (!GLOBAL_GRID_PROTECTION_HALT_REASONS.has(String(reason || ''))) return symbolStates;
  const next = { ...(symbolStates && typeof symbolStates === 'object' ? symbolStates : {}) };
  for (const symbolValue of Array.isArray(symbols) ? symbols : []) {
    const symbol = text(symbolValue).toUpperCase();
    if (!symbol) continue;
    const previous = next[symbol] || {};
    if (previous.status === 'HALTED' && previous.pausedReason === reason) continue;
    next[symbol] = {
      ...previous,
      status: 'HALTED',
      pausedReason: reason,
      lastTickAt: at,
      events: [...(Array.isArray(previous.events) ? previous.events : []), {
        type: 'HALT', symbol, reason, at
      }].slice(-80)
    };
  }
  return next;
}

const GLOBAL_ROOT_HALT_REASONS = new Set([
  'EMERGENCY_STOP', 'DAILY_LOSS_LIMIT', 'OVERALL_DRAWDOWN_STOP',
  'GRID_RANGE_BREAK', 'GRID_TRAILING_SHIFT_LIMIT'
]);

function aggregateGridState(symbolStates, symbols, previous = {}) {
  const states = symbols.map(symbol => symbolStates[symbol]).filter(Boolean);
  const positions = states.flatMap(state => Array.isArray(state.positions) ? state.positions : []);
  const pendingEntries = states.flatMap(state => Array.isArray(state.pendingEntries) ? state.pendingEntries : []);
  const trades = uniqueBy(states.flatMap(state => Array.isArray(state.trades) ? state.trades : []),
    row => String(row.id || row.executionId || row.closeOrderId || ''));
  const events = uniqueBy(states.flatMap(state => Array.isArray(state.events) ? state.events : []),
    row => [row.symbol || '', row.at || '', row.type || '', row.reason || '', row.levelIndex ?? ''].join('|'))
    .slice(-80);
  const latest = [...states].reverse().find(state => state.lastTickAt) || states.at(-1) || {};
  const trailingShiftTimestamps = [...new Set([
    ...(Array.isArray(previous.trailingShiftTimestamps) ? previous.trailingShiftTimestamps : []),
    ...states.flatMap(state => Array.isArray(state.trailingShiftTimestamps) ? state.trailingShiftTimestamps : [])
  ])].sort((a, b) => Date.parse(String(a)) - Date.parse(String(b)));
  const globalPause = states.map(state => String(state.pausedReason || ''))
    .find(reason => GLOBAL_ROOT_HALT_REASONS.has(reason)) || null;
  const statuses = states.map(state => String(state.status || 'OFF').toUpperCase());
  const hasActive = statuses.some(status => ['ACTIVE', 'ENTRY_PENDING'].includes(status));
  const hasWaiting = statuses.some(status => ['WAITING', 'SKIPPED', 'PENDING'].includes(status));
  const hasHalted = statuses.some(status => status === 'HALTED');
  const status = globalPause ? 'HALTED'
    : hasActive ? 'ACTIVE'
      : hasWaiting ? 'WAITING'
        : hasHalted ? 'HALTED'
          : statuses.length && statuses.every(value => value === 'OFF') ? 'OFF' : 'PAUSED';
  const symbolSummaries = Object.fromEntries(symbols.map(symbol => {
    const state = symbolStates[symbol] || {};
    const blocker = state.futuresBlocker && typeof state.futuresBlocker === 'object'
      ? state.futuresBlocker : {};
    return [symbol, {
      status: state.status || 'PENDING',
      pausedReason: state.pausedReason || null,
      skipReason: state.skipReason || null,
      blockingPositionId: blocker.id ?? null,
      blockingOrderId: blocker.orderId ?? null,
      blockingStrategy: blocker.strategy || null,
      currentPrice: n(state.currentPrice),
      lastTickAt: state.lastTickAt || null,
      positionCount: Array.isArray(state.positions) ? state.positions.length : 0,
      pendingCount: Array.isArray(state.pendingEntries) ? state.pendingEntries.length : 0,
      atrReady: state.atrReady === true,
      turnover24hUsd: n(state.turnover24hUsd),
      spreadPct: Number.isFinite(Number(state.spreadPct)) ? Number(state.spreadPct) : null,
      momentum: state.momentum || null
    }];
  }));
  return {
    ...previous,
    version: 4,
    executionMode: 'DELTA_TESTNET',
    symbols: [...symbols],
    poolSymbols: [...symbols],
    symbolStates,
    symbolSummaries,
    status,
    positions,
    pendingEntries,
    trades,
    events,
    trailingShiftTimestamps,
    lastTrailingShiftAt: latest.lastTrailingShiftAt || previous.lastTrailingShiftAt || null,
    lastTrailingShiftSymbol: latest.lastTrailingShiftSymbol || previous.lastTrailingShiftSymbol || null,
    lastTrailingShiftDirection: latest.lastTrailingShiftDirection || previous.lastTrailingShiftDirection || null,
    lastTrailingShiftPrice: latest.lastTrailingShiftPrice ?? previous.lastTrailingShiftPrice ?? null,
    realizedPnl: latest.realizedPnl ?? null,
    dayPnl: latest.dayPnl ?? null,
    strategyStartEquity: n(latest.strategyStartEquity),
    dayStartEquity: n(latest.dayStartEquity),
    highWaterEquity: n(latest.highWaterEquity),
    currentEquity: latest.currentEquity ?? null,
    unrealizedPnl: latest.unrealizedPnl ?? null,
    drawdownPct: latest.drawdownPct ?? null,
    openRiskUsd: [...positions, ...pendingEntries].reduce((sum, position) => sum + Math.max(0, n(position.riskUsd)), 0),
    pausedReason: globalPause,
    lastPrice: n(latest.lastPrice),
    currentPrice: n(latest.currentPrice),
    lastTickAt: latest.lastTickAt || null,
    wasEnabled: states.some(state => state.wasEnabled === true),
    momentum: latest.momentum || { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 }
  };
}

/**
 * Run one isolated Grid state machine per allowlisted symbol while sharing
 * the same exchange account, daily-loss budget, position cap, and drawdown.
 * Each symbol writes into grid_state.symbolStates; the root state is an
 * aggregate view for the dashboard and legacy readers.
 */
export async function manageDeltaTestnetMultiGrid({
  settings = {},
  account = {},
  symbols = [],
  maxConcurrentSymbols = settings.gridMaxConcurrentSymbols ?? 2,
  tickers = {},
  products = {},
  candlesBySymbol = {},
  freshnessBySymbol = {},
  database,
  executor,
  now = () => Date.now()
} = {}) {
  const poolSymbols = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map(value => text(value).toUpperCase()))];
  const previousRoot = parseState(settings.grid_state);
  const symbolStates = previousRoot.symbolStates && typeof previousRoot.symbolStates === 'object'
    ? { ...previousRoot.symbolStates } : {};
  const timestamp = now();
  const at = new Date(timestamp).toISOString();
  const limit = Math.max(1, Math.min(poolSymbols.length || 1,
    Number.isInteger(Number(maxConcurrentSymbols)) ? Number(maxConcurrentSymbols) : 2));
  const symbolStatuses = {};
  const persistRoot = async () => {
    const root = aggregateGridState(symbolStates, poolSymbols, previousRoot);
    await database.update('dd_settings', 'id=eq.1', { grid_state: root, updated_at: at });
    return root;
  };
  if (poolSymbols.length < 1 || poolSymbols.length > 6 ||
      poolSymbols.some(symbol => !/^[A-Z0-9]+USD$/.test(symbol) || !isAllowedDeltaTestnetFutureSymbol(symbol))) {
    return {
      state: previousRoot,
      activeSymbols: [],
      skippedSymbols: [],
      symbolStatuses,
      waitingForFutures: false,
      safety: { executionMode: 'testnet', configured: false, trusted: false, blocked: true, reason: 'GRID_SYMBOL_CONFIGURATION_INVALID' }
    };
  }
  if (!database || typeof database.update !== 'function' ||
      typeof database.select !== 'function' || !executor ||
      typeof executor.getOpenPositions !== 'function') {
    return {
      state: previousRoot,
      activeSymbols: [],
      skippedSymbols: [],
      symbolStatuses,
      waitingForFutures: false,
      safety: { executionMode: 'testnet', configured: false, trusted: false, blocked: true, reason: 'GRID_DEPENDENCIES_UNAVAILABLE' }
    };
  }

  let exchangePositions;
  let databasePositions;
  let databaseOrders;
  try {
    const filter = poolSymbols.join(',');
    [exchangePositions, databasePositions, databaseOrders] = await Promise.all([
      executor.getOpenPositions(),
      database.select('dd_delta_positions',
        'symbol=in.(' + filter + ')&status=eq.OPEN&select=id,symbol,strategy,qty,side,entry_price,entry_order_id,order_id,client_order_id,opened_at&limit=500'),
      database.select('dd_orders',
        'symbol=in.(' + filter + ')&select=*&order=created_at.desc&limit=1000')
    ]);
    if (!Array.isArray(exchangePositions) || !Array.isArray(databasePositions) || !Array.isArray(databaseOrders)) {
      throw new Error('Dynamic Grid ownership snapshot returned malformed data');
    }
  } catch (error) {
    for (const symbol of poolSymbols) {
      const previous = symbolStates[symbol] || {};
      symbolStates[symbol] = {
        ...previous, status: 'PENDING', skipReason: 'OWNERSHIP_RECONCILIATION_UNAVAILABLE',
        lastTickAt: at
      };
      symbolStatuses[symbol] = { status: 'PENDING', reason: 'OWNERSHIP_RECONCILIATION_UNAVAILABLE' };
    }
    const root = await persistRoot().catch(() => aggregateGridState(symbolStates, poolSymbols, previousRoot));
    await database.log?.('ERROR', '[GRID] Symbol ownership snapshot unavailable; waiting without submitting entries', {
      error: String(error?.message || error).slice(0, 220),
      poolSymbols, executionBlocked: true
    }).catch(() => {});
    return {
      state: root,
      activeSymbols: [],
      skippedSymbols: [],
      symbolStatuses,
      waitingForFutures: false,
      safety: { executionMode: 'testnet', configured: account.privateApiAvailable === true,
        trusted: account.privateApiAvailable === true, blocked: true, reason: 'GRID_SYMBOL_OWNERSHIP_UNAVAILABLE' }
    };
  }

  const terminalStates = new Set([
    'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'REJECTED', 'FAILED',
    'EXPIRED', 'EXITED', 'COMPLETE', 'COMPLETED'
  ]);
  const gridOrders = databaseOrders.filter(row => text(row?.strategy).toUpperCase() === 'GRID');
  const activeGridOrders = gridOrders.filter(row => !terminalStates.has(text(row?.state).toUpperCase()));
  const ownerBySymbol = new Map();
  const gridExposureBySymbol = new Map();
  const metricsBySymbol = new Map();
  const manuallyPaused = new Set();
  const futuresBlocked = new Set();
  const unknownBlocked = new Set();
  const mustManage = new Set();

  const hasGridPositionState = symbol => {
    const state = symbolStates[symbol] || {};
    return (Array.isArray(state.positions) && state.positions.some(row =>
      text(row?.symbol || symbol).toUpperCase() === symbol && Math.abs(n(row?.qty)) > 0
    )) || (Array.isArray(previousRoot.positions) && previousRoot.positions.some(row =>
      text(row?.symbol).toUpperCase() === symbol && Math.abs(n(row?.qty)) > 0
    ));
  };
  const hasLocalPending = symbol => {
    const state = symbolStates[symbol] || {};
    return (Array.isArray(state.pendingEntries) && state.pendingEntries.some(row =>
      text(row?.symbol || symbol).toUpperCase() === symbol
    )) || (Array.isArray(previousRoot.pendingEntries) && previousRoot.pendingEntries.some(row =>
      text(row?.symbol).toUpperCase() === symbol
    ));
  };
  const hasDatabaseGridPosition = symbol => databasePositions.some(row =>
    text(row?.symbol).toUpperCase() === symbol && text(row?.strategy).toUpperCase() === 'GRID' &&
    Math.abs(n(row?.qty)) > 0
  );
  const hasGridReservation = symbol => activeGridOrders.some(row =>
    text(row?.symbol).toUpperCase() === symbol && text(row?.role).toUpperCase() === 'ENTRY'
  );
  const gridOpenPositionRows = databasePositions.filter(row =>
    text(row?.strategy).toUpperCase() === 'GRID' && Math.abs(n(row?.qty)) > 0
  );

  const shiftFailureRowsCache = new Map();
  const findCrossSymbolShiftConflict = async symbol => {
    if (shiftFailureRowsCache.has(symbol)) return shiftFailureRowsCache.get(symbol);
    const eventMatch = (symbolStates[symbol]?.events || []).find(event =>
      event?.reason === 'GRID_TRAILING_SHIFT_UNCONFIRMED' &&
      /Non-Grid database exposure exists on ([A-Z0-9]+USD)/.test(String(event?.error || ''))
    );
    if (eventMatch) {
      const match = String(eventMatch.error).match(/Non-Grid database exposure exists on ([A-Z0-9]+USD)/);
      shiftFailureRowsCache.set(symbol, match?.[1] || null);
      return match?.[1] || null;
    }
    try {
      const failureMessage = encodeURIComponent('Grid trailing shift failed closed; manual review/reset is required');
      const rows = await database.select('dd_engine_logs',
        'message=eq.' + failureMessage + '&select=data,created_at&order=created_at.desc&limit=100');
      if (!Array.isArray(rows)) return null;
      const row = rows.find(item => text(item?.data?.symbol).toUpperCase() === symbol);
      const match = String(row?.data?.error || '').match(/Non-Grid database exposure exists on ([A-Z0-9]+USD)/);
      const blockingSymbol = match?.[1] || null;
      shiftFailureRowsCache.set(symbol, blockingSymbol);
      return blockingSymbol;
    } catch {
      shiftFailureRowsCache.set(symbol, null);
      return null;
    }
  };

  // Resolve every owner before making any handoff decision so logging and
  // recovery are independent of pool order.
  for (const symbol of poolSymbols) {
    const ownership = classifyGridSymbolOwnership({ symbol, exchangePositions, databasePositions });
    const exchangePosition = exchangePositions.find(row =>
      text(row?.symbol || row?.product_symbol).toUpperCase() === symbol &&
      Math.abs(n(row?.qty ?? row?.size)) > 0
    ) || null;
    if (ownership.owner === 'FUTURES' && exchangePosition) {
      const clientId = text(exchangePosition.client_order_id);
      const matchingGridOrder = clientId && clientId.toUpperCase().startsWith('DDG-')
        ? gridOrders.find(row => text(row?.client_order_id) === clientId) : null;
      if (matchingGridOrder && !databasePositions.some(row =>
        text(row?.symbol).toUpperCase() === symbol &&
        text(row?.strategy).toUpperCase() !== 'GRID' && Math.abs(n(row?.qty)) > 0
      )) {
        ownership.owner = 'GRID';
        ownership.blocked = false;
        ownership.position = ownership.position || {};
      }
    }
    ownerBySymbol.set(symbol, ownership);
  }

  const futuresSkipLogRows = [];
  for (const symbol of poolSymbols) {
    const config = settings.grid_symbol_configs?.[symbol] || {};
    const previous = symbolStates[symbol] || {};
    const paused = config.paused === true;
    if (paused) manuallyPaused.add(symbol);
    const ownership = ownerBySymbol.get(symbol);
    const hasGridDb = hasDatabaseGridPosition(symbol);
    const hasGridExposure = ownership.owner === 'GRID' || hasGridDb;
    const hasPending = hasGridReservation(symbol) || hasLocalPending(symbol);
    gridExposureBySymbol.set(symbol, { hasGridExposure, hasPending, ownership });

    const metrics = gridSymbolMarketMetrics(symbol, {
      ticker: tickers[symbol] || {},
      config
    });
    const lower = Number(config.lowerPrice ?? config.grid_lower_price ?? 0);
    const upper = Number(config.upperPrice ?? config.grid_upper_price ?? 0);
    const rangeReady = lower > 0 && upper > lower;
    const atrStatus = config.atr_snapshot_status ?? config.atrSnapshotStatus;
    const productReady = Boolean(products[symbol]) && freshnessBySymbol[symbol] !== false;
    const dataReady = freshnessBySymbol[symbol] === true && productReady && rangeReady;
    const ready = dataReady && ['READY', 'FALLBACK_3PCT'].includes(String(atrStatus || ''));
    metricsBySymbol.set(symbol, { ...metrics, rangeReady, dataReady, ready, atrStatus });

    const currentState = symbolStates[symbol] || previous;
    if (ownership.blocked) {
      if (ownership.owner === 'FUTURES') futuresBlocked.add(symbol);
      else unknownBlocked.add(symbol);
      const blocker = ownership.position || {};
      const wasSkippedForSameFutures = currentState.status === 'SKIPPED' &&
        currentState.skipReason === 'FUTURES_POSITION_OPEN' &&
        Number(currentState.futuresBlocker?.id ?? -1) === Number(blocker.id ?? -2);
      symbolStates[symbol] = {
        ...currentState,
        status: 'SKIPPED',
        pausedReason: null,
        skipReason: ownership.owner === 'FUTURES' ? 'FUTURES_POSITION_OPEN' : 'OWNERSHIP_UNVERIFIED',
        futuresBlocker: ownership.owner === 'FUTURES' ? blocker : null,
        lastTickAt: at
      };
      symbolStatuses[symbol] = {
        status: 'SKIPPED',
        reason: ownership.owner === 'FUTURES' ? 'FUTURES_POSITION_OPEN' : 'OWNERSHIP_UNVERIFIED',
        blockingPosition: ownership.owner === 'FUTURES' ? blocker : null,
        atrReady: metrics.atrReady,
        turnover24hUsd: metrics.turnover24hUsd,
        spreadPct: metrics.spreadPct
      };
      if (!wasSkippedForSameFutures && ownership.owner === 'FUTURES') {
        futuresSkipLogRows.push({ symbol, blocker });
      }
      continue;
    }

    if (currentState.status === 'SKIPPED' && currentState.skipReason === 'FUTURES_POSITION_OPEN') {
      await database.log('INFO',
        '[GRID] Symbol ' + symbol + ' re-eligible: Futures position closed. Resuming Grid on this symbol.',
        { symbol, previousBlockingPositionId: currentState.futuresBlocker?.id ?? null }
      ).catch(() => {});
      symbolStates[symbol] = {
        ...currentState, status: 'PENDING', pausedReason: null,
        skipReason: null, futuresBlocker: null, lastTickAt: at
      };
    }

    if (paused) {
      const needsManagement = hasGridExposure || hasPending;
      symbolStates[symbol] = {
        ...(symbolStates[symbol] || currentState),
        status: 'PAUSED', pausedReason: null, skipReason: 'MANUAL_PAUSE',
        futuresBlocker: null, lastTickAt: at
      };
      symbolStatuses[symbol] = {
        status: 'PAUSED', reason: 'MANUAL_PAUSE', atrReady: metrics.atrReady,
        turnover24hUsd: metrics.turnover24hUsd, spreadPct: metrics.spreadPct
      };
      if (needsManagement) mustManage.add(symbol);
      continue;
    }

    if (hasGridExposure || hasPending) {
      mustManage.add(symbol);
      symbolStates[symbol] = {
        ...(symbolStates[symbol] || currentState),
        skipReason: null, futuresBlocker: null,
        atrReady: metrics.atrReady, turnover24hUsd: metrics.turnover24hUsd,
        spreadPct: metrics.spreadPct, lastTickAt: at
      };
      continue;
    }

    if (currentState.pausedReason) {
      symbolStates[symbol] = { ...currentState, status: 'HALTED', lastTickAt: at };
      symbolStatuses[symbol] = {
        status: 'HALTED', reason: currentState.pausedReason, atrReady: metrics.atrReady,
        turnover24hUsd: metrics.turnover24hUsd, spreadPct: metrics.spreadPct
      };
      continue;
    }

    if (!metrics.ready) {
      symbolStates[symbol] = {
        ...(symbolStates[symbol] || currentState),
        status: 'PENDING', pausedReason: null, skipReason: metrics.rangeReady
          ? (metrics.atrStatus ? 'MARKET_OR_PRODUCT_PENDING' : 'ATR_PENDING')
          : 'RANGE_PENDING',
        atrReady: metrics.atrReady, turnover24hUsd: metrics.turnover24hUsd,
        spreadPct: metrics.spreadPct, lastTickAt: at
      };
      symbolStatuses[symbol] = {
        status: 'PENDING', reason: symbolStates[symbol].skipReason,
        atrReady: metrics.atrReady, turnover24hUsd: metrics.turnover24hUsd,
        spreadPct: metrics.spreadPct
      };
      continue;
    }

    symbolStates[symbol] = {
      ...(symbolStates[symbol] || currentState),
      status: 'PENDING', pausedReason: null, skipReason: 'AWAITING_CONCURRENCY_SLOT',
      atrReady: metrics.atrReady, turnover24hUsd: metrics.turnover24hUsd,
      spreadPct: metrics.spreadPct, lastTickAt: at
    };
  }

  // Known historical incident recovery is evidence-based: the old helper
  // failed in its read-only ownership preflight before cancelling or closing
  // anything. Reset only that symbol when its own exposure/order state is flat
  // and the exact cross-symbol blocker still has a live Futures owner.
  for (const symbol of poolSymbols) {
    const previous = symbolStates[symbol] || {};
    const exposure = gridExposureBySymbol.get(symbol) || {};
    if (previous.pausedReason !== 'GRID_TRAILING_SHIFT_UNCONFIRMED' ||
        exposure.hasGridExposure || exposure.hasPending) continue;
    const conflictSymbol = await findCrossSymbolShiftConflict(symbol);
    const conflictOwner = conflictSymbol ? ownerBySymbol.get(conflictSymbol) : null;
    if (conflictSymbol && conflictOwner?.owner === 'FUTURES' && conflictOwner.blocked) {
      symbolStates[symbol] = {
        ...previous, status: 'PENDING', pausedReason: null,
        skipReason: null, futuresBlocker: null,
        positions: [], pendingEntries: [], openRiskUsd: 0, unrealizedPnl: 0,
        lastTickAt: at
      };
      await database.log('INFO',
        '[GRID] Recovered prior trailing-shift preflight conflict; unrelated Futures symbol is now isolated from this Grid symbol',
        { symbol, excludedFuturesSymbol: conflictSymbol, reason: 'NON_GRID_POSITION_ON_OTHER_POOL_SYMBOL' }
      ).catch(() => {});
    }
  }

  const candidates = poolSymbols.filter(symbol => {
    if (futuresBlocked.has(symbol) || unknownBlocked.has(symbol) ||
        manuallyPaused.has(symbol) || mustManage.has(symbol)) return false;
    return metricsBySymbol.get(symbol)?.ready === true &&
      !symbolStates[symbol]?.pausedReason;
  }).map(symbol => metricsBySymbol.get(symbol));
  const remainingSlots = Math.max(0, limit - mustManage.size);
  const selected = selectGridSymbolsByPriority(candidates, remainingSlots);
  const activeSymbols = [...new Set([...mustManage, ...selected])];
  const skippedSymbols = [...futuresBlocked, ...unknownBlocked];
  for (const { symbol, blocker } of futuresSkipLogRows) {
    const continuingWith = activeSymbols.find(candidate => candidate !== symbol) || null;
    const nextLabel = continuingWith || 'remaining eligible pool symbols';
    await database.log('INFO',
      '[GRID] Symbol ' + symbol + ' skipped: Futures position detected (id=' +
        (blocker.id ?? 'unknown') + '). Continuing with ' + nextLabel + '.',
      {
        symbol, blockingPositionId: blocker.id ?? null,
        blockingOrderId: blocker.orderId ?? null,
        blockingStrategy: blocker.strategy || 'FUTURES',
        poolSymbols, continuingWith
      }
    ).catch(() => {});
  }
  for (const symbol of selected) {
    const current = symbolStates[symbol] || {};
    symbolStates[symbol] = {
      ...current, status: 'PENDING', skipReason: null,
      atrReady: metricsBySymbol.get(symbol)?.atrReady === true,
      turnover24hUsd: metricsBySymbol.get(symbol)?.turnover24hUsd ?? 0,
      spreadPct: metricsBySymbol.get(symbol)?.spreadPct ?? null,
      lastTickAt: at
    };
    symbolStatuses[symbol] = {
      status: 'ACTIVE', reason: null, atrReady: metricsBySymbol.get(symbol)?.atrReady === true,
      turnover24hUsd: metricsBySymbol.get(symbol)?.turnover24hUsd ?? 0,
      spreadPct: metricsBySymbol.get(symbol)?.spreadPct ?? null
    };
  }

  const allFuturesBlocked = futuresBlocked.size === poolSymbols.length;
  if (!activeSymbols.length) {
    for (const symbol of poolSymbols) {
      if (!symbolStatuses[symbol]) {
        const state = symbolStates[symbol] || {};
        symbolStatuses[symbol] = {
          status: state.status || 'PENDING',
          reason: state.skipReason || state.pausedReason || null,
          atrReady: state.atrReady === true
        };
      }
    }
    const root = await persistRoot();
    if (allFuturesBlocked) {
      await database.log('INFO', '[GRID] All pool symbols blocked by Futures; waiting', {
        poolSymbols, maxConcurrentSymbols: limit, waiting: true
      }).catch(() => {});
    }
    return {
      state: root,
      activeSymbols: [],
      skippedSymbols,
      symbolStatuses,
      waitingForFutures: allFuturesBlocked,
      safety: {
        executionMode: 'testnet',
        configured: account.privateApiAvailable === true,
        trusted: account.privateApiAvailable === true,
        blocked: false,
        reason: null,
        symbols: []
      }
    };
  }

  const globalPauseReasons = new Set([
    'EMERGENCY_STOP', 'DAILY_LOSS_LIMIT', 'OVERALL_DRAWDOWN_STOP', 'GRID_RANGE_BREAK',
    'GRID_ENTRY_UNCONFIRMED', 'GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW',
    'GRID_ORDER_RECONCILIATION_UNAVAILABLE', 'GRID_ORDER_CANCEL_UNCONFIRMED',
    'GRID_BRACKET_UNVERIFIED_CANCELLED', 'GRID_BRACKET_CANCEL_UNCONFIRMED',
    'GRID_PROTECTION_UNVERIFIED', 'GRID_PROTECTION_UNVERIFIED_EXIT_FAILED',
    'GRID_EXIT_UNCONFIRMED', 'GRID_PNL_UNVERIFIED',
    'GRID_COMBINED_UNREALIZED_PNL_UNAVAILABLE',
    'GRID_MULTI_SYMBOL_RECONCILIATION_FAILED',
    'GRID_FILLED_ORDER_WITHOUT_POSITION', 'GRID_SYMBOL_CYCLE_ERROR',
    'GRID_TRAILING_SHIFT_LIMIT'
  ]);
  const globalHardStopReasons = new Set([
    'EMERGENCY_STOP', 'DAILY_LOSS_LIMIT', 'OVERALL_DRAWDOWN_STOP', 'GRID_RANGE_BREAK',
    'GRID_TRAILING_SHIFT_LIMIT'
  ]);
  const rootBeforeCycles = aggregateGridState(symbolStates, poolSymbols, previousRoot);
  const results = [];
  for (const symbol of activeSymbols) {
    const config = settings.grid_symbol_configs?.[symbol] || {};
    const lowerPrice = Number(config.lowerPrice ?? config.grid_lower_price ?? 0);
    const upperPrice = Number(config.upperPrice ?? config.grid_upper_price ?? 0);
    const levelsCount = Number(config.levelsCount ?? config.grid_levels_count ?? settings.grid_levels_count ?? 10);
    const symbolState = symbolStates[symbol] || null;
    const root = aggregateGridState(symbolStates, poolSymbols, rootBeforeCycles);
    const gridGlobalOpenRiskUsd = root.openRiskUsd || 0;
    const priorGlobalPause = poolSymbols
      .map(configured => symbolStates[configured]?.pausedReason)
      .find(reason => globalPauseReasons.has(String(reason || ''))) || null;
    const gridGlobalHardStopReason = poolSymbols
      .map(configured => symbolStates[configured]?.pausedReason)
      .find(reason => globalHardStopReasons.has(String(reason || ''))) || null;
    const symbolSettings = {
      ...settings,
      grid_symbol: symbol,
      grid_symbols: poolSymbols,
      gridSymbols: poolSymbols,
      grid_state: symbolState,
      grid_lower_price: lowerPrice,
      grid_upper_price: upperPrice,
      grid_levels_count: levelsCount,
      grid_atr: Number(config.atr) || 0,
      grid_enabled: settings.grid_enabled === true && config.paused !== true,
      grid_max_positions: 1,
      max_grid_positions: limit,
      maxGridPositions: limit,
      gridMaxConcurrentSymbols: limit,
      gridGlobalOpenRiskUsd,
      gridGlobalPauseReason: priorGlobalPause,
      gridGlobalHardStopReason,
      gridGlobalTrailingShiftTimestamps: root.trailingShiftTimestamps || []
    };

    const scopedDatabase = Object.create(database);
    scopedDatabase.update = async (table, query, patch) => {
      if (table === 'dd_settings' && patch && patch.grid_symbol_configs) {
        settings.grid_symbol_configs = patch.grid_symbol_configs;
      }
      if (table === 'dd_settings' && patch && patch.grid_state) {
        symbolStates[symbol] = patch.grid_state;
        const nextRoot = aggregateGridState(symbolStates, poolSymbols, rootBeforeCycles);
        return database.update(table, query, { ...patch, grid_state: nextRoot });
      }
      return database.update(table, query, patch);
    };

    try {
      const result = await manageDeltaTestnetGrid({
        settings: symbolSettings,
        account,
        ticker: tickers[symbol] || {},
        product: products[symbol] || {},
        candles: Array.isArray(candlesBySymbol[symbol]) ? candlesBySymbol[symbol] : [],
        dataFresh: freshnessBySymbol[symbol] === true,
        database: scopedDatabase,
        executor,
        now
      });
      symbolStates[symbol] = {
        ...result.state,
        atrReady: metricsBySymbol.get(symbol)?.atrReady === true,
        turnover24hUsd: metricsBySymbol.get(symbol)?.turnover24hUsd ?? 0,
        spreadPct: metricsBySymbol.get(symbol)?.spreadPct ?? null
      };
      if (result.safety?.reason === 'SAME_SYMBOL_POSITION_NOT_OWNED_BY_GRID') {
        const currentOwner = classifyGridSymbolOwnership({
          symbol, exchangePositions: await executor.getOpenPositions(),
          databasePositions: await database.select('dd_delta_positions',
            'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&select=id,symbol,strategy,qty,side,entry_price,entry_order_id,order_id,client_order_id&limit=20')
        });
        const blocker = currentOwner.position || {};
        symbolStates[symbol] = {
          ...symbolStates[symbol], status: 'SKIPPED', pausedReason: null,
          skipReason: 'FUTURES_POSITION_OPEN',
          futuresBlocker: blocker, lastTickAt: at
        };
        symbolStatuses[symbol] = {
          status: 'SKIPPED', reason: 'FUTURES_POSITION_OPEN',
          blockingPosition: blocker
        };
        await database.log('INFO',
          '[GRID] Symbol ' + symbol + ' skipped: Futures position detected (id=' +
            (blocker.id ?? 'unknown') + '). Continuing with ' +
            (activeSymbols.find(candidate => candidate !== symbol) || 'other active pool symbols') + '.',
          { symbol, blockingPositionId: blocker.id ?? null, blockingOrderId: blocker.orderId ?? null }
        ).catch(() => {});
        results.push({ symbol, blocked: false, skipped: true, reason: 'FUTURES_POSITION_OPEN' });
        await persistRoot();
        continue;
      }
      symbolStatuses[symbol] = {
        status: result.state?.status === 'HALTED' ? 'HALTED'
          : result.state?.status === 'ACTIVE' || result.state?.status === 'ENTRY_PENDING' ? 'ACTIVE'
            : 'PENDING',
        reason: result.safety?.reason || result.state?.pausedReason || null,
        atrReady: metricsBySymbol.get(symbol)?.atrReady === true,
        turnover24hUsd: metricsBySymbol.get(symbol)?.turnover24hUsd ?? 0,
        spreadPct: metricsBySymbol.get(symbol)?.spreadPct ?? null
      };
      results.push({ symbol, ...result.safety });
      await persistRoot();
    } catch (error) {
      const existing = symbolStates[symbol] || {};
      symbolStates[symbol] = {
        ...existing,
        status: 'HALTED',
        pausedReason: 'GRID_SYMBOL_CYCLE_ERROR',
        lastTickAt: at,
        events: [...(Array.isArray(existing.events) ? existing.events : []), {
          type: 'HALT', symbol, reason: 'GRID_SYMBOL_CYCLE_ERROR', at
        }].slice(-80)
      };
      symbolStatuses[symbol] = { status: 'HALTED', reason: 'GRID_SYMBOL_CYCLE_ERROR' };
      results.push({
        symbol, executionMode: 'testnet', configured: true, trusted: false,
        blocked: true, reason: 'GRID_SYMBOL_CYCLE_ERROR',
        error: String(error?.message || error).slice(0, 220)
      });
      await persistRoot();
    }
  }

  const globalProtectionFailure = results.find(result =>
    result.blocked === true && GLOBAL_GRID_PROTECTION_HALT_REASONS.has(String(result.reason || ''))
  )?.reason;
  if (globalProtectionFailure) {
    Object.assign(symbolStates, applyGlobalGridProtectionHalt(
      symbolStates, poolSymbols, globalProtectionFailure, at
    ));
  }
  const root = aggregateGridState(symbolStates, poolSymbols, previousRoot);
  await database.update('dd_settings', 'id=eq.1', { grid_state: root, updated_at: at });
  const blocked = results.some(result => result.blocked === true);
  return {
    state: root,
    activeSymbols,
    skippedSymbols,
    symbolStatuses,
    waitingForFutures: false,
    safety: {
      executionMode: 'testnet',
      configured: account.privateApiAvailable === true,
      trusted: account.privateApiAvailable === true,
      blocked,
      reason: results.find(result => result.blocked)?.reason || null,
      symbols: results
    }
  };
}
