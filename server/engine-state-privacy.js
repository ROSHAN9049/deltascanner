const hideSignalSizing = rows => (Array.isArray(rows) ? rows : []).map(row => {
  const existing = Array.isArray(row?.blocked_reasons)
    ? row.blocked_reasons.filter(item => typeof item === 'string')
    : String(row?.blocked_reasons || '').split(' · ').filter(Boolean);
  return {
    ...row,
    qty: null,
    quantity: null,
    qty_contracts: null,
    notional: null,
    risk_usd: null,
    ready: false,
    blocked_reasons: [...new Set([...existing, 'Account sizing hidden; enter ENGINE_SECRET'])]
  };
});

export function findWorkerHeartbeatRow(logs) {
  return (Array.isArray(logs) ? logs : []).find(item =>
    String(item?.message || '').startsWith('Worker heartbeat scan')
  ) || null;
}

export function normalizeWorkerExecutionMode(row) {
  const mode = String(row?.data?.executionMode || row?.data?.deltaExecutionMode || '').trim().toLowerCase();
  return ['testnet', 'disabled'].includes(mode) ? mode : 'unknown';
}

const safeDiagnosticCount = value => {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
};

const SAFE_OPTION_UNDERLYINGS = new Set(['BTC', 'ETH', 'XAUT']);
const SAFE_GRID_DIAGNOSTIC_STATUSES = new Set([
  'WAITING_FOR_MARKET_DATA', 'WAITING_FOR_TESTNET_PRODUCTS',
  'DIAGNOSTICS_ONLY', 'DIAGNOSTICS_ERROR'
]);
const SAFE_OPTIONS_DIAGNOSTIC_STATUSES = new Set([
  'DISABLED_BY_SETTING', 'DIAGNOSTICS_ERROR', 'WAITING_FOR_TESTNET_PRODUCTS',
  'WAITING_FOR_TESTNET_QUOTES', 'WAITING_FOR_TESTNET_GREEKS',
  'DIAGNOSTICS_ACTIVE', 'ANALYSIS_ACTIVE'
]);

function publicGridTestnetDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  const symbol = ['BTCUSD', 'ETHUSD'].includes(String(value.symbol || '').toUpperCase())
    ? String(value.symbol).toUpperCase() : null;
  const status = SAFE_GRID_DIAGNOSTIC_STATUSES.has(String(value.status || ''))
    ? String(value.status) : 'WAITING_FOR_TESTNET_PRODUCTS';
  return {
    symbol,
    executionMode: String(value.executionMode || '').toLowerCase() === 'testnet' ? 'testnet' : 'unknown',
    enabled: value.enabled === true,
    marketDataAvailable: value.marketDataAvailable === true,
    testnetProductAvailable: value.testnetProductAvailable === true,
    executionLocked: true,
    status,
    candlesAvailable: safeDiagnosticCount(value.candlesAvailable),
    candlesFresh: value.candlesFresh === true,
    candidateEntries: safeDiagnosticCount(value.candidateEntries) ?? 0,
    candidateExits: safeDiagnosticCount(value.candidateExits) ?? 0,
    orderRoutingAttempted: false,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : null
  };
}

function publicOptionsTestnetDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  const safeCounts = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    return Object.fromEntries(Object.entries(source)
      .filter(([key]) => SAFE_OPTION_UNDERLYINGS.has(String(key).toUpperCase()))
      .map(([key, count]) => [String(key).toUpperCase(), safeDiagnosticCount(count) ?? 0]));
  };
  const safeUnderlyings = source => Array.isArray(source)
    ? source.map(item => String(item).toUpperCase()).filter(item => SAFE_OPTION_UNDERLYINGS.has(item))
    : [];
  const status = SAFE_OPTIONS_DIAGNOSTIC_STATUSES.has(String(value.status || ''))
    ? String(value.status) : 'DIAGNOSTICS_ERROR';
  return {
    executionMode: String(value.executionMode || '').toLowerCase() === 'testnet' ? 'testnet' : 'unknown',
    enabled: value.enabled === true,
    supportedUnderlyings: safeUnderlyings(value.supportedUnderlyings),
    productCountsByUnderlying: safeCounts(value.productCountsByUnderlying),
    quoteCountsByUnderlying: safeCounts(value.quoteCountsByUnderlying),
    greeksAvailableByUnderlying: safeCounts(value.greeksAvailableByUnderlying),
    greeksMissingByUnderlying: safeCounts(value.greeksMissingByUnderlying),
    testnetProductsAvailable: safeDiagnosticCount(value.testnetProductsAvailable),
    optionTickersAvailable: safeDiagnosticCount(value.optionTickersAvailable),
    missingUnderlyings: safeUnderlyings(value.missingUnderlyings),
    executionLocked: true,
    status,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : null
  };
}

