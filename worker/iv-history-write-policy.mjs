export const IV_HISTORY_PERSIST_INTERVAL_MS = 5 * 60 * 1000;

function observationKey(row) {
  const symbol = String(row?.ticker?.symbol || '').trim().toUpperCase();
  const group = row?.group || {};
  const underlying = String(group.underlying || '').trim().toUpperCase();
  const optionType = String(group.option_type || '').trim().toUpperCase();
  const deltaBucket = String(group.delta_bucket || '').trim();
  const dteBucket = String(group.dte_bucket || '').trim();
  if (!symbol || !underlying || !['CALL', 'PUT'].includes(optionType) || !deltaBucket || !dteBucket) return null;
  return [symbol, underlying, optionType, deltaBucket, dteBucket].join('|');
}

/**
 * IV observations only need a five-minute cadence. Current IV remains live in
 * the option ticker and is incorporated into rank calculation on every scan;
 * persisted history is for the rolling window and completed-day percentile.
 */
export function selectDueIvHistoryObservations(
  observations,
  lastPersistedAtByKey,
  now = Date.now(),
  intervalMs = IV_HISTORY_PERSIST_INTERVAL_MS
) {
  if (!(lastPersistedAtByKey instanceof Map)) throw new TypeError('lastPersistedAtByKey must be a Map');
  const timestamp = Number(now);
  const interval = Number(intervalMs);
  if (!Number.isFinite(timestamp) || !Number.isFinite(interval) || interval < 1) return [];

  const selected = [];
  const included = new Set();
  for (const row of Array.isArray(observations) ? observations : []) {
    const key = observationKey(row);
    if (!key || included.has(key)) continue;
    const previous = Number(lastPersistedAtByKey.get(key));
    if (Number.isFinite(previous) && (timestamp < previous || timestamp - previous < interval)) continue;
    selected.push(row);
    included.add(key);
  }
  return selected;
}

export function markIvHistoryObservationsPersisted(
  observations,
  lastPersistedAtByKey,
  persistedAt = Date.now()
) {
  if (!(lastPersistedAtByKey instanceof Map)) throw new TypeError('lastPersistedAtByKey must be a Map');
  const timestamp = Number(persistedAt);
  if (!Number.isFinite(timestamp)) throw new TypeError('persistedAt must be a finite timestamp');
  for (const row of Array.isArray(observations) ? observations : []) {
    const key = observationKey(row);
    if (key) lastPersistedAtByKey.set(key, timestamp);
  }
  // The option universe is bounded, but keep the worker-local guard bounded too.
  while (lastPersistedAtByKey.size > 2_000) {
    const oldestKey = lastPersistedAtByKey.keys().next().value;
    lastPersistedAtByKey.delete(oldestKey);
  }
  return lastPersistedAtByKey.size;
}
