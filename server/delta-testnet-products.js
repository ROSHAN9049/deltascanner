const DELTA_TESTNET_PRODUCTS_URL = 'https://cdn-ind.testnet.deltaex.org/v2/products';
export const DELTA_TESTNET_PRODUCTS_CACHE_TTL_MS = 20_000;
export const DELTA_TESTNET_PRODUCTS_TIMEOUT_MS = 3_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const MAX_ERROR_LENGTH = 240;

function safeError(error) {
  return String(error?.message || error || 'Delta Testnet product catalog unavailable')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_ERROR_LENGTH);
}

function normalizeTradableProduct(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const symbol = String(row.symbol || '').trim().toUpperCase();
  const id = Number(row.id);
  const onlyReduceOnly = row.only_reduce_only_orders_allowed ??
    row.product_specs?.only_reduce_only_orders_allowed;

  if (!/^[A-Z0-9]+USD$/.test(symbol) ||
      !Number.isSafeInteger(id) || id <= 0 ||
      row.contract_type !== 'perpetual_futures' ||
      row.state !== 'live' ||
      row.trading_status !== 'operational' ||
      onlyReduceOnly !== false) {
    return null;
  }

  return Object.freeze({
    id,
    symbol,
    contract_type: 'perpetual_futures',
    state: 'live',
    trading_status: 'operational',
    only_reduce_only_orders_allowed: false
  });
}

/**
 * Fetch the Delta India Testnet product catalog, fail closed on incomplete
 * pagination/errors, and cache the verified catalog briefly. This checks
 * instrument availability only; worker health and account safety are separate
 * dashboard gates.
 */
export function createDeltaTestnetProductsLoader({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = DELTA_TESTNET_PRODUCTS_TIMEOUT_MS,
  cacheTtlMs = DELTA_TESTNET_PRODUCTS_CACHE_TTL_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
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
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('pageSize must be an integer between 1 and 100');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new RangeError('maxPages must be an integer between 1 and 100');
  }

  let cachedResult = null;
  let cachedUntil = 0;
  let inFlight = null;

  async function load({ forceRefresh = false } = {}) {
    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) {
      return {
        success: false,
        environment: 'DELTA_TESTNET',
        complete: false,
        checkedAt: null,
        cached: false,
        error: 'Catalog clock is unavailable'
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
      const productsBySymbol = new Map();
      let after = '';
      let previousAfter = '';
      let complete = false;

      try {
        for (let page = 0; page < maxPages; page++) {
          const url = new URL(DELTA_TESTNET_PRODUCTS_URL);
          url.searchParams.set('contract_types', 'perpetual_futures');
          url.searchParams.set('states', 'live');
          url.searchParams.set('page_size', String(pageSize));
          if (after) url.searchParams.set('after', after);

          const controller = new AbortController();
          const timeout = setTimeoutFn(() => controller.abort(), timeoutMs);
          timeout?.unref?.();
          let response;
          let payload;
          try {
            response = await fetchImpl(url.toString(), {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: controller.signal
            });
            if (!response || response.ok !== true) {
              const status = Number.isInteger(response?.status) ? response.status : null;
              throw new Error(status === null
                ? 'No HTTP response from Delta Testnet products API'
                : 'Delta Testnet products API returned HTTP ' + status);
            }
            payload = await response.json();
          } finally {
            clearTimeoutFn(timeout);
          }

          if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
              payload.success !== true || !Array.isArray(payload.result)) {
            throw new Error('Delta Testnet products API returned an invalid or unsuccessful payload');
          }

          for (const row of payload.result) {
            const product = normalizeTradableProduct(row);
            if (product) productsBySymbol.set(product.symbol, product);
          }

          const nextAfter = String(payload.meta?.after || '').trim();
          if (!nextAfter) {
            complete = true;
            break;
          }
          if (nextAfter === after || nextAfter === previousAfter) {
            throw new Error('Delta Testnet products pagination cursor repeated; catalog is incomplete');
          }
          previousAfter = after;
          after = nextAfter;
        }

        if (!complete) {
          throw new Error('Delta Testnet products catalog exceeded the page limit; catalog is incomplete');
        }

        const result = [...productsBySymbol.values()];
        const checkedAt = new Date(Number(now())).toISOString();
        const verified = {
          success: true,
          environment: 'DELTA_TESTNET',
          complete: true,
          checkedAt,
          cached: false,
          count: result.length,
          result
        };
        cachedResult = verified;
        cachedUntil = Number(now()) + cacheTtlMs;
        return verified;
      } catch (error) {
        return {
          success: false,
          environment: 'DELTA_TESTNET',
          complete: false,
          checkedAt: new Date(Number(now())).toISOString(),
          cached: false,
          count: 0,
          result: [],
          error: safeError(error)
        };
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return load;
}

const defaultLoader = createDeltaTestnetProductsLoader();

export function getDeltaTestnetProducts(options) {
  return defaultLoader(options);
}
