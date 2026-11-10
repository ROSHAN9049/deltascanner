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


/** Calculate the 14-period Wilder-style ATR as the arithmetic mean of the
 * latest 14 true ranges. Only completed daily candles are eligible. */
export function calculateDailyAtr(candles, { periods = 14, timestamp = Date.now() } = {}) {
  const cutoff = utcDayStartSeconds(timestamp);
  const rows = (Array.isArray(candles) ? candles : [])
    .map(row => ({ ...row, _time: toEpochSeconds(row?.time ?? row?.timestamp) }))
    .filter(row => row._time !== null && row._time < cutoff)
    .sort((a, b) => a._time - b._time);
  const valid = rows.filter(row => {
    const high = Number(row.high), low = Number(row.low), close = Number(row.close);
    return Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) &&
      high > 0 && low > 0 && high >= low && close > 0;
  });
  if (!Number.isInteger(periods) || periods < 1 || valid.length < periods) {
    return { ok: false, reason: 'INSUFFICIENT_DAILY_CANDLES', periods, available: valid.length };
  }
  const trueRanges = [];
  for (let i = 0; i < valid.length; i++) {
    const high = Number(valid[i].high), low = Number(valid[i].low);
    if (i === 0) trueRanges.push(high - low);
    else {
      const previousClose = Number(valid[i - 1].close);
      trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
  }
  const selected = trueRanges.slice(-periods);
  if (selected.length !== periods || selected.some(value => !Number.isFinite(value) || value < 0)) {
    return { ok: false, reason: 'INVALID_DAILY_CANDLE_RANGE', periods, available: valid.length };
  }
  const atr = selected.reduce((sum, value) => sum + value, 0) / periods;
  const close = Number(valid.at(-1).close);
  return { ok: atr > 0 && close > 0, atr, atrPct: atr / close * 100, close, periods, candleCount: valid.length };
}

/** Center an ATR-derived band on the current mark and clamp its percentage
 * width symmetrically around that mark. The legacy daily-candle buffer is
 * retained only as a fail-safe when the ATR history is insufficient. */
export function calculateAtrGridRange(candles, {
  currentPrice, multiplier = 2.5, minRangePct = 2, maxRangePct = 20,
  fallbackCandle = null, timestamp = Date.now()
} = {}) {
  const price = Number(currentPrice);
  const mult = Number(multiplier), minPct = Number(minRangePct), maxPct = Number(maxRangePct);
  if (!(Number.isFinite(price) && price > 0 && Number.isFinite(mult) && mult > 0 &&
      Number.isFinite(minPct) && minPct > 0 && Number.isFinite(maxPct) && maxPct >= minPct && maxPct < 100)) {
    throw new Error('ATR Grid range inputs are invalid');
  }
  const atr = calculateDailyAtr(candles, { periods: 14, timestamp });
  if (!atr.ok) {
    if (!fallbackCandle) return { ok: false, reason: atr.reason, atr, fallback: true };
    const legacy = calculateAutoGridRange(fallbackCandle, { bufferPct: 3, minimumWidthPct: minPct });
    return { ok: true, ...legacy, atr: null, atrPct: null, multiplier: mult, fallback: true,
      warning: 'Fewer than 14 completed daily candles; using legacy 3% buffer' };
  }
  const rawWidthPct = atr.atr / price * 100 * mult;
  const widthPct = Math.max(minPct, Math.min(maxPct, rawWidthPct));
  const half = price * widthPct / 200;
  const lowerPrice = price - half, upperPrice = price + half;
  return {
    ok: true, lowerPrice: Number(lowerPrice.toPrecision(12)),
    upperPrice: Number(upperPrice.toPrecision(12)), widthPct,
    rawWidthPct, currentPrice: price, atr: atr.atr, atrPct: atr.atr / price * 100,
    multiplier: mult, clamped: Math.abs(widthPct - rawWidthPct) > 1e-9,
    fallback: false, candleCount: atr.candleCount
  };
}
