export const IV_HISTORY_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
export const IV_RETRY_BASE_DELAY_MS = 60 * 1000;
export const IV_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_STATES = 128;

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

export function selectDueIvHistoryObservations(observations, lastPersistedAtByKey, now = Date.now(), intervalMs = IV_HISTORY_PERSIST_INTERVAL_MS) {
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

export function markIvHistoryObservationsPersisted(observations, lastPersistedAtByKey, persistedAt = Date.now()) {
  if (!(lastPersistedAtByKey instanceof Map)) throw new TypeError('lastPersistedAtByKey must be a Map');
  const timestamp = Number(persistedAt);
  if (!Number.isFinite(timestamp)) throw new TypeError('persistedAt must be a finite timestamp');
  for (const row of Array.isArray(observations) ? observations : []) {
    const key = observationKey(row);
    if (key) lastPersistedAtByKey.set(key, timestamp);
  }
  while (lastPersistedAtByKey.size > 2_000) {
    lastPersistedAtByKey.delete(lastPersistedAtByKey.keys().next().value);
  }
  return lastPersistedAtByKey.size;
}

function normalizeRetryKey(key) {
  return String(key || '').trim().toUpperCase();
}

export function isIvRetryReady(retryStateByKey, key, now = Date.now()) {
  if (!(retryStateByKey instanceof Map)) throw new TypeError('retryStateByKey must be a Map');
  const normalizedKey = normalizeRetryKey(key);
  const timestamp = Number(now);
  if (!normalizedKey || !Number.isFinite(timestamp)) return false;
  const previous = retryStateByKey.get(normalizedKey);
  if (!previous) return true;
  return Number.isFinite(Number(previous.retryAt)) && timestamp >= Number(previous.retryAt);
}

export function recordIvRetryFailure(retryStateByKey, key, now = Date.now()) {
  if (!(retryStateByKey instanceof Map)) throw new TypeError('retryStateByKey must be a Map');
  const normalizedKey = normalizeRetryKey(key);
  const timestamp = Number(now);
  if (!normalizedKey || !Number.isFinite(timestamp)) throw new TypeError('A retry key and finite timestamp are required');
  const previous = retryStateByKey.get(normalizedKey);
  const failures = Math.max(0, Math.floor(Number(previous?.failures) || 0)) + 1;
  const exponent = Math.min(failures - 1, 16);
  const retryDelayMs = Math.min(IV_RETRY_BASE_DELAY_MS * (2 ** exponent), IV_RETRY_MAX_DELAY_MS);
  const state = { failures, failedAt: timestamp, retryDelayMs, retryAt: timestamp + retryDelayMs };
  retryStateByKey.delete(normalizedKey);
  retryStateByKey.set(normalizedKey, state);
  while (retryStateByKey.size > MAX_RETRY_STATES) {
    retryStateByKey.delete(retryStateByKey.keys().next().value);
  }
  return state;
}

export function clearIvRetryFailure(retryStateByKey, key) {
  if (!(retryStateByKey instanceof Map)) throw new TypeError('retryStateByKey must be a Map');
  const normalizedKey = normalizeRetryKey(key);
  if (!normalizedKey) return false;
  return retryStateByKey.delete(normalizedKey);
}
