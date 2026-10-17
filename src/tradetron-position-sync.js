const POSITION_SYMBOL_KEYS = [
  'instrument_symbol', 'instrumentSymbol', 'trading_symbol', 'tradingSymbol',
  'tradingsymbol', 'contract_symbol', 'contractSymbol', 'instrument', 'symbol', 'asset', 'name'
];
const POSITION_QTY_KEYS = [
  'net_quantity', 'netQuantity', 'net_qty', 'netQty', 'signed_position_size',
  'signedPositionSize', 'quantity', 'qty', 'position_qty', 'positionQty',
  'open_quantity', 'openQuantity', 'open_qty', 'openQty', 'position_size',
  'positionSize', 'size'
];
const OPEN_FLAG_KEYS = ['open', 'is_open', 'isOpen', 'open_position', 'isOpenPosition'];
const POSITION_STATUS_KEYS = ['position_status', 'positionStatus', 'status', 'state'];
const ENTRY_PRICE_KEYS = [
  'entry_price', 'entryPrice', 'average_entry_price', 'averageEntryPrice',
  'average_price', 'averagePrice', 'avg_price', 'avgPrice', 'price', 'entry'
];
const MARK_PRICE_KEYS = [
  'ltp', 'last_traded_price', 'lastTradedPrice', 'mark_price', 'markPrice',
  'current_price', 'currentPrice', 'last_price', 'lastPrice'
];
const POSITION_VALUE_KEYS = [
  'market_value', 'marketValue', 'position_value', 'positionValue',
  'value', 'notional', 'notional_value', 'notionalValue'
];
const POSITION_PNL_KEYS = [
  'm2m', 'mtm', 'unrealized_pnl', 'unrealizedPnl', 'open_pnl', 'openPnl',
  'mark_to_market', 'markToMarket', 'pnl'
];

const DEFAULT_POSITION_DUST_THRESHOLD = 0.0001;
const loggedDustSymbols = new Set();

function configuredPositionDustThreshold() {
  const raw = globalThis.process?.env?.POSITION_DUST_THRESHOLD;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_POSITION_DUST_THRESHOLD;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_POSITION_DUST_THRESHOLD;
}

const clean = value => String(value ?? '').trim();

function firstValue(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && clean(row[key]) !== '') {
      return row[key];
    }
  }
  return null;
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || clean(value) === '') return null;
  const source = clean(value);
  const negativeByParentheses = /^\(.*\)$/.test(source);
  const numericText = source.replace(/[,$₹\s]/g, '').replace(/[^\d.eE+-]/g, '');
  if (!numericText || !/[\d]/.test(numericText)) return null;
  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return null;
  return negativeByParentheses ? -Math.abs(parsed) : parsed;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = clean(value).toLowerCase();
  if (['true', 'yes', '1', 'open', 'opened', 'entered', 'active'].includes(text)) return true;
  if (['false', 'no', '0', 'closed', 'close', 'exited', 'flat'].includes(text)) return false;
  return null;
}

function displaySymbol(value) {
  const raw = clean(value);
  if (!raw) return '';

  // Tradetron rows can identify futures with keys such as
  // FUTCRYPTO_DIN-LINKUSD_31DEC2099_XX_0. Extract the Delta contract
  // instead of showing the full futures identifier.
  const embeddedContract = raw.match(/(?:^|[_ -])DIN[-_]?([A-Z0-9]+)(?=[_ ]|$)/i);
  if (embeddedContract) return embeddedContract[1].toUpperCase();

  return raw.replace(/^DIN[-_]?/i, '').split(/[ _]/)[0].toUpperCase();
}

function hasPositionStatus(row) {
  const status = clean(firstValue(row, POSITION_STATUS_KEYS)).toLowerCase();
  if (['closed', 'close', 'exited', 'flat', 'square-off', 'squared-off'].includes(status)) return false;
  if (['open', 'opened', 'entered', 'active', 'live-entered'].includes(status)) return true;
  return null;
}

