export const DELTA_TESTNET_HEALTH_URL = 'https://cdn-ind.testnet.deltaex.org/v2/products';
export const DELTA_TESTNET_HEALTH_CACHE_TTL_MS = 20_000;
export const DELTA_TESTNET_HEALTH_TIMEOUT_MS = 3_000;

function safeError(error) {
  return String(error?.message || error || 'Delta Testnet health probe failed').slice(0, 240);
}

/**
 * Create a cached, injectable probe of Delta India TESTNET's public products
 * endpoint. Both healthy and unhealthy outcomes are cached briefly to avoid
 * adding request load during dashboard polling. Unknown/exceptional outcomes
 * are always reported as unhealthy.
 */
export function createDeltaTestnetHealthProbe({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = DELTA_TESTNET_HEALTH_TIMEOUT_MS,
  cacheTtlMs = DELTA_TESTNET_HEALTH_CACHE_TTL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new RangeError('cacheTtlMs must be a non-negative integer');
  }

  let cachedResult = null;
  let cachedUntil = 0;
  let inFlight = null;

  async function probe({ forceRefresh = false } = {}) {
    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) {
      return {
        healthy: false,
        status: null,
        checkedAt: null,
        source: 'delta-testnet-public-api',
        url: DELTA_TESTNET_HEALTH_URL,
        cached: false,
        error: 'Health clock is unavailable'
      };
    }

    if (!forceRefresh && cachedResult && currentTime < cachedUntil) {
      return { ...cachedResult, cached: true };
    }
    if (inFlight) {
      const result = await inFlight;
      return { ...result, cached: false, coalesced: true };
    }

    inFlight = (async () => {
      const checkedAt = new Date(currentTime).toISOString();
      const controller = new AbortController();
      const timeout = setTimeoutFn(() => controller.abort(), timeoutMs);
      timeout?.unref?.();
      let result;
      try {
        const response = await fetchImpl(DELTA_TESTNET_HEALTH_URL, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        const status = Number.isInteger(response?.status) ? response.status : null;
        if (!response || response.ok !== true) {
          result = {
            healthy: false,
            status,
            checkedAt,
            source: 'delta-testnet-public-api',
            url: DELTA_TESTNET_HEALTH_URL,
            cached: false,
            error: status === null ? 'No HTTP response from Delta Testnet' : 'Delta Testnet returned HTTP ' + status
          };
        } else {
          const payload = await response.json();
          const validPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
          const apiExplicitlyFailed = validPayload && payload.success === false;
          // Match the response contract used by DeltaAdapter: successful API
          // replies must include a result array. HTTP 200 alone is not health.
          const validProductsResponse = validPayload &&
            payload.success === true &&
            Array.isArray(payload.result);
          const healthy = validProductsResponse;
          result = {
            healthy,
            status,
            checkedAt,
            source: 'delta-testnet-public-api',
            url: DELTA_TESTNET_HEALTH_URL,
            cached: false,
            error: healthy ? null : apiExplicitlyFailed
              ? 'Delta Testnet API reported success=false'
              : 'Delta Testnet returned an invalid health response'
          };
        }
      } catch (error) {
        result = {
          healthy: false,
          status: null,
          checkedAt,
          source: 'delta-testnet-public-api',
          url: DELTA_TESTNET_HEALTH_URL,
          cached: false,
          error: safeError(error)
        };
      } finally {
        clearTimeoutFn(timeout);
      }

      cachedResult = result;
      cachedUntil = Number(now()) + cacheTtlMs;
      return result;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return probe;
}

const defaultProbe = createDeltaTestnetHealthProbe();

export function getDeltaTestnetHealth(options) {
  return defaultProbe(options);
}
