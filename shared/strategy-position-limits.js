export const DEFAULT_STRATEGY_POSITION_LIMITS = Object.freeze({
  MOMENTUM: 5,
  SCALPING: 5,
  GRID: 2,
  OPTIONS: 4
});

const STRATEGY_LIMIT_COLUMNS = Object.freeze({
  MOMENTUM: 'max_momentum_positions',
  SCALPING: 'max_scalping_positions',
  GRID: 'max_grid_positions',
  OPTIONS: 'max_options_positions'
});

const ACTIVE_ENTRY_STATES = new Set([
  'PENDING', 'UNKNOWN', 'NEW', 'OPEN', 'PARTIALLY_FILLED'
]);
const RECENT_FILLED_RESERVATION_MS = 120_000;

export function normalizeStrategyPositionKey(strategy) {
  const value = String(strategy || '').trim().toUpperCase();
  if (value === 'SCALP') return 'SCALPING';
  if (value === 'MOMENTUM' || value === 'SCALPING' || value === 'GRID') return value;
  if (value === 'OPTIONS' || value.startsWith('OPTIONS_')) return 'OPTIONS';
  return null;
}

export function getStrategyPositionLimit(settings = {}, strategy) {
  const key = normalizeStrategyPositionKey(strategy);
  if (!key) return null;
  const column = STRATEGY_LIMIT_COLUMNS[key];
  const raw = settings?.[column] ?? settings?.[{
    MOMENTUM: 'maxMomentumPositions',
    SCALPING: 'maxScalpingPositions',
    GRID: 'maxGridPositions',
    OPTIONS: 'maxOptionsPositions'
  }[key]] ?? DEFAULT_STRATEGY_POSITION_LIMITS[key];
  const value = Number(raw);
  // A corrupt/invalid database value must never expand the limit.
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : 1;
}

export function countOpenStrategyPositions(rows, strategy) {
  if (!Array.isArray(rows)) return null;
  const key = normalizeStrategyPositionKey(strategy);
  if (!key) return null;
  return rows.filter(row =>
    String(row?.status || '').trim().toUpperCase() === 'OPEN' &&
    normalizeStrategyPositionKey(row?.strategy) === key
  ).length;
}

function orderReservationKey(order) {
  return String(order?.client_order_id || order?.id || '').trim();
}

function positionOrderKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    for (const value of [row?.entry_order_id, row?.client_order_id, row?.order_id]) {
      const key = String(value || '').trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

function isActiveEntryReservation(order, now) {
  if (String(order?.role || '').trim().toUpperCase() !== 'ENTRY') return false;
  const state = String(order?.state || '').trim().toUpperCase();
  if (ACTIVE_ENTRY_STATES.has(state)) return true;
  if (state !== 'FILLED') return false;
  const createdAt = Date.parse(String(order?.created_at || ''));
  return Number.isFinite(createdAt) && now >= createdAt &&
    now - createdAt <= RECENT_FILLED_RESERVATION_MS;
}

/**
 * Count confirmed OPEN rows plus outstanding entry reservations. A recent
 * FILLED order consumes a slot until the private position tracker materializes
 * its OPEN row, preventing two fast scan candidates from overshooting a cap.
 */
export function assessStrategyPositionCap({
  strategy,
  settings = {},
  openPositions = null,
  pendingOrders = null,
  now = Date.now()
} = {}) {
  const key = normalizeStrategyPositionKey(strategy);
  const limit = getStrategyPositionLimit(settings, key);
  if (!key || limit === null || !Array.isArray(openPositions) || !Array.isArray(pendingOrders)) {
    return {
      strategy: key,
      limit,
      openPositions: null,
      pendingReservations: null,
      exposure: null,
      status: 'UNKNOWN',
      blocked: true,
      reason: 'Strategy position-cap data unavailable for ' + (key || 'UNKNOWN') + '; new entries fail closed'
    };
  }

  const openRows = openPositions.filter(row =>
    String(row?.status || '').trim().toUpperCase() === 'OPEN' &&
    normalizeStrategyPositionKey(row?.strategy) === key
  );
  const existingOrderKeys = positionOrderKeys(openRows);
  const reservationKeys = new Set();

  for (const order of pendingOrders) {
    if (normalizeStrategyPositionKey(order?.strategy) !== key ||
        !isActiveEntryReservation(order, Number(now))) continue;
    const reservationKey = orderReservationKey(order);
    if (!reservationKey || existingOrderKeys.has(reservationKey)) continue;
    reservationKeys.add(reservationKey);
  }

  const exposure = openRows.length + reservationKeys.size;
  const blocked = exposure >= limit;
  return {
    strategy: key,
    limit,
    openPositions: openRows.length,
    pendingReservations: reservationKeys.size,
    exposure,
    status: blocked ? 'BLOCK' : 'PASS',
    blocked,
    reason: blocked
      ? 'Strategy position cap reached (' + key + ': ' + exposure + '/' + limit + '); new entries blocked'
      : ''
  };
}
