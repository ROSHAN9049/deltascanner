const DAY_SECONDS = 24 * 60 * 60;

function toEpochSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
}

export function utcDayStartSeconds(timestamp = Date.now()) {
  const seconds = toEpochSeconds(timestamp);
  if (seconds === null) throw new Error('A valid timestamp is required');
  return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
}

export function utcDayKey(timestamp = Date.now()) {
  return new Date(utcDayStartSeconds(timestamp) * 1000).toISOString().slice(0, 10);
}

/**
 * Return the fully closed 1D candle for the previous UTC day.
 * The current UTC day's still-forming candle is deliberately never selected.
 */
export function selectLatestCompletedDailyCandle(candles, timestamp = Date.now()) {
  if (!Array.isArray(candles)) return null;
  const expectedStart = utcDayStartSeconds(timestamp) - DAY_SECONDS;
  const matching = candles.filter(row => toEpochSeconds(row?.time ?? row?.timestamp) === expectedStart);
  return matching.length ? matching.at(-1) : null;
}

/**
 * Build a daily range with a 3% outer buffer. The minimum-width rule is
 * measured relative to the lower boundary and only widens an otherwise
 * narrower-than-2% band; it never narrows the buffered daily high/low range.
 */
export function calculateAutoGridRange(candle, {
  bufferPct = 3,
  minimumWidthPct = 2
} = {}) {
  const low = Number(candle?.low);
  const high = Number(candle?.high);
  const buffer = Number(bufferPct);
  const minimumWidth = Number(minimumWidthPct);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
    throw new Error('Daily candle must contain a positive low and a high greater than or equal to low');
  }
  if (!Number.isFinite(buffer) || buffer < 0 || buffer >= 50 ||
      !Number.isFinite(minimumWidth) || minimumWidth <= 0 || minimumWidth >= 100) {
    throw new Error('Auto-range buffer or minimum width is invalid');
  }

  let lowerPrice = low * (1 - buffer / 100);
  let upperPrice = high * (1 + buffer / 100);
  let expandedForMinimumWidth = false;
  const widthPct = () => (upperPrice - lowerPrice) / lowerPrice * 100;
  if (widthPct() < minimumWidth) {
    const center = (lowerPrice + upperPrice) / 2;
    const halfWidth = center * minimumWidth / 200;
    lowerPrice = center - halfWidth;
    upperPrice = center + halfWidth;
    expandedForMinimumWidth = true;
  }
  if (!(Number.isFinite(lowerPrice) && Number.isFinite(upperPrice) && lowerPrice > 0 && upperPrice > lowerPrice)) {
    throw new Error('Calculated Auto-Range is invalid');
  }
  return {
    lowerPrice: Number(lowerPrice.toPrecision(12)),
    upperPrice: Number(upperPrice.toPrecision(12)),
    dailyLow: low,
    dailyHigh: high,
    bufferPct: buffer,
    widthPct: widthPct(),
    expandedForMinimumWidth
  };
}

/** First enabled cycle seeds the range. Daily refreshes require both trailing gates. */
export function isAutoGridRangeRefreshDue({
  enabled = false,
  trailingEnvironmentEnabled = false,
  trailingSettingEnabled = false,
  lastAppliedUtcDay = null,
  timestamp = Date.now()
} = {}) {
  if (enabled !== true) return false;
  const today = utcDayKey(timestamp);
  const lastDay = String(lastAppliedUtcDay || '').trim();
  if (!lastDay) return true;
  return trailingEnvironmentEnabled === true &&
    trailingSettingEnabled === true &&
    lastDay < today;
}

/** Fail-closed exposure predicate shared by the worker and unit tests. */
export function hasGridAutoRangeExposure({
  symbols = [],
  exchangePositions = [],
  exchangeOrders = [],
  databasePositions = [],
  databaseOrders = [],
  gridState = {}
} = {}) {
  const allowed = new Set((Array.isArray(symbols) ? symbols : [])
    .map(value => String(value || '').trim().toUpperCase()).filter(Boolean));
  if (!allowed.size) return true;
  const matchesSymbol = row => allowed.has(String(row?.symbol || row?.product_symbol || '').trim().toUpperCase());
  const hasRows = rows => Array.isArray(rows) && rows.some(matchesSymbol);
  if (hasRows(exchangePositions) || hasRows(exchangeOrders) ||
      hasRows(databasePositions) || hasRows(databaseOrders)) return true;

  const states = gridState?.symbolStates && typeof gridState.symbolStates === 'object'
    ? Object.values(gridState.symbolStates) : [];
  const rootPositions = Array.isArray(gridState?.positions) ? gridState.positions : [];
  const rootPending = Array.isArray(gridState?.pendingEntries) ? gridState.pendingEntries : [];
  return [...rootPositions, ...rootPending,
    ...states.flatMap(state => [
      ...(Array.isArray(state?.positions) ? state.positions : []),
      ...(Array.isArray(state?.pendingEntries) ? state.pendingEntries : [])
    ])
  ].some(matchesSymbol);
}
