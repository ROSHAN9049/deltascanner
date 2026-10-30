import crypto from 'node:crypto';
import { DELTA_TESTNET_REST_BASE } from './delta-executor.mjs';
import { OPTIONS_EXECUTION_ALLOWED, OPTIONS_EXECUTION_LOCK_REASON } from '../options-execution-lock.mjs';
import { parseDeltaOptionSymbol } from './delta-options-policy.mjs';

const OPTION_TYPES = 'call_options,put_options';
const PAGE_SIZE = 50;
const PRODUCT_CACHE_TTL_MS = 60 * 1000;
const ACTIVE_STATES = new Set(['open', 'pending']);

const value = input => String(input ?? '').trim();
const numberOrNull = input => {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
};

export function assertDeltaOptionsTestnetConfiguration(env = process.env) {
  if (value(env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet') {
    throw new Error('Delta Options executor is locked: DELTA_EXECUTION_MODE must be testnet');
  }
  const base = value(env.DELTA_TESTNET_REST_BASE || DELTA_TESTNET_REST_BASE).replace(/\/+$/, '');
  if (base !== DELTA_TESTNET_REST_BASE) {
    throw new Error('Delta Options executor requires the hardcoded Delta India Testnet REST endpoint');
  }
  const apiKey = value(env.DELTA_TESTNET_OPTIONS_API_KEY);
  const apiSecret = value(env.DELTA_TESTNET_OPTIONS_API_SECRET);
  if (!apiKey || !apiSecret) {
    throw new Error('Dedicated Delta Testnet Options API credentials are missing');
  }
  return { apiKey, apiSecret, base };
}

export function createDeltaOptionsExecutor({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now()
} = {}) {
  let productsCache = [];
  let productsCachedAt = 0;

  function requestSignature(method, timestamp, path, query, payload, secret) {
    return crypto.createHmac('sha256', secret)
      .update(method + timestamp + path + query + payload, 'utf8')
      .digest('hex');
  }

  async function request(method, path, params = {}, body = null) {
    const credentials = assertDeltaOptionsTestnetConfiguration(env);
    const query = encodeQuery(params);
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = requestSignature(method, timestamp, path, query, payload, credentials.apiSecret);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'DealDost-Delta-Testnet-Options/1.0',
      'api-key': credentials.apiKey,
      signature,
      timestamp
    };
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(credentials.base + path + query, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : payload
    });
    const rawText = await response.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch {}
    if (!response.ok || data?.success === false) {
      const code = value(data?.error?.code || data?.error?.name);
      const error = new Error('Delta Testnet Options ' + method + ' ' + path +
        ' failed (' + response.status + '): ' + (code || 'request_failed'));
      error.status = response.status;
      error.code = code || 'delta_options_request_failed';
      throw error;
    }
    return data || { success: true, result: null };
  }

  async function getOptionProducts({ forceRefresh = false } = {}) {
    assertDeltaOptionsTestnetConfiguration(env);
    if (!forceRefresh && productsCache.length && now() - productsCachedAt < PRODUCT_CACHE_TTL_MS) {
      return productsCache.map(row => ({ ...row }));
    }

    const products = [];
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 20; page += 1) {
      const response = await request('GET', '/v2/products', {
        contract_types: OPTION_TYPES,
        states: 'live',
        page_size: PAGE_SIZE,
        after
      });
      if (!Array.isArray(response?.result)) {
        throw new Error('Delta Testnet Options product catalogue is malformed; no product IDs are trusted');
      }
      const rows = response.result;
      for (const row of rows) {
        const symbol = value(row?.symbol || row?.product_symbol).toUpperCase();
        const type = value(row?.contract_type).toLowerCase();
        const id = Number(row?.id ?? row?.product_id);
        const parsed = parseDeltaOptionSymbol(symbol, undefined, now());
        if (!parsed || !['BTC', 'ETH'].includes(parsed.underlying) ||
            !Number.isSafeInteger(id) || id <= 0 ||
            !['call_options', 'put_options'].includes(type) ||
            (parsed.optionType === 'CALL' ? type !== 'call_options' : type !== 'put_options') ||
            value(row?.state).toLowerCase() !== 'live' ||
            !(numberOrNull(row?.contract_value) > 0) ||
            !(numberOrNull(row?.tick_size) > 0)) continue;
        products.push({
          ...row,
          id,
          product_id: id,
          symbol,
          contract_type: type,
          underlying: parsed.underlying,
          testnet_product_verified: true
        });
      }

      const nextAfter = value(response?.meta?.after);
      if (!nextAfter || nextAfter === after || nextAfter === previousAfter || rows.length === 0) break;
      previousAfter = after;
      after = nextAfter;
    }

    productsCache = products;
    productsCachedAt = now();
    return products.map(row => ({ ...row }));
  }

  async function resolveOptionProduct(symbol, { forceRefresh = false } = {}) {
    const normalized = value(symbol).toUpperCase();
    if (!normalized) throw new Error('Options product lookup requires an exact contract symbol');
    const matches = (await getOptionProducts({ forceRefresh })).filter(row => row.symbol === normalized);
    if (matches.length !== 1) {
      throw new Error('Exact Delta Testnet Options product is missing or ambiguous: ' + normalized);
    }
    return { ...matches[0] };
  }

  async function getOpenOptionPositions() {
    const response = await request('GET', '/v2/positions/margined', {
      contract_types: OPTION_TYPES
    });
    if (!Array.isArray(response?.result)) {
      throw new Error('Delta Testnet Options position snapshot is malformed; reconciliation must not infer flat');
    }
    return response.result.map(row => {
      const symbol = value(row?.product_symbol || row?.symbol).toUpperCase();
      const size = numberOrNull(row?.size ?? row?.signed_size ?? row?.qty ?? row?.quantity);
      const parsed = parseDeltaOptionSymbol(symbol, undefined, now());
      const productId = Number(row?.product_id ?? row?.productId);
      if (!parsed || !['BTC', 'ETH'].includes(parsed.underlying) ||
          size === null || !Number.isSafeInteger(productId) || productId <= 0) {
        throw new Error('Delta Testnet Options position row is malformed; reconciliation aborted');
      }
      return {
        symbol,
        underlying: parsed.underlying,
        optionType: parsed.optionType,
        strike: parsed.strike,
        expiryMs: parsed.expiryMs,
        qty: Math.abs(size),
        side: size < 0 ? 'SELL' : 'BUY',
        product_id: productId,
        entry_price: numberOrNull(row?.entry_price),
        current_price: numberOrNull(row?.mark_price ?? row?.current_price),
        unrealized_pnl: numberOrNull(row?.unrealized_pnl),
        raw: row
      };
    }).filter(row => row.qty > 0);
  }

  async function getOpenOptionOrders() {
    const all = [];
    for (const state of ACTIVE_STATES) {
      let after = '';
      let previousAfter = '';
      for (let page = 0; page < 20; page += 1) {
        const response = await request('GET', '/v2/orders', {
          contract_types: OPTION_TYPES,
          state,
          page_size: PAGE_SIZE,
          after
        });
        if (!Array.isArray(response?.result)) {
          throw new Error('Delta Testnet Options orders snapshot is malformed');
        }
        all.push(...response.result);
        const nextAfter = value(response?.meta?.after);
        if (!nextAfter || nextAfter === after || nextAfter === previousAfter || !response.result.length) break;
        previousAfter = after;
        after = nextAfter;
      }
    }
    const unique = new Map();
    for (const row of all) {
      const symbol = value(row?.product_symbol || row?.symbol).toUpperCase();
      if (!parseDeltaOptionSymbol(symbol, undefined, now())) {
        throw new Error('Delta Testnet Options open order response contained a non-option row');
      }
      unique.set(value(row?.id || row?.client_order_id || JSON.stringify(row)), row);
    }
    return [...unique.values()];
  }

  async function getOptionOrderByClientId(clientOrderId) {
    const id = value(clientOrderId);
    if (!id || id.length > 32) throw new Error('Options order lookup requires a valid client_order_id');
    const response = await request('GET', '/v2/orders/client_order_id/' + encodeURIComponent(id));
    const order = response?.result ?? response;
    if (!order || typeof order !== 'object' || Array.isArray(order) ||
        value(order.client_order_id) !== id) {
      throw new Error('Delta Testnet Options order acknowledgement lookup did not match its client_order_id');
    }
    return order;
  }

  async function getOptionWalletSnapshot() {
    // Return the raw exchange wallet; do not infer the Options settlement
    // currency or margin field until its India Testnet payload is verified.
    const response = await request('GET', '/v2/wallet/balances');
    return response?.result ?? response;
  }

  async function getOptionFillsPage({ startTime, endTime, after = null, pageSize = PAGE_SIZE } = {}) {
    const start = numberOrNull(startTime);
    const end = numberOrNull(endTime);
    const size = numberOrNull(pageSize);
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end <= start ||
        !Number.isSafeInteger(size) || size < 1) {
      throw new Error('Options fills sync requires a valid microsecond time window and positive page size');
    }
    const response = await request('GET', '/v2/fills', {
      contract_types: OPTION_TYPES,
      start_time: start,
      end_time: end,
      page_size: Math.min(PAGE_SIZE, size),
      after: value(after) || undefined
    });
    if (!Array.isArray(response?.result)) throw new Error('Delta Testnet Options fills response is malformed');
    return {
      rows: response.result,
      after: value(response?.meta?.after) || null,
      before: value(response?.meta?.before) || null
    };
  }

  async function placeOptionOrder({
    symbol,
    side,
    qty,
    limitPrice,
    clientOrderId,
    reduceOnly = false
  } = {}) {
    // This check is intentionally first: even valid Testnet credentials, order
    // data, or a caller-provided plan cannot bypass the source-code hard lock.
    if (OPTIONS_EXECUTION_ALLOWED !== true) {
      throw new Error(OPTIONS_EXECUTION_LOCK_REASON);
    }

    const direction = value(side).toUpperCase();
    const quantity = numberOrNull(qty);
    const price = numberOrNull(limitPrice);
    const clientId = value(clientOrderId);
    if (!['BUY', 'SELL'].includes(direction) ||
        !Number.isSafeInteger(quantity) || quantity <= 0 ||
        !(price > 0) || !clientId || clientId.length > 32 ||
        typeof reduceOnly !== 'boolean') {
      throw new Error('Options order requires BUY/SELL, whole quantity, positive limit, client ID and reduceOnly');
    }

    const product = await resolveOptionProduct(symbol, { forceRefresh: true });
    const tickSize = numberOrNull(product.tick_size);
    const tickRatio = price / tickSize;
    if (!Number.isFinite(tickRatio) || Math.abs(tickRatio - Math.round(tickRatio)) > 1e-8) {
      throw new Error('Options order limit price is not aligned to the live Testnet product tick size');
    }

    const body = {
      product_id: product.id,
      size: quantity,
      side: direction.toLowerCase(),
      order_type: 'limit_order',
      limit_price: String(price),
      time_in_force: 'ioc',
      client_order_id: clientId,
      ...(reduceOnly ? { reduce_only: true } : {})
    };
    const response = await request('POST', '/v2/orders', {}, body);
    const order = response?.result ?? response;
    if (!order || typeof order !== 'object' || Array.isArray(order) ||
        (!order.id && !order.client_order_id && !order.state)) {
      throw new Error('Delta Testnet Options did not return a valid order acknowledgement');
    }
    return { ...order, symbol: product.symbol, product_id: product.id };
  }

  return Object.freeze({
    getOptionProducts,
    resolveOptionProduct,
    getOpenOptionPositions,
    getOpenOptionOrders,
    getOptionOrderByClientId,
    getOptionWalletSnapshot,
    getOptionFillsPage,
    placeOptionOrder,
    assertConfigured: () => assertDeltaOptionsTestnetConfiguration(env)
  });
}