function publicHeartbeatRows(logs) {
  const row = findWorkerHeartbeatRow(logs);
  if (!row) return [];
  const mode = normalizeWorkerExecutionMode(row);
  const grid = row?.data?.gridEntrySafety;
  return [{
    id: row.id ?? null,
    level: row.level ?? 'INFO',
    message: 'Worker heartbeat scan',
    created_at: row.created_at ?? null,
    data: {
      executionMode: mode,
      deltaExecutionMode: mode,
      deltaEnvironment: String(row?.data?.deltaEnvironment || '').slice(0, 40) || null,
      lastTickAt: row?.data?.lastTickAt || null,
      gridEntrySafety: grid && typeof grid === 'object' ? {
        configured: grid.configured === true,
        trusted: typeof grid.trusted === 'boolean' ? grid.trusted : null,
        blocked: grid.blocked === true,
        reason: String(grid.reason || '').slice(0, 100) || null
      } : null,
      gridTestnetDiagnostics: publicGridTestnetDiagnostics(row?.data?.gridTestnetDiagnostics),
      optionsTestnetDiagnostics: publicOptionsTestnetDiagnostics(row?.data?.optionsTestnetDiagnostics)
    }
  }];
}

/** Normalize Postgres boolean representations before the UI consumes engine state. */
export function normalizeEmergencyStopValue(value) {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', 'f', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

/** Hide private account ledgers and sizing unless the engine session is authenticated. */
export function protectEngineState(payload, authorized) {
  const state = { ...payload, accountDataProtected: !authorized };
  if (authorized) return state;

  const settings = payload?.settings && typeof payload.settings === 'object'
    ? {
        ...payload.settings,
        equity: null,
        available_balance: null,
        realized_pnl: null,
        unrealized_pnl: null,
        fees_today: null,
        grid_state: null
      }
    : null;

  return {
    ...state,
    settings,
    activity: payload?.activity && typeof payload.activity === 'object'
      ? {
          ...payload.activity,
          lastExecutedTradeAt: null,
          lastExecutedTradeAvailable: false,
          executedTradesTodayCount: null
        }
      : null,
    ledger: [],
    ledgerRowCount: null,
    signals: hideSignalSizing(payload?.signals),
    signalCache: hideSignalSizing(payload?.signalCache),
    optionCache: hideSignalSizing(payload?.optionCache),
    logs: publicHeartbeatRows(payload?.logs),
    executionCoverage: {
      directDeltaExecutionEnabled: false,
      deltaExecutionMode: payload?.executionCoverage?.deltaExecutionMode || 'unknown',
      deltaExecutionModeSource: payload?.executionCoverage?.deltaExecutionModeSource || 'unavailable',
      gridEntrySafety: null,
      gridTestnetDiagnostics: publicGridTestnetDiagnostics(payload?.executionCoverage?.gridTestnetDiagnostics),
      optionsTestnetDiagnostics: publicOptionsTestnetDiagnostics(payload?.executionCoverage?.optionsTestnetDiagnostics)
    },
    deltaTestnetPositions: [],
    deltaTestnetOpenPositionCount: null,
    deltaTestnetOrders: [],
    deltaTestnetOrderCount: null,
    deltaTestnetTrades: [],
    deltaTestnetTradeRowCount: null,
    deltaTestnetClosedTodayCount: null,
    deltaTestnetClosedTodayPnl: null,
    deltaTestnetClosedTodayPnlComplete: false,
    deltaTestnetFillSyncState: null,
    deltaTestnetFillCount: null,
    deltaTestnetWalletTransactions: [],
    deltaTestnetWalletTransactionRowCount: null,
    deltaTestnetWalletSyncState: null
  };
}