/**
 * Normalizes a raw Tradetron Developer API position row for display only.
 * It deliberately does not promote snapshot rows to fill/trade-ledger records.
 */
export function normalizeTradetronPosition(position, deployment = {}) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) return null;
  const rawSymbol = clean(firstValue(position, POSITION_SYMBOL_KEYS));
  const symbol = displaySymbol(rawSymbol);
  if (!symbol) return null;

  const quantity = numericValue(firstValue(position, POSITION_QTY_KEYS));
  const explicitOpen = booleanValue(firstValue(position, OPEN_FLAG_KEYS));
  const statusOpen = hasPositionStatus(position);
  const dustThreshold = configuredPositionDustThreshold();
  const quantityBelowDustThreshold = quantity !== null && Math.abs(quantity) < dustThreshold;
  const closedDueToDust = quantityBelowDustThreshold && Math.abs(quantity) > 0;

  // Tiny nonzero quantities and zero quantity cannot represent a current open
  // leg, even when a stale API flag still says open. Keep this threshold local
  // to snapshot normalization; aggregate reconciliation remains strict.
  if (closedDueToDust && globalThis.process?.versions?.node) {
    const logKey = symbol;
    if (!loggedDustSymbols.has(logKey)) {
      loggedDustSymbols.add(logKey);
      console.warn(
        '[Tradetron Position Sync] Position treated as closed due to dust quantity: ' +
        symbol + ', qty=' + quantity
      );
    }
  }

  // Explicit close flags still win for meaningful historical quantities.
  const explicitlyClosed = explicitOpen === false || statusOpen === false;
  const open = quantityBelowDustThreshold
    ? false
    : explicitlyClosed
      ? false
      : quantity !== null && quantity !== 0
        ? true
        : explicitOpen === true || statusOpen === true;

  const price = numericValue(firstValue(position, ENTRY_PRICE_KEYS));
  const markPrice = numericValue(firstValue(position, MARK_PRICE_KEYS));
  const pnlSource = POSITION_PNL_KEYS.find(key =>
    position[key] !== undefined && position[key] !== null && clean(position[key]) !== ''
  ) || null;
  const pnl = numericValue(pnlSource ? position[pnlSource] : null);
  const value = numericValue(firstValue(position, POSITION_VALUE_KEYS));
  const sideRaw = clean(firstValue(position, ['side', 'position_side', 'positionSide', 'direction'])).toUpperCase();
  const side = quantity !== null && quantity !== 0
    ? (quantity < 0 ? 'SELL' : 'BUY')
    : (['BUY', 'LONG'].includes(sideRaw) ? 'BUY' : ['SELL', 'SHORT'].includes(sideRaw) ? 'SELL' : '');

  const identity = clean(firstValue(position, [
    'position_id', 'positionId', 'leg_id', 'legId', 'trade_id', 'tradeId',
    'execution_id', 'executionId', 'id'
  ])) || rawSymbol || symbol;

  return {
    key: String(deployment.deployment_id ?? 'deployment') + ':' + identity,
    deploymentId: deployment.deployment_id ?? null,
    deploymentName: clean(deployment.deployment_name || deployment.name) || 'Tradetron deployment',
    currencyCode: clean(deployment.currency_code || deployment.currencyCode || '').toUpperCase() || null,
    rawSymbol,
    symbol,
    side,
    quantity,
    entryPrice: price,
    markPrice,
    marketValue: value,
    pnl,
    pnlSource,
    open,
    closedDueToDust,
    status: quantityBelowDustThreshold
      ? (closedDueToDust ? 'Closed (dust)' : 'Closed')
      : clean(firstValue(position, POSITION_STATUS_KEYS)) || (open ? 'Open' : 'Closed'),
    raw: position
  };
}

export function normalizeTradetronPositions(deployments = []) {
  return (Array.isArray(deployments) ? deployments : []).flatMap(deployment =>
    (Array.isArray(deployment?.positions) ? deployment.positions : [])
      .map(position => normalizeTradetronPosition(position, deployment))
      .filter(Boolean)
  );
}

