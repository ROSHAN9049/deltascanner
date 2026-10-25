import { normalizeCandleBatch, normalizeEpochSeconds, MIN_RAW_CANDLES_FOR_ATR } from './candle-normalization.mjs';

// Closed-candle analysis drops the last (possibly still-open) candle.
// Fetch at least one extra row beyond the strategy's minimum closed-candle count.
export const CANDLE_RESOLUTIONS = Object.freeze(['1m', '5m', '15m']);
export const CANDLE_WARMUP_BATCH_SIZE = 24;
export const CANDLE_WARMUP_RETRY_MS = 60_000;
// In Testnet execution mode the candle source may include thin or newly listed
// products. Process a smaller batch and retry deficient series less often.
export const CANDLE_TESTNET_WARMUP_BATCH_SIZE = 6;
export const CANDLE_TESTNET_WARMUP_CONCURRENCY = 2;
export const CANDLE_TESTNET_WARMUP_RETRY_MS = 5 * 60_000;
const RESOLUTION_SECONDS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900 });
export const MIN_RAW_CANDLES = Object.freeze({
  '1m': 21,  // 20 closed candles for Scalping
  '5m': 31,  // 30 closed candles for Momentum and trend context
  '15m': 31  // 30 closed candles for trend confirmation
});

export function candleSeriesIsFresh(candles, resolution, now = Date.now(), maxAgeIntervals = 3) {
  const intervalSeconds = RESOLUTION_SECONDS[resolution];
  if (!intervalSeconds || !Array.isArray(candles) || !candles.length) return false;
  const latest = normalizeEpochSeconds(candles.at(-1)?.time);
  if (latest === null) return false;
  const ageSeconds = Number(now) / 1000 - latest;
  // Candle timestamps are bucket starts: allow a candle in the current bucket
  // and tolerate up to three intervals of age, matching REST normalization.
  return Number.isFinite(ageSeconds) &&
    ageSeconds >= -intervalSeconds &&
    ageSeconds <= intervalSeconds * Math.max(1, Number(maxAgeIntervals) || 3);
}

export function candleNeedsWarmup(candles, resolution, fetchedAt, now = Date.now(), retryAfterMs = CANDLE_WARMUP_RETRY_MS) {
  const requiredRows = MIN_RAW_CANDLES[resolution] || 31;
  const enoughRows = Array.isArray(candles) && candles.length >= requiredRows;
  if (enoughRows && candleSeriesIsFresh(candles, resolution, now)) return false;

  // Avoid tight retries on empty/short/stale responses, but retry after cooldown
  // even when a previous cache has enough rows if its latest candle is stale.
  const lastFetch = Number(fetchedAt) || 0;
  return lastFetch <= 0 || now - lastFetch >= retryAfterMs;
}

/**
 * Select up to batchSize symbols needing candle history, rotating through the
 * turnover-ranked universe. An underfilled/failed response can be retried after
 * retryAfterMs instead of remaining permanently cached as an empty array.
 */
export function planCandleWarmup(
  rankedSymbols,
  candles,
  fetchedAt,
  cursor = 0,
  batchSize = CANDLE_WARMUP_BATCH_SIZE,
  now = Date.now(),
  retryAfterMs = CANDLE_WARMUP_RETRY_MS
) {
  const ranked = Array.isArray(rankedSymbols) ? rankedSymbols : [];
  const total = ranked.length;
  if (!total) return { symbols: [], work: [], nextCursor: 0, scanned: 0 };

  const requested = Number(batchSize);
  const maxSymbols = Math.max(1, Math.min(total, Number.isFinite(requested) ? Math.floor(requested) : CANDLE_WARMUP_BATCH_SIZE));
  const map = candles instanceof Map ? candles : new Map();
  const fetched = fetchedAt instanceof Map ? fetchedAt : new Map();
  const start = ((Math.floor(Number(cursor) || 0) % total) + total) % total;
  const symbols = [];
  const work = [];
  let scanned = 0;

  while (scanned < total && symbols.length < maxSymbols) {
    const symbol = String(ranked[(start + scanned) % total] || '').trim().toUpperCase();
    scanned += 1;
    if (!symbol) continue;

    const missing = CANDLE_RESOLUTIONS.filter(resolution =>
      candleNeedsWarmup(
        map.get(resolution + ':' + symbol),
        resolution,
        fetched.get(resolution + ':' + symbol),
        now,
        retryAfterMs
      )
    );
    if (!missing.length) continue;

    symbols.push(symbol);
    for (const resolution of missing) work.push([symbol, resolution]);
  }

  return {
    symbols,
    work,
    nextCursor: (start + scanned) % total,
    scanned
  };
}


// Dedicated hourly BTC history, deliberately separate from the rotating
// 1m/5m/15m market-universe warmup.
const BTC_HOURLY_CACHE_KEY = '1h:BTCUSD';
const BTC_HOURLY_REFRESH_MS = 60 * 60 * 1000;
const BTC_HOURLY_CANDLE_LIMIT = 250;
const btcHourlyFetchedAt = new WeakMap();

/**
 * Refresh BTCUSD's 1h history independently from the rotating candle batch.
 * The Map key follows the existing resolution:symbol convention.
 */
export async function warmupBTCHourly(adapter, cache) {
  if (!adapter || typeof adapter.candles !== 'function') {
    console.warn('[DeltaScanner] BTC 1h warmup skipped: candle adapter unavailable');
    return { ok: false, skipped: true, reason: 'adapter unavailable' };
  }
  if (!(cache instanceof Map)) {
    console.warn('[DeltaScanner] BTC 1h warmup skipped: candle cache unavailable');
    return { ok: false, skipped: true, reason: 'cache unavailable' };
  }

  const now = Date.now();
  const lastFetched = btcHourlyFetchedAt.get(cache) || 0;
  if (cache.has(BTC_HOURLY_CACHE_KEY) && lastFetched > 0 && now - lastFetched < BTC_HOURLY_REFRESH_MS) {
    return {
      ok: true,
      skipped: true,
      candleCount: Array.isArray(cache.get(BTC_HOURLY_CACHE_KEY)) ? cache.get(BTC_HOURLY_CACHE_KEY).length : 0,
      fetchedAt: new Date(lastFetched).toISOString()
    };
  }

  try {
    const rows = await adapter.candles('BTCUSD', '1h', BTC_HOURLY_CANDLE_LIMIT);
    const normalized = normalizeCandleBatch(rows, '1h', {
      minCandles: MIN_RAW_CANDLES_FOR_ATR
    });
    if (!normalized.ok) {
      throw new Error('1h candle batch rejected: ' + normalized.reason);
    }
    cache.set(BTC_HOURLY_CACHE_KEY, normalized.candles.slice(-BTC_HOURLY_CANDLE_LIMIT));
    const fetchedAt = Date.now();
    btcHourlyFetchedAt.set(cache, fetchedAt);
    console.log('[DeltaScanner] BTC 1h warmup refreshed:', normalized.candles.length, 'validated candles');
    return {
      ok: true, skipped: false, candleCount: normalized.candles.length,
      fetchedAt: new Date(fetchedAt).toISOString()
    };
  } catch (error) {
    // Preserve the last known cache on request failure; the next hourly timer
    // can retry without disturbing the scanner's existing resolutions.
    console.warn('[DeltaScanner] BTC 1h warmup failed:', String(error?.message || error).slice(0, 240));
    return { ok: false, skipped: false, reason: String(error?.message || error).slice(0, 240) };
  }
}
