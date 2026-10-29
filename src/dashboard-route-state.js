export const TESTNET_ROUTE_CATALOG_MAX_AGE_MS = 60_000;
const ALLOWED_CLOCK_SKEW_MS = 5_000;

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]+USD$/.test(symbol) ? symbol : '';
}

function isVerifiedTradableProduct(product) {
  const id = Number(product?.id);
  return Boolean(
    product &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    normalizeSymbol(product.symbol) &&
    product.contract_type === 'perpetual_futures' &&
    product.state === 'live' &&
    product.trading_status === 'operational' &&
    product.only_reduce_only_orders_allowed === false
  );
}

/**
 * Resolve the dashboard's route evidence without turning missing data into a
 * PASS. A verified public product catalog proves instrument availability only;
 * execution mode and position-state trust are checked separately.
 */
export function resolveDashboardRouteContext({
  catalog = null,
  executionMode = 'unknown',
  accountDataProtected = true,
  positions = null,
  openPositionCount = null,
  now = Date.now
} = {}) {
  const nowValue = Number(typeof now === 'function' ? now() : now);
  const checkedAtMs = Date.parse(catalog?.checkedAt || '');
  const catalogAgeMs = Number.isFinite(nowValue) && Number.isFinite(checkedAtMs)
    ? nowValue - checkedAtMs
    : null;
  const catalogFresh = catalog?.success === true &&
    catalog?.environment === 'DELTA_TESTNET' &&
    catalog?.complete === true &&
    Array.isArray(catalog?.result) &&
    Number.isSafeInteger(catalog?.count) &&
    catalog.count === catalog.result.length &&
    catalogAgeMs !== null &&
    catalogAgeMs >= -ALLOWED_CLOCK_SKEW_MS &&
    catalogAgeMs <= TESTNET_ROUTE_CATALOG_MAX_AGE_MS;

  const routedSymbols = catalogFresh
    ? [...new Set(catalog.result.filter(isVerifiedTradableProduct).map(product => normalizeSymbol(product.symbol)))]
    : [];
  const normalizedMode = String(executionMode || '').trim().toLowerCase();
  const testnetModeConfirmed = normalizedMode === 'testnet';
  const routeDataVerified = catalogFresh && testnetModeConfirmed;

  const currentPositions = Array.isArray(positions) ? positions : null;
  const currentOpenCount = openPositionCount;
  const actualOpenRowCount = currentPositions
    ? currentPositions.filter(position => String(position?.status || '').trim().toUpperCase() === 'OPEN').length
    : null;
  const positionLedgerVerified = accountDataProtected === false &&
    currentPositions !== null &&
    Number.isSafeInteger(currentOpenCount) &&
    currentOpenCount >= 0 &&
    actualOpenRowCount === currentOpenCount;
  const entrySafetyTrusted = testnetModeConfirmed && positionLedgerVerified;

  return {
    routedSymbols,
    routeDataVerified,
    entrySafetyTrusted,
    catalogFresh,
    testnetModeConfirmed,
    positionLedgerVerified,
    catalogAgeMs
  };
}