export function summarizeTradetronSnapshots(deployments = []) {
  const rows = Array.isArray(deployments) ? deployments : [];
  const normalized = normalizeTradetronPositions(rows);
  const openRows = normalized.filter(position => position.open);
  const visibleRows = rows.filter(row => row?.positions_hidden !== true);
  const reportedOpenCounts = rows
    .map(row => numericValue(row?.open_positions))
    .filter(value => value !== null && value >= 0);
  const reportedOpenCountComplete = rows.length > 0 && rows.every(row => {
    const value = numericValue(row?.open_positions);
    return value !== null && value >= 0;
  });
  const reportedOpenCount = reportedOpenCounts.length
    ? reportedOpenCounts.reduce((total, value) => total + value, 0)
    : null;
  // A hidden or incomplete snapshot cannot prove there are zero open legs.
  // Use the reported aggregate only when every deployment has a valid count;
  // otherwise use identifiable rows only if positions are not hidden.
  const openCount = reportedOpenCountComplete
    ? Math.max(reportedOpenCount, openRows.length)
    : rows.some(row => row?.positions_hidden === true)
      ? null
      : openRows.length;
  const pnlValues = rows.map(row => numericValue(row?.pnl));
  const reportedCurrencyCodes = rows.map(row =>
    clean(row?.currency_code || row?.currencyCode || '').toUpperCase()
  );
  const distinctReportedCurrencies = new Set(reportedCurrencyCodes.filter(Boolean));
  const reportedCurrencyCode = reportedCurrencyCodes.length > 0 &&
    reportedCurrencyCodes.every(code => /^[A-Z]{3}$/.test(code)) &&
    distinctReportedCurrencies.size === 1
    ? reportedCurrencyCodes[0]
    : null;
  // A single deployment's reported number may be displayed as raw data. Across
  // deployments, aggregate only when every P&L value is present and the API
  // explicitly identifies one common currency for every deployment.
  const reportedPnlComparable = rows.length === 1 ||
    (reportedCurrencyCode !== null && reportedCurrencyCodes.length === rows.length);
  const reportedPnl = rows.length > 0 &&
    pnlValues.every(value => value !== null) &&
    reportedPnlComparable
    ? pnlValues.reduce((total, value) => total + value, 0)
    : null;
  // Generic per-row "pnl" is not enough to claim open/unrealized P&L.
  // Only sum fields explicitly named as mark-to-market/unrealized P&L.
  const explicitOpenPnlSources = new Set([
    'm2m', 'mtm', 'unrealized_pnl', 'unrealizedPnl',
    'open_pnl', 'openPnl', 'mark_to_market', 'markToMarket'
  ]);
  const openPnlValues = openRows.map(row =>
    explicitOpenPnlSources.has(row.pnlSource) ? row.pnl : null
  );
  const openDeploymentIds = new Set(openRows.map(row => String(row.deploymentId ?? 'unknown')));
  const openCurrencyCodes = openRows.map(row => row.currencyCode);
  const distinctOpenCurrencies = new Set(openCurrencyCodes.filter(Boolean));
  const openCurrencyComparable = openDeploymentIds.size <= 1 ||
    (openCurrencyCodes.every(code => typeof code === 'string' && /^[A-Z]{3}$/.test(code)) &&
      distinctOpenCurrencies.size === 1);
  const openPnl = openPnlValues.length &&
    openPnlValues.every(value => value !== null) &&
    openCurrencyComparable
    ? openPnlValues.reduce((total, value) => total + value, 0)
    : null;

  return {
    deployments: rows.length,
    visibleDeployments: visibleRows.length,
    totalRows: normalized.length,
    openRows,
    openCount,
    reportedPnl,
    reportedPnlCurrencyCode: reportedCurrencyCode,
    openPnl,
    positionsHidden: rows.some(row => row?.positions_hidden === true),
    asOf: rows.reduce((latest, row) => {
      const candidate = row?.as_of || row?.last_success_at || null;
      return candidate && (!latest || Date.parse(candidate) > Date.parse(latest)) ? candidate : latest;
    }, null)
  };
}

