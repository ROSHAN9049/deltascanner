export const OPTIONS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
export const OPTIONS_CACHE_FUTURE_TOLERANCE_MS = 60 * 1000;

/**
 * Only show option candidates when every row belongs to a recent, timestamped
 * snapshot. One stale/untimestamped row makes the cached batch untrusted.
 */
export function assessOptionsCacheFreshness(rows, {
  now = Date.now,
  maxAgeMs = OPTIONS_CACHE_MAX_AGE_MS,
  futureToleranceMs = OPTIONS_CACHE_FUTURE_TOLERANCE_MS
} = {}) {
  const candidates = Array.isArray(rows)
    ? rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    : [];
  if (!candidates.length) {
    return { fresh: false, status: 'NO_DATA', rowCount: 0, newestAt: null, oldestAt: null, ageMs: null };
  }

  const nowMs = Number(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return { fresh: false, status: 'UNKNOWN_TIME', rowCount: candidates.length, newestAt: null, oldestAt: null, ageMs: null };
  }

  const timestamps = candidates.map(row => {
    const raw = row.cached_at ?? row.captured_at;
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const value = Date.parse(raw);
    return Number.isFinite(value) ? value : null;
  });
  if (timestamps.some(value => value === null)) {
    return { fresh: false, status: 'UNKNOWN_TIMESTAMP', rowCount: candidates.length, newestAt: null, oldestAt: null, ageMs: null };
  }

  const newestMs = Math.max(...timestamps);
  const oldestMs = Math.min(...timestamps);
  const ageMs = nowMs - oldestMs;
  if (timestamps.some(value => value > nowMs + futureToleranceMs)) {
    return {
      fresh: false, status: 'FUTURE_TIMESTAMP', rowCount: candidates.length,
      newestAt: new Date(newestMs).toISOString(), oldestAt: new Date(oldestMs).toISOString(), ageMs
    };
  }
  if (ageMs > maxAgeMs) {
    return {
      fresh: false, status: 'STALE', rowCount: candidates.length,
      newestAt: new Date(newestMs).toISOString(), oldestAt: new Date(oldestMs).toISOString(), ageMs
    };
  }
  return {
    fresh: true, status: 'FRESH', rowCount: candidates.length,
    newestAt: new Date(newestMs).toISOString(), oldestAt: new Date(oldestMs).toISOString(), ageMs
  };
}
