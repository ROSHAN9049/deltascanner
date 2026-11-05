export const DIRECT_DELTA_EXECUTION_MODE = 'testnet';
export const DELTA_TESTNET_MARKET_TICK_MAX_AGE_MS = 180_000;

export const DELTA_TESTNET_FUTURES_ALLOWLIST = Object.freeze([
  'DOGSUSD',
  'USOONUSD',
  'SNDKBUSD',
  'SPYXUSD',
  'QQQXUSD',
  'XAUTUSD',
  'PAXGUSD',
  'NVDAXUSD',
  '1000SHIBUSD'
]);

const allowedSymbols = new Set(DELTA_TESTNET_FUTURES_ALLOWLIST);

export function normalizeDeltaSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase();
}

export function isDirectDeltaExecutionMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === DIRECT_DELTA_EXECUTION_MODE;
}

export function resolveDirectDeltaExecutionEnabled(environment, mode) {
  return String(environment ?? '').trim().toUpperCase() === 'TESTNET' &&
    String(mode ?? '').trim().toLowerCase() === DIRECT_DELTA_EXECUTION_MODE;
}

export function isAllowedDeltaTestnetFutureSymbol(symbol) {
  return allowedSymbols.has(normalizeDeltaSymbol(symbol));
}

/**
 * Parse the two independent Testnet Grid instruments. Any configured symbol
 * outside the fixed Delta Testnet allowlist is a configuration error.
 */
export function parseDeltaTestnetGridSymbols(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return Object.freeze([]);
  const symbols = raw.split(',').map(normalizeDeltaSymbol);
  if (symbols.length !== 2 || symbols.some(symbol => !symbol)) {
    throw new Error('GRID_SYMBOLS must contain exactly two comma-separated Delta Testnet symbols');
  }
  if (new Set(symbols).size !== symbols.length) {
    throw new Error('GRID_SYMBOLS must contain two distinct symbols');
  }
  const invalid = symbols.find(symbol => !isAllowedDeltaTestnetFutureSymbol(symbol));
  if (invalid) {
    throw new Error('GRID_SYMBOLS contains a symbol outside the Delta Testnet allowlist: ' + invalid);
  }
  return Object.freeze(symbols);
}

export function isEligibleDeltaTestnetPerpetualProduct(product) {
  const symbol = normalizeDeltaSymbol(product?.symbol || product?.product_symbol);
  const id = Number(product?.id ?? product?.product_id);
  const onlyReduceOnly = product?.only_reduce_only_orders_allowed ??
    product?.product_specs?.only_reduce_only_orders_allowed;
  return isAllowedDeltaTestnetFutureSymbol(symbol) &&
    Number.isSafeInteger(id) && id > 0 &&
    String(product?.contract_type || '').toLowerCase() === 'perpetual_futures' &&
    String(product?.state || '').toLowerCase() === 'live' &&
    String(product?.trading_status || '').toLowerCase() === 'operational' &&
    onlyReduceOnly === false;
}

export function isMarketTickFresh(lastTickAt, now = Date.now()) {
  const timestamp = typeof lastTickAt === 'number'
    ? lastTickAt
    : Date.parse(String(lastTickAt ?? ''));
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return false;
  const age = now - timestamp;
  return age >= -30_000 && age <= DELTA_TESTNET_MARKET_TICK_MAX_AGE_MS;
}

export function canStartWorkerInExecutionProfile({
  environment,
  deltaExecutionMode,
  directDeltaExecutionEnabled,
  githubActionsPublicScanOnly = false
} = {}) {
  const normalizedEnvironment = String(environment ?? '').trim().toUpperCase();
  const normalizedMode = String(deltaExecutionMode ?? '').trim().toLowerCase();
  const scanOnlyProfile = normalizedEnvironment === 'SIGNAL_ONLY' &&
    directDeltaExecutionEnabled === false;
  const testnetProfile = normalizedEnvironment === 'TESTNET' &&
    normalizedMode === DIRECT_DELTA_EXECUTION_MODE &&
    directDeltaExecutionEnabled === true;

  if (githubActionsPublicScanOnly) return scanOnlyProfile;
  return scanOnlyProfile || testnetProfile;
}

export function getExecutionRouteBlockReason(mode, directExecutionEnabled = false) {
  return String(mode ?? '').trim().toLowerCase() === DIRECT_DELTA_EXECUTION_MODE &&
    directExecutionEnabled === true
    ? ''
    : 'Direct Delta Testnet execution is not explicitly enabled; scanner is scan-only';
}

export function assertDirectDeltaExecutionMode(mode, directExecutionEnabled = false) {
  const reason = getExecutionRouteBlockReason(mode, directExecutionEnabled);
  if (reason) {
    const error = new Error(reason);
    error.code = 'direct_delta_testnet_only';
    error.executionLocked = true;
    throw error;
  }
  return true;
}
