import { manageDeltaTestnetGrid } from './delta-grid-engine.mjs';

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
  const statuses = states.map(state => String(state.status || 'OFF').toUpperCase());
  const status = statuses.includes('HALTED') ? 'HALTED'
    : statuses.includes('BLOCKED') ? 'BLOCKED'
      : statuses.includes('ENTRY_PENDING') ? 'ENTRY_PENDING'
        : statuses.includes('ACTIVE') ? 'ACTIVE'
          : statuses.includes('MOMENTUM_PAUSE') ? 'MOMENTUM_PAUSE'
            : statuses.every(value => value === 'OFF') ? 'OFF' : 'PAUSED';
  const paused = states.find(state => state.pausedReason);
  const symbolSummaries = Object.fromEntries(symbols.map(symbol => {
    const state = symbolStates[symbol] || {};
    return [symbol, {
      status: state.status || 'OFF',
      pausedReason: state.pausedReason || null,
      currentPrice: n(state.currentPrice),
      lastTickAt: state.lastTickAt || null,
      positionCount: Array.isArray(state.positions) ? state.positions.length : 0,
      pendingCount: Array.isArray(state.pendingEntries) ? state.pendingEntries.length : 0,
      momentum: state.momentum || null
    }];
  }));
  return {
    ...previous,
    version: 3,
    executionMode: 'DELTA_TESTNET',
    symbols: [...symbols],
    symbolStates,
    symbolSummaries,
    status,
    positions,
    pendingEntries,
    trades,
    events,
    realizedPnl: latest.realizedPnl ?? null,
    dayPnl: latest.dayPnl ?? null,
    strategyStartEquity: n(latest.strategyStartEquity),
    dayStartEquity: n(latest.dayStartEquity),
    highWaterEquity: n(latest.highWaterEquity),
    currentEquity: latest.currentEquity ?? null,
    unrealizedPnl: latest.unrealizedPnl ?? null,
    drawdownPct: latest.drawdownPct ?? null,
    openRiskUsd: positions.reduce((sum, position) => sum + Math.max(0, n(position.riskUsd)), 0),
    pausedReason: paused?.pausedReason || null,
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
  tickers = {},
  products = {},
  candlesBySymbol = {},
  freshnessBySymbol = {},
  database,
  executor,
  now = () => Date.now()
} = {}) {
  const configuredSymbols = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map(value => text(value).toUpperCase()))];
  if (configuredSymbols.length !== 2 || configuredSymbols.some(symbol => !/^[A-Z0-9]+USD$/.test(symbol))) {
    return {
      state: parseState(settings.grid_state),
      safety: { executionMode: 'testnet', configured: false, trusted: false, blocked: true, reason: 'GRID_SYMBOL_CONFIGURATION_INVALID' }
    };
  }
  if (!database || typeof database.update !== 'function' || !executor) {
    return {
      state: parseState(settings.grid_state),
      safety: { executionMode: 'testnet', configured: false, trusted: false, blocked: true, reason: 'GRID_DEPENDENCIES_UNAVAILABLE' }
    };
  }

  const timestamp = now();
  const at = new Date(timestamp).toISOString();
  const previousRoot = parseState(settings.grid_state);
  const symbolStates = previousRoot.symbolStates && typeof previousRoot.symbolStates === 'object'
    ? { ...previousRoot.symbolStates } : {};
  let root = aggregateGridState(symbolStates, configuredSymbols, previousRoot);
  const results = [];
  const haltAllReasons = new Set([
    'EMERGENCY_STOP', 'DAILY_LOSS_LIMIT', 'OVERALL_DRAWDOWN_STOP',
    'GRID_ENTRY_UNCONFIRMED', 'GRID_ORDER_ERROR_REQUIRES_MANUAL_REVIEW',
    'GRID_PROTECTION_UNVERIFIED', 'GRID_PROTECTION_UNVERIFIED_EXIT_FAILED',
    'GRID_EXIT_UNCONFIRMED', 'GRID_PNL_UNVERIFIED',
    'GRID_COMBINED_UNREALIZED_PNL_UNAVAILABLE',
    'GRID_MULTI_SYMBOL_RECONCILIATION_FAILED'
  ]);

  const persistRoot = async () => {
    root = aggregateGridState(symbolStates, configuredSymbols, root);
    await database.update('dd_settings', 'id=eq.1', { grid_state: root, updated_at: at });
  };

  for (const symbol of configuredSymbols) {
    const config = settings.grid_symbol_configs?.[symbol] || {};
    const lowerPrice = Number(config.lowerPrice ?? config.grid_lower_price ?? 0);
    const upperPrice = Number(config.upperPrice ?? config.grid_upper_price ?? 0);
    const levelsCount = Number(config.levelsCount ?? config.grid_levels_count ?? settings.grid_levels_count ?? 10);
    const symbolState = symbolStates[symbol] || null;
    const gridGlobalOpenRiskUsd = root.openRiskUsd || 0;
    const symbolSettings = {
      ...settings,
      grid_symbol: symbol,
      grid_symbols: configuredSymbols,
      gridSymbols: configuredSymbols,
      grid_state: symbolState,
      grid_lower_price: lowerPrice,
      grid_upper_price: upperPrice,
      grid_levels_count: levelsCount,
      grid_max_positions: 1,
      gridGlobalOpenRiskUsd
    };

    const scopedDatabase = Object.create(database);
    scopedDatabase.update = async (table, query, patch) => {
      if (table === 'dd_settings' && patch && patch.grid_state) {
        symbolStates[symbol] = patch.grid_state;
        root = aggregateGridState(symbolStates, configuredSymbols, root);
        return database.update(table, query, { ...patch, grid_state: root });
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
      symbolStates[symbol] = result.state;
      results.push({ symbol, ...result.safety });
      await persistRoot();
      if (result.safety?.blocked === true && haltAllReasons.has(String(result.safety.reason || ''))) break;
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
      results.push({
        symbol, executionMode: 'testnet', configured: true, trusted: false,
        blocked: true, reason: 'GRID_SYMBOL_CYCLE_ERROR',
        error: String(error?.message || error).slice(0, 220)
      });
      await persistRoot();
      break;
    }
  }

  root = aggregateGridState(symbolStates, configuredSymbols, root);
  await persistRoot();
  const blocked = results.some(result => result.blocked === true);
  return {
    state: root,
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
