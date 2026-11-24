export const DELTA_TESTNET_HEALTH_URL = 'https://cdn-ind.testnet.deltaex.org/v2/products';
export const DELTA_TESTNET_HEALTH_CACHE_TTL_MS = 20_000;
export const DELTA_TESTNET_HEALTH_TIMEOUT_MS = 8_000;
export const DELTA_TESTNET_HEALTH_MAX_ATTEMPTS = 3;

function safeError(error) {
  return String(error?.message || error || 'Delta Testnet health probe failed').slice(0, 240);
}
function isRetryableStatus(status) {
  return status === null || status === 408 || status === 429 || status >= 500;
}

/**
 * Public Testnet products reachability check. This is deliberately distinct
 * from the worker's authenticated wallet/positions preflight.
 */
export function createDeltaTestnetHealthProbe({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = DELTA_TESTNET_HEALTH_TIMEOUT_MS,
  cacheTtlMs = DELTA_TESTNET_HEALTH_CACHE_TTL_MS,
  maxAttempts = DELTA_TESTNET_HEALTH_MAX_ATTEMPTS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) throw new RangeError('cacheTtlMs must be a non-negative integer');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError('maxAttempts must be an integer between 1 and 5');

  let cachedResult = null;
  let cachedUntil = 0;
  let inFlight = null;

  async function probe({ forceRefresh = false } = {}) {
    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) {
      return { healthy: false, status: null, checkedAt: null, source: 'delta-testnet-public-api', url: DELTA_TESTNET_HEALTH_URL, cached: false, error: 'Health clock is unavailable' };
    }
    if (!forceRefresh && cachedResult && currentTime < cachedUntil) return { ...cachedResult, cached: true };
    if (inFlight) {
      const result = await inFlight;
      return { ...result, cached: false, coalesced: true };
    }

    inFlight = (async () => {
      const checkedAt = new Date(currentTime).toISOString();
      let result = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeoutFn(() => controller.abort(), timeoutMs);
        timeout?.unref?.();
        try {
          const response = await fetchImpl(DELTA_TESTNET_HEALTH_URL, {
            method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal
          });
          const status = Number.isInteger(response?.status) ? response.status : null;
          if (!response || response.ok !== true) {
            result = {
              healthy: false, status, checkedAt, source: 'delta-testnet-public-api',
              url: DELTA_TESTNET_HEALTH_URL, cached: false,
              error: status === null ? 'No HTTP response from Delta Testnet' : 'Delta Testnet returned HTTP ' + status
            };
            if (attempt < maxAttempts && isRetryableStatus(status)) continue;
            break;
          }
          const payload = await response.json();
          const validPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
          const healthy = validPayload && payload.success === true && Array.isArray(payload.result);
          result = {
            healthy, status, checkedAt, source: 'delta-testnet-public-api',
            url: DELTA_TESTNET_HEALTH_URL, cached: false,
            error: healthy ? null : validPayload && payload.success === false
              ? 'Delta Testnet API reported success=false'
              : 'Delta Testnet returned an invalid health response'
          };
          break;
        } catch (error) {
          result = {
            healthy: false, status: null, checkedAt, source: 'delta-testnet-public-api',
            url: DELTA_TESTNET_HEALTH_URL, cached: false, error: safeError(error)
          };
          // A controller-triggered timeout is already the bounded terminal
          // probe budget; retrying it with an injected/expired timer can leave
          // callers waiting forever. Retry transport errors, not our own abort.
          if (attempt < maxAttempts && !controller.signal.aborted) continue;
        } finally {
          clearTimeoutFn(timeout);
        }
      }
      cachedResult = result || {
        healthy: false, status: null, checkedAt, source: 'delta-testnet-public-api',
        url: DELTA_TESTNET_HEALTH_URL, cached: false,
        error: 'Delta Testnet health probe did not produce a response'
      };
      cachedUntil = Number(now()) + cacheTtlMs;
      return cachedResult;
    })();

    try { return await inFlight; }
    finally { inFlight = null; }
  }
  return probe;
}

const defaultProbe = createDeltaTestnetHealthProbe();
export function getDeltaTestnetHealth(options) {
  return defaultProbe(options);
}
