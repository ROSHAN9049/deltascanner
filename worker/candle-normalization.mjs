// Canonical candle ingestion for Delta REST history and WebSocket updates.
// Internal timestamps are UNIX seconds aligned to the candle's timeframe bucket.
export const CANDLE_SECONDS_BY_RESOLUTION = Object.freeze({
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600
});

// strategy.atr() drops the still-forming final candle, then needs 15 closed rows
// to calculate 14 true ranges. That means at least 16 raw rows are needed.
export const MIN_RAW_CANDLES_FOR_ATR = 16;

// Testnet 1m candles may arrive a couple of minutes late over REST/WebSocket.
// Keep other timeframe freshness windows unchanged because candle timestamps
// are bucket starts, not candle-close timestamps.
export const DEFAULT_CANDLE_MAX_AGE_INTERVALS = 3;
export function candleMaxAgeIntervals(resolution, testnetMode = false) {
  return testnetMode && resolution === '1m' ? 5 : DEFAULT_CANDLE_MAX_AGE_INTERVALS;
}

export function candleIntervalSeconds(resolution) {
  return CANDLE_SECONDS_BY_RESOLUTION[resolution] || 0;
}

export function normalizeEpochSeconds(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === '') return null;
  let value;
  if (typeof rawTimestamp === 'string' && !/^-?\d+(?:\.\d+)?$/.test(rawTimestamp.trim())) {
    const parsed = Date.parse(rawTimestamp);
    if (!Number.isFinite(parsed)) return null;
    value = parsed / 1000;
  } else {
    value = Number(rawTimestamp);
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  const magnitude = Math.abs(value);
  if (magnitude >= 1e14) value /= 1e6; // microseconds -> seconds
  else if (magnitude >= 1e11) value /= 1e3; // milliseconds -> seconds
  return Math.floor(value);
}

export function candleBucketSeconds(rawTimestamp, resolution) {
  const interval = candleIntervalSeconds(resolution);
  const seconds = normalizeEpochSeconds(rawTimestamp);
  if (!interval || seconds === null) return null;
  return Math.floor(seconds / interval) * interval;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeCandle(raw, resolution) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_candle_shape' };
  }
  const interval = candleIntervalSeconds(resolution);
  if (!interval) return { ok: false, reason: 'unsupported_resolution' };
  const sourceTime = raw.time ?? raw.cst ?? raw.candle_start_time ??
    raw.timestamp ?? raw.t ?? raw.ts;
  const time = candleBucketSeconds(sourceTime, resolution);
  if (time === null) return { ok: false, reason: 'invalid_timestamp' };

  const open = finitePositive(raw.open ?? raw.o);
  const high = finitePositive(raw.high ?? raw.h);
  const low = finitePositive(raw.low ?? raw.l);
  const close = finitePositive(raw.close ?? raw.c);
  const volumeRaw = raw.volume ?? raw.v;
  const volume = volumeRaw === null || volumeRaw === undefined || volumeRaw === ''
    ? 0
    : Number(volumeRaw);
  if ([open, high, low, close].some(value => value === null) ||
      !Number.isFinite(volume) || volume < 0) {
    return { ok: false, reason: 'invalid_ohlc_value' };
  }
  if (high < low || high < open || high < close || low > open || low > close) {
    return { ok: false, reason: 'invalid_ohlc_relationship' };
  }
  return {
    ok: true,
    candle: { time, open, high, low, close, volume, res: resolution }
  };
}

export function validateNormalizedSeries(candles) {
  if (!Array.isArray(candles)) return { ok: false, reason: 'not_array' };
  let previousTime = null;
  for (let index = 0; index < candles.length; index++) {
    const result = normalizeCandle(candles[index], candles[index]?.res);
    if (!result.ok) return { ok: false, reason: result.reason, index };
    const time = Number(candles[index].time);
    if (!Number.isFinite(time) || time !== result.candle.time) {
      return { ok: false, reason: 'noncanonical_timestamp', index };
    }
    if (previousTime !== null && time <= previousTime) {
      return { ok: false, reason: time === previousTime ? 'duplicate_bucket' : 'out_of_order', index };
    }
    previousTime = time;
  }
  return { ok: true };
}

/**
 * Delta's history endpoint returns newest-first. Normalize all timestamps,
 * sort REST rows by bucket, then reject duplicates/invalid OHLC before caching.
 */
export function normalizeCandleBatch(
  rows,
  resolution,
  { nowMs = Date.now(), minCandles = MIN_RAW_CANDLES_FOR_ATR, maxAgeIntervals = DEFAULT_CANDLE_MAX_AGE_INTERVALS } = {}
) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'not_array', count: 0 };
  if (rows.length < minCandles) {
    return { ok: false, reason: 'insufficient_candles', count: rows.length, minimum: minCandles };
  }
  const candles = [];
  for (let index = 0; index < rows.length; index++) {
    const result = normalizeCandle(rows[index], resolution);
    if (!result.ok) return { ok: false, reason: result.reason, index, count: rows.length };
    candles.push(result.candle);
  }
  candles.sort((a, b) => a.time - b.time);
  const series = validateNormalizedSeries(candles);
  if (!series.ok) return { ...series, count: rows.length };

  const interval = candleIntervalSeconds(resolution);
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  const currentBucket = Math.floor(nowSeconds / interval) * interval;
  const latest = candles[candles.length - 1]?.time;
  if (!Number.isFinite(nowSeconds) || latest > currentBucket) {
    return { ok: false, reason: 'future_timestamp', count: candles.length, latest };
  }
  if (nowSeconds - latest > interval * maxAgeIntervals) {
    return { ok: false, reason: 'stale_series', count: candles.length, latest, ageSeconds: nowSeconds - latest };
  }
  return { ok: true, candles, count: candles.length, firstTime: candles[0].time, lastTime: latest };
}

/**
 * Same bucket => replace; newer bucket => append; an older update is rejected.
 */
export function mergeCandleUpdate(
  current,
  rawCandle,
  resolution,
  { nowMs = Date.now(), maxAgeIntervals = DEFAULT_CANDLE_MAX_AGE_INTERVALS } = {}
) {
  const normalized = normalizeCandle(rawCandle, resolution);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const candle = normalized.candle;
  const interval = candleIntervalSeconds(resolution);
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  const currentBucket = Math.floor(nowSeconds / interval) * interval;
  if (!Number.isFinite(nowSeconds) || candle.time > currentBucket) {
    return { ok: false, reason: 'future_timestamp', candle };
  }
  if (nowSeconds - candle.time > interval * maxAgeIntervals) {
    return { ok: false, reason: 'stale_candle', candle, ageSeconds: nowSeconds - candle.time };
  }
  const series = Array.isArray(current) ? current : [];
  const validity = validateNormalizedSeries(series);
  if (!validity.ok) return { ok: false, reason: 'invalid_existing_series', detail: validity.reason };

  const last = series.at(-1);
  if (!last) return { ok: true, action: 'appended', candles: [candle], candle };
  if (candle.time < last.time) {
    return { ok: false, reason: 'out_of_order', candle, latestTime: last.time };
  }
  if (candle.time === last.time) {
    const replacement = [...series];
    replacement[replacement.length - 1] = candle;
    return { ok: true, action: 'replaced', candles: replacement, candle };
  }
  return { ok: true, action: 'appended', candles: [...series, candle], candle };
}