export const TRADETRON_SNAPSHOT_MAX_AGE_MS = 180000;

/**
 * Canonical dashboard count for current positions. A private event ledger and
 * a read-only Tradetron snapshot have different meanings, so this helper never
 * silently substitutes a missing/stale API snapshot with zero.
 */
export function summarizeCurrentPositionCount({
  eventPositions = [],
  deployments = [],
  syncState = null,
  configured = false,
  now = Date.now(),
  maxAgeMs = TRADETRON_SNAPSHOT_MAX_AGE_MS
} = {}) {
  const mirror = summarizeTradetronSnapshots(deployments);
  const eventCount = (Array.isArray(eventPositions) ? eventPositions : []).filter(row =>
    Math.abs(Number(row?.qty ?? row?.quantity) || 0) > 0
  ).length;

  if (!configured) {
    return {
      status: 'EVENT_LEDGER_ONLY',
      source: 'authenticated-event-ledger',
      count: eventCount,
      lastKnownCount: null,
      lastSuccessAt: null,
      ageMs: null,
      detail: 'Tradetron Developer API snapshot is not configured; count reflects the authenticated event ledger only.'
    };
  }

  const lastSuccessMs = Date.parse(syncState?.last_success_at || '');
  const ageMs = Number.isFinite(lastSuccessMs) ? now - lastSuccessMs : null;
  const expectedIds = Array.isArray(syncState?.details?.deploymentIds)
    ? [...new Set(syncState.details.deploymentIds.map(value => String(value ?? '').trim()).filter(Boolean))]
    : null;
  const actualIds = new Set((Array.isArray(deployments) ? deployments : [])
    .map(row => String(row?.deployment_id ?? '').trim()).filter(Boolean));
  const expectedDeploymentCount = numericValue(syncState?.deployment_count);
  const snapshotCoverageComplete = expectedIds
    ? expectedIds.every(id => actualIds.has(id)) && actualIds.size === expectedIds.length
    : expectedDeploymentCount !== null
      ? expectedDeploymentCount === (Array.isArray(deployments) ? deployments.length : 0)
      : (Array.isArray(deployments) ? deployments.length : 0) > 0;
  const fresh = String(syncState?.status || '').toUpperCase() === 'OK' &&
    ageMs !== null && ageMs >= 0 && ageMs <= maxAgeMs && snapshotCoverageComplete;

  if (!fresh || mirror.openCount === null) {
    const status = ageMs !== null && ageMs > maxAgeMs
      ? 'STALE'
      : String(syncState?.status || 'WAITING_FOR_SYNC').toUpperCase() === 'PARTIAL'
        ? 'INCOMPLETE'
        : String(syncState?.status || 'WAITING_FOR_SYNC').toUpperCase() === 'ERROR'
          ? 'SYNC_ERROR'
          : mirror.openCount === null && fresh ? 'COUNT_UNKNOWN' : 'UNVERIFIED';
    return {
      status,
      source: 'tradetron-developer-api',
      count: null,
      lastKnownCount: mirror.openCount,
      lastSuccessAt: syncState?.last_success_at || null,
      ageMs,
      detail: 'Current open-position count is not confirmed by a fresh, complete Tradetron snapshot; do not interpret this as zero.'
    };
  }

  return {
    status: 'FRESH',
    source: 'tradetron-developer-api',
    count: mirror.openCount,
    lastKnownCount: mirror.openCount,
    lastSuccessAt: syncState?.last_success_at || null,
    ageMs,
    detail: 'Current position count comes from the fresh read-only Tradetron API snapshot; it is not proof of authenticated fill events.'
  };
}

