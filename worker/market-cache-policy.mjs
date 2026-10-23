// Dashboard-only persistence cadence for the complete Delta market universe.
// Live scanner calculations use in-memory tickers/candles and are not throttled here.
export const MARKET_CACHE_WRITE_INTERVAL_MS = 120_000;

export function shouldWriteMarketCache(lastWriteAt, now = Date.now(), intervalMs = MARKET_CACHE_WRITE_INTERVAL_MS) {
  const last = Number(lastWriteAt);
  const current = Number(now);
  const interval = Number(intervalMs);

  if (!Number.isFinite(current) || current < 0) return false;
  if (!Number.isFinite(last) || last <= 0) return true;
  if (!Number.isFinite(interval) || interval < 0) return false;

  return current - last >= interval;
}
