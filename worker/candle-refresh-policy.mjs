export function shouldRefreshGridCandle(nowMs, lastSuccessAt, retryAfterAt = 0, minIntervalMs = 15_000) {
  const now = Number(nowMs);
  const lastSuccess = Number(lastSuccessAt);
  const retryAt = Number(retryAfterAt);
  const minimumInterval = Number(minIntervalMs);
  return Number.isFinite(now) && Number.isFinite(lastSuccess) &&
    Number.isFinite(retryAt) && Number.isFinite(minimumInterval) &&
    minimumInterval >= 0 && now - lastSuccess >= minimumInterval && now >= retryAt;
}

export function resolveCandleRetryAfterMs(error, fallbackMs) {
  const requested = Number(error?.retryAfterMs);
  const fallback = Number(fallbackMs);
  if (Number.isFinite(requested) && requested > 0) return requested;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 60_000;
}