/**
 * Turn only a complete, fresh, read-only snapshot into duplicate-entry blockers.
 * Snapshot rows never become fill, trade-history, or exit-monitor records.
 */
export function buildTradetronSnapshotRiskState({
  syncState = null,
  deployments = [],
  now = Date.now(),
  maxAgeMs = TRADETRON_SNAPSHOT_MAX_AGE_MS
} = {}) {
  const details = syncState?.details && typeof syncState.details === 'object'
    ? syncState.details
    : {};
  const lastSuccessMs = Date.parse(syncState?.last_success_at || '');
  const ageMs = Number.isFinite(lastSuccessMs) ? now - lastSuccessMs : null;
  const status = String(syncState?.status || '').trim().toUpperCase();
  const fail = reason => ({
    configured: true,
    trusted: false,
    reason,
    openPositions: [],
    positionCount: null,
    lastSuccessAt: syncState?.last_success_at || null,
    ageMs
  });

  if (status !== 'OK') return fail('SYNC_NOT_OK');
  if (ageMs === null || ageMs < 0 || ageMs > maxAgeMs) return fail('SNAPSHOT_STALE');
  const deploymentIds = Array.isArray(details.deploymentIds)
    ? [...new Set(details.deploymentIds.map(value => String(value ?? '').trim()).filter(value => /^\d+$/.test(value)))]
    : [];
  if (!deploymentIds.length) return fail('NO_DEPLOYMENT_COVERAGE');

  const rows = (Array.isArray(deployments) ? deployments : []).filter(row =>
    deploymentIds.includes(String(row?.deployment_id ?? '').trim())
  );
  if (rows.length !== deploymentIds.length) return fail('DEPLOYMENT_COVERAGE_INCOMPLETE');
  if (rows.some(row => row?.positions_hidden === true)) return fail('POSITIONS_HIDDEN');
  if (rows.some(row => {
    const snapshotAt = Date.parse(row?.last_success_at || '');
    const snapshotAge = Number.isFinite(snapshotAt) ? now - snapshotAt : null;
    return snapshotAge === null || snapshotAge < 0 || snapshotAge > maxAgeMs;
  })) return fail('POSITION_SNAPSHOT_STALE');

  const reportedOpenCounts = rows.map(row => numericValue(row?.open_positions));
  if (reportedOpenCounts.some(value => value === null || !Number.isInteger(value) || value < 0)) {
    return fail('OPEN_POSITION_COUNT_UNAVAILABLE');
  }
  const reportedOpenCount = reportedOpenCounts.reduce((total, value) => total + value, 0);
  const summary = summarizeTradetronSnapshots(rows);
  const openRows = summary.openRows;
  // The normalizer must match Tradetron's explicit open-leg count exactly.
  // Using max(reported, normalized) masks historical rows with a stale nonzero
  // quantity and can make an incomplete position snapshot look trustworthy.
  if (reportedOpenCount !== openRows.length) return fail('OPEN_POSITION_COUNT_UNRECONCILED');
  if (openRows.some(row => {
    const qty = numericValue(row.quantity);
    return !/^[A-Z0-9]+USD$/.test(row.symbol || '') ||
      row.symbol === 'USD' ||
      !['BUY', 'SELL'].includes(row.side) ||
      qty === null ||
      qty === 0;
  })) return fail('OPEN_POSITION_ROW_UNVERIFIED');

  const openPositions = openRows.map(row => ({
    symbol: row.symbol,
    side: row.side,
    qty: Math.abs(numericValue(row.quantity)),
    strategy: 'TT_API_SNAPSHOT',
    origin: 'TRADETRON_API_SNAPSHOT',
    execution_id: 'tt-api:' + row.key,
    updated_at: row.raw?.updated_at || row.raw?.as_of || syncState?.last_success_at || null,
    snapshot_only: true
  }));

  return {
    configured: true,
    trusted: true,
    reason: null,
    openPositions,
    positionCount: openPositions.length,
    lastSuccessAt: syncState?.last_success_at || null,
    ageMs
  };
}
