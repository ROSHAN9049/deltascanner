// Closed-candle analysis drops the last (possibly still-open) candle.
// Fetch at least one extra row beyond the strategy's minimum closed-candle count.
export const CANDLE_RESOLUTIONS = Object.freeze(['1m', '5m', '15m']);
export const CANDLE_WARMUP_BATCH_SIZE = 24;
export const CANDLE_WARMUP_RETRY_MS = 60_000;
export const MIN_RAW_CANDLES = Object.freeze({
  '1m': 21,  // 20 closed candles for Scalping
  '5m': 31,  // 30 closed candles for Momentum and trend context
  '15m': 31  // 30 closed candles for trend confirmation
});

export function candleNeedsWarmup(candles, resolution, fetchedAt, now = Date.now(), retryAfterMs = CANDLE_WARMUP_RETRY_MS) {
  const requiredRows = MIN_RAW_CANDLES[resolution] || 31;
  if (Array.isArray(candles) && candles.length >= requiredRows) return false;

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
