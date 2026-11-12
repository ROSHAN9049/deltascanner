import { resolveMinimumStopDistancePct } from '../../shared/delta-risk-policy.js';
import crypto from 'node:crypto';
import * as defaultDb from '../../server/db.js';
import { indiaDateKey } from '../../src/date-utils.js';
import { isAllowedDeltaTestnetFutureSymbol, isEligibleDeltaTestnetPerpetualProduct, isMarketTickFresh } from './execution-route-policy.mjs';
import { createDeltaOptionsExecution } from './delta-options-execution.mjs';

export const DELTA_TESTNET_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
export const DELTA_TESTNET_PRIVATE_WS_URL = 'wss://socket-ind.testnet.deltaex.org';
export const MAX_DELTA_TESTNET_OPEN_POSITIONS = 20;
export const DELTA_TESTNET_DAILY_LOSS_LIMIT = 0.05;
export const DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const stringOrEmpty = value => String(value ?? '').trim();
const encodeQuery = params => {
  const pairs = [];
  for (const key of Object.keys(params || {}).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return pairs.length ? '?' + pairs.join('&') : '';
};

export function deltaHmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export function buildCloseClientOrderId(positionId, closeReason) {
  const stablePositionId = stringOrEmpty(positionId);
  const stableReason = stringOrEmpty(closeReason).toUpperCase();
  if (!stablePositionId || !stableReason) {
    throw new Error('Stable position id and close reason are required for an idempotent exit');
  }
  const digest = crypto.createHash('sha256')
    .update(stablePositionId + '\\u0000' + stableReason, 'utf8')
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  // Delta client_order_id is limited to 32 characters.
  return 'DDX-C-' + digest;
}

export function assertDeltaTestnetConfiguration(env = process.env) {
  const mode = stringOrEmpty(env.DELTA_EXECUTION_MODE || 'disabled').toLowerCase();
  if (mode !== 'testnet') {
    throw new Error('Delta executor is locked: DELTA_EXECUTION_MODE must be testnet');
  }
  const restBase = stringOrEmpty(env.DELTA_TESTNET_REST_BASE || DELTA_TESTNET_REST_BASE).replace(/\/+$/, '');
  if (restBase !== DELTA_TESTNET_REST_BASE) {
    throw new Error('Delta Testnet REST base does not match the hardcoded Testnet endpoint');
  }
  const wsUrl = stringOrEmpty(env.DELTA_TESTNET_WS_URL || DELTA_TESTNET_PRIVATE_WS_URL);
  if (wsUrl !== DELTA_TESTNET_PRIVATE_WS_URL) {
    throw new Error('Delta Testnet private WebSocket URL does not match the hardcoded Testnet endpoint');
  }
  const apiKey = stringOrEmpty(env.DELTA_TESTNET_API_KEY);
  const apiSecret = stringOrEmpty(env.DELTA_TESTNET_API_SECRET);
  if (!apiKey || !apiSecret) throw new Error('Delta Demo/Testnet API credentials are missing');
  return { apiKey, apiSecret };
}

function normalizePosition(row) {
  const signedSize = numberOrNull(row?.size ?? row?.signed_size ?? row?.qty ?? row?.quantity);
  const symbol = stringOrEmpty(row?.product_symbol || row?.symbol).toUpperCase();
  if (!symbol || signedSize === null) return null;
  return {
    symbol,
    signedSize,
    qty: Math.abs(signedSize),
    side: signedSize < 0 ? 'SELL' : 'BUY',
    entry_price: numberOrNull(row?.entry_price ?? row?.entryPrice),
    mark_price: numberOrNull(row?.mark_price),
    current_price: numberOrNull(row?.mark_price ?? row?.current_price ?? row?.last_traded_price),
    index_price: numberOrNull(row?.index_price),
    unrealized_cashflow: numberOrNull(row?.unrealized_cashflow),
    unrealized_pnl: numberOrNull(row?.unrealized_pnl ?? row?.unrealizedPnl),
    realized_pnl: numberOrNull(row?.realized_pnl ?? row?.realizedPnl),
    product_id: numberOrNull(row?.product_id ?? row?.productId),
    order_id: row?.order_id ?? null,
    client_order_id: row?.client_order_id ?? null,
    sl_price: numberOrNull(row?.bracket_stop_loss_price ?? row?.sl_price),
    tp_price: numberOrNull(row?.bracket_take_profit_price ?? row?.tp_price),
    opened_at: row?.created_at || row?.opened_at || null,
    raw: row
  };
}

function accountEquity(wallet) {
  const candidates = [
    wallet?.meta?.net_equity,
    wallet?.meta?.equity,
    wallet?.meta?.total_equity,
    wallet?.result?.net_equity,
    wallet?.result?.equity,
    wallet?.result?.total_equity
  ].map(numberOrNull).filter(value => value !== null && value > 0);
  if (candidates.length) return candidates[0];
  const result = Array.isArray(wallet?.result)
    ? wallet.result
    : Array.isArray(wallet?.result?.balances) ? wallet.result.balances : [];
  const settlementAssets = new Set(['USD', 'USDT', 'USDC', 'INR']);
  const balances = result.filter(row => settlementAssets.has(stringOrEmpty(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase()));
  if (!balances.length) return null;
  const total = balances.reduce((sum, row) => {
    const balance = numberOrNull(row?.balance ?? row?.total_balance ?? row?.wallet_balance);
    const unrealized = numberOrNull(row?.unrealized_pnl) ?? 0;
    return sum + (balance ?? 0) + unrealized;
  }, 0);
  return total > 0 ? total : null;
}

function accountAvailable(wallet, equity) {
  const candidates = [
    wallet?.meta?.available_balance,
    wallet?.meta?.available_margin,
    wallet?.result?.available_balance
  ].map(numberOrNull).filter(value => value !== null && value >= 0);
  if (candidates.length) return candidates[0];
  const result = Array.isArray(wallet?.result)
    ? wallet.result
    : Array.isArray(wallet?.result?.balances) ? wallet.result.balances : [];
  const settlementAssets = new Set(['USD', 'USDT', 'USDC', 'INR']);
  const balances = result.filter(row => settlementAssets.has(stringOrEmpty(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase()));
  if (balances.length) {
    const total = balances.reduce((sum, row) => sum + (numberOrNull(row?.available_balance) ?? 0), 0);
    if (total >= 0) return total;
  }
  return equity;
}

function terminalState(state) {
  return new Set(['filled', 'closed', 'cancelled', 'canceled', 'rejected', 'expired', 'failed', 'exited'])
    .has(stringOrEmpty(state).toLowerCase());
}

function strategyValue(value) {
  const strategy = stringOrEmpty(value).toUpperCase();
  return ['MOMENTUM', 'SCALPING', 'GRID'].includes(strategy) ? strategy : 'MOMENTUM';
}

export function createDeltaExecutor({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  database = defaultDb,
  now = () => Date.now()
} = {}) {
  const symbolLocks = new Set();
  const historicalEntryLookupLogged = new Set();
  let productsCache = [];
  let productsCachedAt = 0;

  function assertConfigured() {
    return assertDeltaTestnetConfiguration(env);
  }

  async function logExecutor(level, message, details = {}) {
    const serialized = JSON.stringify(details);
    const line = serialized ? message + ' ' + serialized : message;

    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.info(line);

    try {
      if (typeof database.log === 'function') {
        await database.log(level, message, details);
      }
    } catch (error) {
      console.warn(
        '[Executor] Could not persist executor log:',
        String(error?.message || error)
      );
    }
  }

  async function logHistoricalEntryFillUnresolvedOnce({
    symbol,
    entryOrderId = null,
    entryClientOrderId = null,
    openedMs = null,
    orderNotFound = false
  } = {}) {
    const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
    const identity = stringOrEmpty(entryOrderId) ||
      stringOrEmpty(entryClientOrderId) ||
      (openedMs === null ? 'unknown' : String(openedMs));
    const key = normalizedSymbol + ':' + identity;
    if (historicalEntryLookupLogged.has(key)) return;

    // Keep this diagnostic-only cache bounded for long-running workers.
    if (historicalEntryLookupLogged.size >= 1024) {
      const oldestKey = historicalEntryLookupLogged.values().next().value;
      if (oldestKey !== undefined) historicalEntryLookupLogged.delete(oldestKey);
    }
    historicalEntryLookupLogged.add(key);

    const lookupAgeMs = openedMs === null ? null : Math.max(0, now() - openedMs);
    await logExecutor(
      'INFO',
      orderNotFound
        ? '[Executor] Historical entry order not found; fill identity remains UNRESOLVED'
        : '[Executor] Historical entry fill identity remains UNRESOLVED; client-order lookup skipped after 3 days',
      {
        symbol: normalizedSymbol,
        entryOrderId: stringOrEmpty(entryOrderId) || null,
        hasClientOrderId: Boolean(stringOrEmpty(entryClientOrderId)),
        fillResolution: 'UNRESOLVED',
        clientOrderLookupSkipped: !orderNotFound,
        reason: orderNotFound ? 'order_not_found' : 'older_than_3_days',
        ...(lookupAgeMs === null ? {} : { lookupAgeMs })
      }
    );
  }

  async function request(method, path, params = {}, body = null) {
    const credentials = assertConfigured();
    const query = encodeQuery(params);
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = deltaHmacSha256(credentials.apiSecret, method + timestamp + path + query + payload);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'DealDost-Delta-Testnet/1.0',
      'api-key': credentials.apiKey,
      signature,
      timestamp
    };
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(DELTA_TESTNET_REST_BASE + path + query, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : payload
    });
    const rawText = await response.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch {}
    if (!response.ok || data?.success === false) {
      const code = stringOrEmpty(data?.error?.code || data?.error?.name);
      const reason = stringOrEmpty(data?.error?.message || data?.error?.code || data?.message);
      const error = new Error('Delta Testnet ' + method + ' ' + path + ' failed (' +
        response.status + '): ' + (code || reason || 'request_failed'));
      error.status = response.status;
      error.code = code || 'delta_testnet_request_failed';
      throw error;
    }
    return data || { success: true, result: null };
  }

  async function withSymbolLock(symbol, operation) {
    const key = stringOrEmpty(symbol).toUpperCase();
    if (!/^[A-Z0-9]+USD$/.test(key)) throw new Error('Invalid Delta perpetual symbol');
    if (symbolLocks.has(key)) throw new Error('An execution request for this symbol is already in progress');
    symbolLocks.add(key);
    try { return await operation(); }
    finally { symbolLocks.delete(key); }
  }

  async function getProducts() {
    assertConfigured();
    if (productsCache.length && now() - productsCachedAt < 5 * 60 * 1000) return productsCache;
    const products = [];
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 10; page++) {
      const response = await request('GET', '/v2/products', {
        contract_types: 'perpetual_futures',
        states: 'live',
        page_size: 100,
        after
      });
      const rows = Array.isArray(response.result) ? response.result : [];
      products.push(...rows);
      const nextAfter = stringOrEmpty(response.meta?.after);
      if (!nextAfter || nextAfter === after || nextAfter === previousAfter || rows.length === 0) break;
      previousAfter = after;
      after = nextAfter;
    }
    productsCache = products;
    productsCachedAt = now();
    return productsCache;
  }

  async function resolveProduct(symbol, { entryOnly = true } = {}) {
    const normalized = stringOrEmpty(symbol).toUpperCase();
    const product = (await getProducts()).find(row => {
      const rowSymbol = stringOrEmpty(row?.symbol || row?.product_symbol).toUpperCase();
      if (rowSymbol !== normalized ||
          stringOrEmpty(row?.contract_type || '').toLowerCase() !== 'perpetual_futures') return false;
      if (!entryOnly) return true; // Preserve reduce-only exits for any existing Testnet position.
      return isAllowedDeltaTestnetFutureSymbol(normalized) && isEligibleDeltaTestnetPerpetualProduct(row);
    });
    const id = numberOrNull(product?.id ?? product?.product_id);
    if (!product || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Delta Testnet perpetual product is not available: ' + normalized);
    }
    return { ...product, id };
  }

  async function getOpenPositions() {
    const response = await request('GET', '/v2/positions/margined', { contract_types: 'perpetual_futures' });
    if (!Array.isArray(response?.result)) {
      throw new Error('Delta Testnet positions response is malformed; refusing to treat it as an empty account');
    }
    const normalized = response.result.map(row => {
      const position = normalizePosition(row);
      if (!position) {
        throw new Error('Delta Testnet positions response contains an invalid row; refusing reconciliation');
      }
      return position;
    });
    return normalized.filter(position => position.qty > 0);
  }

  async function getOpenOrders() {
    const allRows = [];
    for (const state of ['open', 'pending']) {
      let after = '';
      let previousAfter = '';
      for (let page = 0; page < 10; page++) {
        const response = await request('GET', '/v2/orders', {
          contract_types: 'perpetual_futures',
          state,
          page_size: 100,
          after
        });
        const pageRows = Array.isArray(response.result) ? response.result : [];
        allRows.push(...pageRows);
        const nextAfter = stringOrEmpty(response.meta?.after);
        if (!nextAfter || nextAfter === after || nextAfter === previousAfter || pageRows.length === 0) break;
        previousAfter = after;
        after = nextAfter;
      }
    }
    const unique = new Map();
    for (const row of allRows) unique.set(String(row?.id ?? row?.client_order_id ?? JSON.stringify(row)), row);
    return [...unique.values()];
  }

  async function getOrderById(orderId) {
    const id = numberOrNull(orderId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Delta Testnet order id must be a positive integer');
    const response = await request('GET', '/v2/orders/' + encodeURIComponent(String(id)));
    const order = response?.result ?? response;
    if (!order || typeof order !== 'object' || Array.isArray(order) || Number(order.id) !== id) {
      throw new Error('Delta Testnet order detail response did not match the requested order id');
    }
    return order;
  }

  async function getOrderByClientOrderId(clientOrderId) {
    const clientId = stringOrEmpty(clientOrderId);
    if (!clientId) throw new Error('Delta Testnet client order id is required');
    const response = await request(
      'GET',
      '/v2/orders/client_order_id/' + encodeURIComponent(clientId)
    );
    const order = response?.result ?? response;
    const id = numberOrNull(order?.id);
    const returnedClientId = stringOrEmpty(order?.client_order_id);
    if (!order || typeof order !== 'object' || Array.isArray(order) ||
        !Number.isSafeInteger(id) || id <= 0 ||
        (returnedClientId && returnedClientId !== clientId)) {
      throw new Error('Delta Testnet client-order lookup did not return the requested order');
    }
    return order;
  }

  async function cancelOrderById(orderId) {
    const id = numberOrNull(orderId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Delta Testnet cancellation requires a positive exchange order id');
    }
    const terminalStates = new Set([
      'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'REJECTED', 'FAILED', 'EXPIRED', 'EXITED'
    ]);
    const current = await getOrderById(id);
    if (terminalStates.has(stringOrEmpty(current.state).toUpperCase())) return current;
    await request('DELETE', '/v2/orders', {}, { id });
    const verified = await getOrderById(id);
    const state = stringOrEmpty(verified.state).toUpperCase();
    if (!terminalStates.has(state)) {
      throw new Error('Delta Testnet order cancellation is unconfirmed; exchange state remains ' + (state || 'UNKNOWN'));
    }
    return verified;
  }

  function timestampMs(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      if (numeric >= 1e14) return numeric / 1000; // epoch microseconds
      if (numeric >= 1e11) return numeric;       // epoch milliseconds
      return numeric * 1000;                     // epoch seconds
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function timestampMicros(value) {
    const ms = timestampMs(value);
    return ms === null ? null : Math.round(ms * 1000);
  }

  async function getRecentCloseDetails(symbol, openedAt = null, position = {}) {
    const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
    const product = await resolveProduct(normalizedSymbol, { entryOnly: false });
    const clockMs = now();
    const openedMs = timestampMs(openedAt ?? position?.opened_at);
    const entryOrderLookupTooOld = () =>
      openedMs !== null && now() - openedMs > DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS;
    // Include a short pre-open buffer because the exchange fill can precede
    // the worker's first persisted position event by a few seconds. A fixed
    // 24-hour cap can exclude the entry fill of a longer-held position.
    const startMs = openedMs === null
      ? clockMs - 24 * 60 * 60 * 1000
      : Math.max(0, Math.min(openedMs, clockMs) - 30_000);
    const startTime = Math.round(startMs * 1000);
    const endTime = Math.round(clockMs * 1000);

    async function fetchHistory(path, targetOrderId = null) {
      const rows = [];
      let after = '';
      let previousAfter = '';
      let complete = false;
      for (let page = 0; page < 10; page += 1) {
        const params = {
          product_ids: String(product.id),
          contract_types: 'perpetual_futures',
          start_time: startTime,
          end_time: endTime,
          page_size: 50
        };
        if (after) params.after = after;
        const response = await request('GET', path, params);
        if (!Array.isArray(response?.result)) {
          throw new Error('Delta Testnet history response is malformed for ' + path);
        }
        rows.push(...response.result);
        if (targetOrderId !== null && rows.some(row =>
          String(row?.id ?? '') === String(targetOrderId)
        )) {
          complete = true;
          break;
        }
        const nextAfter = stringOrEmpty(response.meta?.after);
        if (response.result.length === 0 || !nextAfter) {
          complete = true;
          break;
        }
        // Repeated cursors indicate an incomplete response; never derive
        // aggregates from a possibly truncated order's fill history.
        if (nextAfter === after || nextAfter === previousAfter) break;
        previousAfter = after;
        after = nextAfter;
      }
      return { rows, complete };
    }

    const fillHistory = await fetchHistory('/v2/fills');
    // If the exchange cursor did not reach the end, neither the earliest close
    // nor its aggregate fees can be proved. Fail closed instead of selecting a
    // recent-but-unrelated close from a truncated history window.
    if (!fillHistory.complete) {
      await logExecutor('WARN', '[Executor] Close-fill history is incomplete; close details remain unverified', {
        symbol: normalizedSymbol,
        openedAt: openedAt || null
      });
      return null;
    }
    const fills = fillHistory.rows;
    const matchingFills = fills.filter(fill =>
      (!fill?.product_id || Number(fill.product_id) === product.id) &&
      (!fill?.product_symbol ||
        stringOrEmpty(fill.product_symbol).toUpperCase() === normalizedSymbol)
    );
    const entryOrderId = stringOrEmpty(position?.entry_order_id);
    const entryClientOrderId = stringOrEmpty(position?.client_order_id);
    const positionSide = stringOrEmpty(position?.side).toUpperCase();
    const closeSide = positionSide === 'BUY' ? 'SELL' : positionSide === 'SELL' ? 'BUY' : null;
    const hasEntryIdentity = Boolean(entryOrderId || entryClientOrderId);
    if (!hasEntryIdentity && !Number.isFinite(openedMs)) {
      await logExecutor('WARN', '[Executor] Position has no open timestamp or entry identity; close details remain unverified', {
        symbol: normalizedSymbol
      });
      return null;
    }
    let matchingEntryFills = hasEntryIdentity
      ? matchingFills.filter(fill =>
          ((entryOrderId && String(fill?.order_id ?? '') === entryOrderId) ||
            (entryClientOrderId && stringOrEmpty(fill?.client_order_id) === entryClientOrderId)) &&
          (!positionSide || stringOrEmpty(fill?.side).toUpperCase() === positionSide)
        )
      : [];
    let resolvedEntryOrderId = entryOrderId;

    // Some historical REST /v2/fills rows omit client_order_id. When the
    // position lacks its dedicated entry_order_id, resolve the exchange order
    // through Delta's client-order-ID endpoint, then match fills by order_id.
    // Never fall back to symbol/time-only guesses. Delta's client-order endpoint
    // is only useful for recent backfills; older IDs may have expired from the API.
    let historicalOrderNotFound = false;
    if (!entryOrderId && !matchingEntryFills.length && entryClientOrderId && !entryOrderLookupTooOld()) {
      try {
        const entryOrder = await getOrderByClientOrderId(entryClientOrderId);
        const lookupProductId = numberOrNull(entryOrder?.product_id);
        const lookupSymbol = stringOrEmpty(entryOrder?.product_symbol || entryOrder?.symbol).toUpperCase();
        const lookupSide = stringOrEmpty(entryOrder?.side).toUpperCase();
        const lookupClientOrderId = stringOrEmpty(entryOrder?.client_order_id);
        const lookupContextMatches =
          (!lookupProductId || lookupProductId === product.id) &&
          (!lookupSymbol || lookupSymbol === normalizedSymbol) &&
          (!lookupSide || lookupSide === positionSide) &&
          (!lookupClientOrderId || lookupClientOrderId === entryClientOrderId);

        if (lookupContextMatches) {
          resolvedEntryOrderId = String(entryOrder.id);
          matchingEntryFills = matchingFills.filter(fill =>
            String(fill?.order_id ?? '') === resolvedEntryOrderId &&
            (!positionSide || stringOrEmpty(fill?.side).toUpperCase() === positionSide)
          );
          if (matchingEntryFills.length) {
            await logExecutor('INFO', '[Executor] Entry fill identity recovered from client order ID', {
              symbol: normalizedSymbol,
              entryOrderId: resolvedEntryOrderId,
              hasClientOrderId: true,
              matchedFillCount: matchingEntryFills.length
            });
          }
        }
      } catch (error) {
        const errorMessage = String(error?.message || error);
        const errorCode = String(error?.code || '').trim().toLowerCase();
        const isOrderNotFound = errorCode === 'order_not_found' || /\border_not_found\b/i.test(errorMessage);
        const historicalMissingOrder = isOrderNotFound && entryOrderLookupTooOld();
        if (historicalMissingOrder) {
          historicalOrderNotFound = true;
          await logHistoricalEntryFillUnresolvedOnce({
            symbol: normalizedSymbol,
            entryClientOrderId,
            openedMs,
            orderNotFound: true
          });
        } else {
          await logExecutor('WARN', '[Executor] Entry order lookup by client ID failed; close details remain unverified', {
            symbol: normalizedSymbol,
            hasClientOrderId: true,
            error: errorMessage.slice(0, 200)
          });
        }
      }
    }

    if (hasEntryIdentity && !matchingEntryFills.length) {
      if (!historicalOrderNotFound) {
        const historicalLookupSkipped = entryOrderLookupTooOld();
        if (historicalLookupSkipped) {
          await logHistoricalEntryFillUnresolvedOnce({
            symbol: normalizedSymbol,
            entryOrderId: resolvedEntryOrderId,
            entryClientOrderId,
            openedMs
          });
        } else {
          await logExecutor('WARN', '[Executor] Entry fill identity was not found; close details remain unverified', {
            symbol: normalizedSymbol,
            entryOrderId: resolvedEntryOrderId || null,
            hasClientOrderId: Boolean(entryClientOrderId),
            fillResolution: 'UNRESOLVED'
          });
        }
      }
      return null;
    }
    const entryLastMs = matchingEntryFills.length
      ? Math.max(...matchingEntryFills.map(fill => timestampMs(fill?.created_at)).filter(Number.isFinite))
      : openedMs;
    if (hasEntryIdentity && !Number.isFinite(entryLastMs)) return null;
    const closeFills = matchingFills.filter(fill => {
      const fillMs = timestampMs(fill?.created_at);
      return numberOrNull(fill?.meta_data?.new_position?.size) === 0 &&
        Number.isFinite(fillMs) &&
        (!closeSide || stringOrEmpty(fill?.side).toUpperCase() === closeSide) &&
        (entryLastMs === null || !Number.isFinite(entryLastMs) || fillMs >= entryLastMs);
    });
    // The current open position is closed by the first flat-position fill after
    // its entry. A later same-symbol trade must never overwrite its P&L.
    closeFills.sort((a, b) =>
      (timestampMicros(a?.created_at) ?? 0) - (timestampMicros(b?.created_at) ?? 0)
    );
    const closeFill = closeFills[0];
    if (!closeFill) return null;

    const orderId = closeFill.order_id ?? null;
    const orderFills = orderId === null ? [] : matchingFills.filter(fill =>
      String(fill?.order_id ?? '') === String(orderId)
    );
    const pricedFills = orderFills.map(fill => ({
      price: numberOrNull(fill?.price),
      qty: numberOrNull(fill?.size)
    }));
    const hasCompletePrices = fillHistory.complete &&
      orderId !== null &&
      pricedFills.length > 0 &&
      pricedFills.every(fill =>
        fill.price !== null && fill.price > 0 &&
        fill.qty !== null && Math.abs(fill.qty) > 0
      );
    const totalQty = pricedFills.reduce(
      (sum, fill) => sum + Math.abs(fill.qty ?? 0), 0
    );
    const exitPrice = hasCompletePrices && totalQty > 0
      ? pricedFills.reduce(
          (sum, fill) => sum + fill.price * Math.abs(fill.qty), 0
        ) / totalQty
      : null;

    const commissions = orderFills.map(fill => numberOrNull(fill?.commission));
    const currencies = [...new Set(orderFills
      .map(fill => stringOrEmpty(fill?.settling_asset_symbol).toUpperCase())
      .filter(Boolean))];
    const fees = fillHistory.complete &&
      orderId !== null && commissions.length > 0 &&
      commissions.every(value => value !== null) && currencies.length === 1
      ? commissions.reduce((sum, value) => sum + value, 0)
      : null;
    const feeCurrency = currencies.length === 1 ? currencies[0] : null;
    const realizedPnl = numberOrNull(closeFill?.meta_data?.new_position?.realized_pnl);

    let orderHistory = null;
    if (orderId !== null) {
      try {
        const history = await fetchHistory('/v2/orders/history', orderId);
        orderHistory = history.rows.find(row =>
          String(row?.id ?? '') === String(orderId)
        ) || null;
      } catch (error) {
        await logExecutor('WARN', '[Executor] Close order history unavailable; reason may remain unknown', {
          symbol: normalizedSymbol,
          closeOrderId: String(orderId),
          error: String(error?.message || error).slice(0, 200)
        });
      }
    }

    const clientOrderId = orderHistory?.client_order_id ??
      closeFill?.client_order_id ?? null;
    return {
      exit_price: exitPrice,
      fees,
      fee_currency: feeCurrency,
      realized_pnl: realizedPnl,
      close_order_id: orderId === null ? null : String(orderId),
      client_order_id: clientOrderId,
      requested_exit_reason: position?.requested_exit_reason ?? null,
      stop_order_type: orderHistory?.stop_order_type ?? null,
      order_type: orderHistory?.order_type ?? closeFill?.meta_data?.order_type ?? null,
      fill_type: closeFill?.fill_type ?? null,
      reduce_only: orderHistory?.reduce_only ?? null,
      close_order_history_found: Boolean(orderHistory),
      close_fill_history_complete: fillHistory.complete === true
    };
  }

  async function getFillsPage({ startTime, endTime, after = null, pageSize = 50 } = {}) {
    const start = numberOrNull(startTime);
    const end = numberOrNull(endTime);
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end <= start) {
      throw new Error('Delta Testnet fills sync requires a valid microsecond time window');
    }
    const size = numberOrNull(pageSize);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error('Delta Testnet fills page size must be a positive integer');
    }
    const response = await request('GET', '/v2/fills', {
      contract_types: 'perpetual_futures',
      start_time: start,
      end_time: end,
      page_size: Math.min(50, size),
      after: stringOrEmpty(after) || undefined
    });
    if (!Array.isArray(response?.result)) {
      throw new Error('Delta Testnet fills endpoint returned an invalid result page');
    }
    return {
      rows: response.result,
      after: stringOrEmpty(response?.meta?.after) || null,
      before: stringOrEmpty(response?.meta?.before) || null
    };
  }


  async function getWalletTransactionsPage({ startTime, endTime, after = null, pageSize = 100 } = {}) {
    const start = numberOrNull(startTime);
    const end = numberOrNull(endTime);
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end <= start) {
      throw new Error('Delta Testnet wallet transaction sync requires a valid microsecond time window');
    }
    const size = numberOrNull(pageSize);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error('Delta Testnet wallet transaction page size must be a positive integer');
    }
    const response = await request('GET', '/v2/wallet/transactions', {
      start_time: start,
      end_time: end,
      page_size: Math.min(200, size),
      after: stringOrEmpty(after) || undefined
    });
    if (!Array.isArray(response?.result)) {
      throw new Error('Delta Testnet wallet transactions endpoint returned an invalid result page');
    }
    return {
      rows: response.result,
      after: stringOrEmpty(response?.meta?.after) || null,
      before: stringOrEmpty(response?.meta?.before) || null
    };
  }

  async function getWalletSnapshot() {
    return request('GET', '/v2/wallet/balances', {});
  }

  async function getAccountSnapshot() {
    const wallet = await getWalletSnapshot();
    const equity = accountEquity(wallet);
    if (!(equity > 0)) throw new Error('Delta Testnet account equity is unavailable; entries fail closed');
    return { equity, available: accountAvailable(wallet, equity), raw: wallet };
  }

  async function assertSafety(symbol, operation = 'ENTRY') {
    assertConfigured();
    // E-STOP is an entry inhibit, not an exit inhibit. Explicit EXIT
    // operations reduce exposure and must remain available during E-STOP.
    if (operation === 'EXIT') return;
    if (stringOrEmpty(env.DELTA_ENVIRONMENT).toUpperCase() !== 'TESTNET') {
      throw new Error('Delta Testnet entries require the explicit DELTA_ENVIRONMENT=TESTNET profile');
    }
    const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
    if (!isAllowedDeltaTestnetFutureSymbol(normalizedSymbol)) {
      throw new Error('Delta Testnet futures symbol is outside the fixed nine-product allowlist: ' + normalizedSymbol);
    }
    const settingsRows = await database.select(
      'dd_settings',
      'id=eq.1&select=id,enabled,emergency_stop,auto_trade,last_tick_at,max_open_positions'
    );
    if (!Array.isArray(settingsRows) || !settingsRows.length) {
      throw new Error('Entry settings are unavailable; Delta Testnet execution is blocked');
    }
    const entrySettings = settingsRows[0];
    if (entrySettings.enabled !== true) {
      throw new Error('Trading engine is disabled; Delta Testnet entry blocked');
    }
    if (entrySettings.emergency_stop !== false) {
      throw new Error('Emergency Stop is active or unknown; Delta Testnet executor refuses all entries');
    }
    if (entrySettings.auto_trade !== true) {
      throw new Error('Auto Trade is OFF or unknown; Delta Testnet executor refuses all entries');
    }
    if (!isMarketTickFresh(entrySettings.last_tick_at, now())) {
      throw new Error('Persisted market tick is stale or unavailable; Delta Testnet entry blocked');
    }
    const dayStart = indiaDateKey(new Date(now())) + 'T00:00:00+05:30';
    const [exchangePositions, exchangeOrders, wallet, closedToday, trackedOpenRows, recordedOrders] = await Promise.all([
      getOpenPositions(),
      getOpenOrders(),
      getWalletSnapshot(),
      database.select('dd_delta_positions', 'status=eq.CLOSED&closed_at=gte.' +
        encodeURIComponent(dayStart) + '&select=realized_pnl,closed_at&order=closed_at.desc&limit=10000'),
      database.select('dd_delta_positions', 'status=eq.OPEN&select=symbol&limit=1000'),
      database.select('dd_orders', 'order_type=eq.delta_testnet_order&select=symbol,state,created_at,updated_at&limit=1000')
    ]);

    const openSymbols = new Set(exchangePositions.map(row => row.symbol));
    for (const row of trackedOpenRows || []) {
      const value = stringOrEmpty(row?.symbol).toUpperCase();
      if (value) openSymbols.add(value);
    }
    const activeRecordedOrders = (recordedOrders || []).filter(row => !terminalState(row?.state));
    for (const row of activeRecordedOrders) {
      const value = stringOrEmpty(row?.symbol).toUpperCase();
      if (value) openSymbols.add(value);
    }
    for (const row of exchangeOrders) {
      const value = stringOrEmpty(row?.product_symbol || row?.symbol).toUpperCase();
      if (value) openSymbols.add(value);
    }

    if (openSymbols.has(normalizedSymbol)) {
      throw new Error('Same-symbol position/order/reservation already exists: ' + normalizedSymbol);
    }
    const configuredPositionCap = numberOrNull(entrySettings.max_open_positions);
    if (!Number.isSafeInteger(configuredPositionCap) || configuredPositionCap <= 0) {
      throw new Error('Configured max_open_positions is missing or invalid; Delta Testnet entry blocked');
    }
    const effectivePositionCap = Math.min(MAX_DELTA_TESTNET_OPEN_POSITIONS, configuredPositionCap);
    if (openSymbols.size >= effectivePositionCap) {
      throw new Error('Delta Testnet open-position cap reached (' + openSymbols.size + '/' +
        effectivePositionCap + ')');
    }

    const equity = accountEquity(wallet);
    if (!(equity > 0)) throw new Error('Delta Testnet account equity is unavailable; entries fail closed');
    const realizedPnl = (Array.isArray(closedToday) ? closedToday : []).reduce((sum, row) => {
      const value = numberOrNull(row?.realized_pnl);
      if (value === null) throw new Error('Daily realized P&L is incomplete; new entries are halted');
      return sum + value;
    }, 0);
    let unrealizedPnl = 0;
    for (const position of exchangePositions) {
      if (position.unrealized_pnl === null) {
        throw new Error('Open-position unrealized P&L is unavailable; new entries are halted');
      }
      unrealizedPnl += position.unrealized_pnl;
    }
    const dailyPnl = realizedPnl + unrealizedPnl;
    if (dailyPnl <= -(equity * DELTA_TESTNET_DAILY_LOSS_LIMIT)) {
      throw new Error('Daily P&L stop reached (' + dailyPnl.toFixed(2) + ' USD); new entries halted');
    }
  }

  function buildClientOrderId(value, prefix, symbol) {
    const raw = stringOrEmpty(value) ||
      (prefix + '-' + stringOrEmpty(symbol).toUpperCase().slice(0, 10) + '-' + Math.floor(now() / 60000).toString(36));
    const normalized = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
    if (!normalized) throw new Error('Could not create a valid Delta client_order_id');
    return normalized;
  }

  async function getFreshMarkPrice(symbol) {
    const response = await request('GET', '/v2/tickers/' + encodeURIComponent(symbol));
    const ticker = Array.isArray(response?.result) ? response.result[0] : response?.result;
    const markPrice = numberOrNull(ticker?.mark_price);
    if (!(markPrice > 0)) {
      throw new Error('Fresh Delta Testnet mark price is unavailable for ' + stringOrEmpty(symbol).toUpperCase());
    }
    return markPrice;
  }

  async function persistRestConfirmedPosition({ product, body, order, clientOrderId, strategy }) {
    const symbol = stringOrEmpty(product?.symbol).toUpperCase();
    try {
      let position = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const positions = await getOpenPositions();
          position = positions.find(row => row.symbol === symbol && row.qty > 0) || null;
        } catch (error) {
          await logExecutor('WARN', '[Executor] Immediate REST position confirmation attempt failed', {
            symbol, clientOrderId, attempt: attempt + 1,
            error: String(error?.message || error).slice(0, 200)
          });
        }
        if (position) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }

      if (!position) {
        await logExecutor('WARN', '[Executor] REST order response confirms fill but position snapshot is delayed; periodic reconciler remains the backup', {
          symbol, orderId: order?.id ?? null, clientOrderId,
          attempts: 3, averageFillPrice: numberOrNull(order?.average_fill_price) ?? null
        });
        return false;
      }

      const timestamp = new Date(now()).toISOString();
      const row = {
        symbol,
        side: position.side || (stringOrEmpty(body?.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY'),
        qty: position.qty,
        status: 'OPEN',
        strategy: strategyValue(strategy),
        opened_at: position.opened_at || timestamp,
        closed_at: null,
        updated_at: timestamp,
        order_id: String(order?.id ?? position.order_id ?? ''),
        client_order_id: clientOrderId,
        product_id: position.product_id ?? product.id,
        entry_price: numberOrNull(position.entry_price) ?? numberOrNull(order?.average_fill_price),
        current_price: numberOrNull(position.current_price),
        unrealized_pnl: numberOrNull(position.unrealized_pnl),
        realized_pnl: numberOrNull(position.realized_pnl),
        sl_price: numberOrNull(position.sl_price) ?? numberOrNull(body?.bracket_stop_loss_price),
        tp_price: numberOrNull(position.tp_price) ?? numberOrNull(body?.bracket_take_profit_price)
      };

      const query = 'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&select=id&limit=1';
      const existing = await database.select('dd_delta_positions', query);
      if (!Array.isArray(existing)) throw new Error('REST position sync could not read existing OPEN rows');
      if (existing[0]?.id !== undefined && existing[0]?.id !== null) {
        await database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(existing[0].id), row);
      } else {
        try {
          await database.insert('dd_delta_positions', row);
        } catch (insertError) {
          const concurrent = await database.select('dd_delta_positions', query);
          if (!Array.isArray(concurrent) || concurrent[0]?.id === undefined || concurrent[0]?.id === null) throw insertError;
          await database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(concurrent[0].id), row);
        }
      }

      await logExecutor('INFO', '[Executor] REST fill confirmation persisted to dd_delta_positions', {
        symbol, side: row.side, qty: row.qty, orderId: row.order_id, clientOrderId,
        entryPrice: row.entry_price, positionSnapshotSource: 'GET /v2/positions/margined'
      });
      return true;
    } catch (error) {
      // Do not report a confirmed exchange fill as a rejected order merely
      // because local persistence failed. The five-minute reconciler retries.
      await logExecutor('ERROR', '[Executor] REST fill confirmed but immediate local position persistence failed; reconciler remains the backup', {
        symbol, clientOrderId, orderId: order?.id ?? null,
        error: String(error?.message || error).slice(0, 240)
      });
      return false;
    }
  }

  async function submitOrder(
    product,
    body,
    {
      strategy = 'MOMENTUM',
      role = 'ENTRY',
      reserve = true,
      referenceEntryPrice = null
    } = {}
  ) {
    const clientOrderId = stringOrEmpty(body?.client_order_id);
    const normalizedSymbol = stringOrEmpty(
      product?.symbol || body?.product_symbol
    ).toUpperCase();

    const reservation = {
      id: clientOrderId,
      product_id: product.id,
      symbol: normalizedSymbol,
      side: body.side,
      order_type: 'delta_testnet_order',
      size: body.size,
      state: 'PENDING',
      client_order_id: clientOrderId,
      role,
      strategy: strategyValue(strategy),
      execution_id: clientOrderId,
      raw: {
        source: 'delta_testnet',
        environment: 'testnet',
        reservation: true,
        entry_price: body.limit_price ?? referenceEntryPrice ?? null,
        exchange_order_type: body.order_type ?? null,
        stop_price: body.bracket_stop_loss_price ?? null,
        tp_price: body.bracket_take_profit_price ?? null,
        bracket_stop_trigger_method: body.bracket_stop_trigger_method ?? null,
        reduce_only: body.reduce_only === true
      }
    };

    if (reserve) {
      // Persist a PENDING reservation before the network call; ambiguous timeouts stay blocked.
      await database.upsert('dd_orders', reservation, 'client_order_id');
    }

    const requestDetails = {
      environment: 'testnet',
      method: 'POST',
      endpoint: '/v2/orders',
      url: DELTA_TESTNET_REST_BASE + '/v2/orders',
      symbol: normalizedSymbol,
      side: stringOrEmpty(body?.side).toUpperCase(),
      qty: body.size,
      orderType: body.order_type ?? null,
      productId: product.id,
      clientOrderId,
      referenceEntryPrice: body.limit_price ?? referenceEntryPrice ?? null,
      stopLossPrice: body.bracket_stop_loss_price ?? null,
      takeProfitPrice: body.bracket_take_profit_price ?? null,
      bracketStopTriggerMethod: body.bracket_stop_trigger_method ?? null,
      reduceOnly: body.reduce_only === true
    };

    await logExecutor(
      'INFO',
      '[Executor] Placing order on Delta Testnet API',
      requestDetails
    );

    try {
      // The signed request() call below sends the actual order to Testnet.
      const response = await request('POST', '/v2/orders', {}, body);
      const order = response.result ?? response;

      if (
        !order ||
        typeof order !== 'object' ||
        !(order.id || order.client_order_id || order.state)
      ) {
        throw new Error('Delta Testnet did not return a valid order acknowledgement');
      }

      const unfilledSize = numberOrNull(order?.unfilled_size);
      const apiState = stringOrEmpty(order?.state || 'UNKNOWN').toUpperCase();
      const testnetOrderId = order.id ?? null;
      const averageFillPrice = numberOrNull(order?.average_fill_price ?? order?.avg_fill_price);
      const fillConfirmedByRest =
        ['FILLED', 'CLOSED'].includes(apiState) &&
        unfilledSize === 0 &&
        averageFillPrice !== null &&
        averageFillPrice > 0;
      const positionSnapshotConfirmedByRest = fillConfirmedByRest && reserve && role === 'ENTRY'
        ? await persistRestConfirmedPosition({ product, body, order, clientOrderId, strategy })
        : false;

      if (reserve) {
        await database.update(
          'dd_orders',
          'client_order_id=eq.' + encodeURIComponent(clientOrderId),
          {
            state: apiState,
            unfilled_size: unfilledSize,
            updated_at: new Date(now()).toISOString(),
            raw: {
              ...reservation.raw,
              reservation: false,
              accepted: true,
              testnet_order_id: testnetOrderId,
              exchange_state: order.state ?? null,
              unfilled_size: unfilledSize,
              average_fill_price: order.average_fill_price ?? null,
              fill_confirmed_by_rest: fillConfirmedByRest,
              position_snapshot_confirmed_by_rest: positionSnapshotConfirmedByRest
            }
          }
        ).catch(error => database.log(
          'ERROR',
          'Delta Testnet order accepted but reservation update failed; reservation is retained',
          {
            symbol: normalizedSymbol,
            clientOrderId,
            error: String(error?.message || error)
          }
        ));
      }

      await logExecutor(
        'INFO',
        '[Executor] Delta Testnet order acknowledgement and fill confirmation status',
        {
          ...requestDetails,
          orderId: testnetOrderId,
          apiState,
          unfilledSize,
          unfilledSizeStatus: unfilledSize === null ? 'unknown' : unfilledSize,
          averageFillPrice: order.average_fill_price ?? null,
          fillConfirmedByRest,
          positionSnapshotConfirmedByRest,
          fillConfirmedByPrivateWebSocketAtAcknowledgement: false,
          note: fillConfirmedByRest
            ? 'REST order response confirms fill; private WebSocket confirmation may arrive independently'
            : 'Waiting for a private WebSocket fill event or REST position reconciliation'
        }
      );

      return order;
    } catch (error) {
      const status = Number(error?.status);
      const knownRejected = Number.isInteger(status) &&
        status >= 400 && status < 500 && status !== 408 && status !== 429;

      if (reserve) {
        await database.update(
          'dd_orders',
          'client_order_id=eq.' + encodeURIComponent(clientOrderId),
          {
            state: knownRejected ? 'FAILED' : 'UNKNOWN',
            updated_at: new Date(now()).toISOString(),
            raw: {
              ...reservation.raw,
              reservation: !knownRejected,
              accepted: false,
              outcome: knownRejected ? 'rejected' : 'unknown',
              error_code: String(error?.code || 'delta_testnet_request_failed'),
              http_status: Number.isInteger(status) ? status : null
            }
          }
        ).catch(() => {});
      }

      await logExecutor(
        'ERROR',
        '[Executor] Delta Testnet API order request failed',
        {
          ...requestDetails,
          httpStatus: Number.isInteger(status) ? status : null,
          errorCode: String(error?.code || 'delta_testnet_request_failed'),
          reason: String(error?.message || error),
          reservationState: knownRejected ? 'FAILED' : 'UNKNOWN',
          doNotBlindlyRetry: !knownRejected
        }
      );

      throw error;
    }
  }

  async function placeOrder(symbol, side, qty, price = null) {
    return withSymbolLock(symbol, async () => {
      const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
      const direction = stringOrEmpty(side).toUpperCase();
      const quantity = numberOrNull(qty);
      const hasPrice = price !== null && price !== undefined;
      const limitPrice = hasPrice ? numberOrNull(price) : null;
      if (!['BUY', 'SELL'].includes(direction)) throw new Error('side must be BUY or SELL');
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('qty must be a positive whole number of contracts');
      if (hasPrice && !(limitPrice > 0)) throw new Error('limit price must be positive');
      await assertSafety(normalizedSymbol, 'ENTRY');
      const product = await resolveProduct(normalizedSymbol);
      const body = {
        product_id: product.id,
        size: quantity,
        side: direction.toLowerCase(),
        order_type: limitPrice === null ? 'market_order' : 'limit_order',
        client_order_id: buildClientOrderId(null, 'DDX', normalizedSymbol)
      };
      if (limitPrice !== null) body.limit_price = String(limitPrice);
      return submitOrder(product, body, { strategy: 'MOMENTUM', role: 'ENTRY' });
    });
  }

  async function placeBracketOrder(symbol, side, qty, entryPrice, slPrice, tpPrice, options = {}) {
    return withSymbolLock(symbol, async () => {
      const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
      const direction = stringOrEmpty(side).toUpperCase();
      const quantity = numberOrNull(qty);
      const entry = numberOrNull(entryPrice);
      const stop = numberOrNull(slPrice);
      const target = numberOrNull(tpPrice);
      if (!['BUY', 'SELL'].includes(direction)) throw new Error('side must be BUY or SELL');
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('qty must be a positive whole number of contracts');
      if (!(Number.isFinite(entry) && entry > 0)) {
        await logExecutor('ERROR', '[Executor] Blocked bracket order: invalid entry price', {
          environment: 'testnet', symbol: normalizedSymbol, entryPrice: entryPrice ?? null,
          executionBlocked: true
        });
        throw new Error('Invalid entry price (must be finite and > 0)');
      }
      if (!(Number.isFinite(stop) && stop > 0)) {
        await logExecutor('ERROR', '[Executor] Blocked bracket order: invalid SL price', {
          environment: 'testnet', symbol: normalizedSymbol, stopLossPrice: slPrice ?? null,
          executionBlocked: true
        });
        throw new Error('Invalid SL price (must be finite and > 0)');
      }
      if (!(Number.isFinite(target) && target > 0)) {
        await logExecutor('ERROR', '[Executor] Blocked bracket order: invalid TP price', {
          environment: 'testnet', symbol: normalizedSymbol, takeProfitPrice: tpPrice ?? null,
          executionBlocked: true
        });
        throw new Error('Invalid TP price (must be finite and > 0)');
      }
      if (direction === 'BUY' && !(stop < entry && target > entry)) {
        throw new Error('BUY bracket prices must satisfy SL < entry < TP');
      }
      if (direction === 'SELL' && !(target < entry && stop > entry)) {
        throw new Error('SELL bracket prices must satisfy TP < entry < SL');
      }
      const slDistancePct = Math.abs(stop - entry) / entry * 100;
      const minSlDistancePct = resolveMinimumStopDistancePct(process.env.DELTA_MIN_SL_DISTANCE_PCT);
      if (slDistancePct + 1e-9 < minSlDistancePct) {
        await logExecutor('WARN', '[Executor] SL distance too tight; entry blocked', {
          environment: 'testnet', symbol: normalizedSymbol, side: direction,
          entryPrice: entry, stopLossPrice: stop, slDistancePct: Number(slDistancePct.toFixed(4)),
          minimumSlDistancePct: minSlDistancePct, executionBlocked: true,
          reason: 'SL_DISTANCE_BELOW_MINIMUM'
        });
        throw new Error('SL distance too tight (' + slDistancePct.toFixed(2) + '%), minimum required ' + minSlDistancePct.toFixed(2) + '%');
      }
      await assertSafety(normalizedSymbol, 'ENTRY');
      const product = await resolveProduct(normalizedSymbol);
      const expectedProductId = numberOrNull(options?.expectedProductId);
      if (expectedProductId !== null && expectedProductId !== product.id) {
        throw new Error('Delta Testnet product ID changed since signal generation; entry blocked');
      }

      let liveMarkPrice;
      try {
        liveMarkPrice = await getFreshMarkPrice(normalizedSymbol);
      } catch (error) {
        await logExecutor('WARN', '[Executor] Blocked bracket order: fresh mark price unavailable', {
          environment: 'testnet', symbol: normalizedSymbol, referenceEntryPrice: entry,
          stopLossPrice: stop, takeProfitPrice: target,
          error: String(error?.message || error).slice(0, 200),
          executionBlocked: true
        });
        throw new Error('Fresh Delta Testnet mark price unavailable; entry blocked');
      }
      const bracketContainsLiveMark = direction === 'BUY'
        ? stop < liveMarkPrice && liveMarkPrice < target
        : target < liveMarkPrice && liveMarkPrice < stop;
      if (!bracketContainsLiveMark) {
        const referenceDriftPct = entry > 0 ? Math.abs(liveMarkPrice - entry) / entry * 100 : null;
        await logExecutor('WARN', '[Executor] Blocked bracket order: live mark moved outside requested SL/TP bracket', {
          environment: 'testnet', symbol: normalizedSymbol, side: direction,
          referenceEntryPrice: entry, liveMarkPrice, referenceDriftPct,
          stopLossPrice: stop, takeProfitPrice: target,
          executionBlocked: true, reason: 'LIVE_MARK_OUTSIDE_BRACKET'
        });
        throw new Error('Live mark has moved outside the requested SL/TP bracket; refresh signal before entry');
      }

      const strategy = strategyValue(options?.strategy);
      const prefix = strategy === 'MOMENTUM' ? 'DDM' : strategy === 'SCALPING' ? 'DDS' : 'DDG';
      const requestedOrderType = String(options?.orderType || 'market_order').trim().toLowerCase();
      if (!['market_order', 'limit_order'].includes(requestedOrderType)) {
        throw new Error('Grid bracket order type must be market_order or limit_order');
      }
      const body = {
        product_id: product.id,
        size: quantity,
        side: direction.toLowerCase(),
        order_type: requestedOrderType,
        client_order_id: buildClientOrderId(options?.clientOrderId, prefix, normalizedSymbol),
        bracket_stop_loss_price: String(stop),
        bracket_take_profit_price: String(target),
        bracket_stop_trigger_method: 'mark_price',
        ...(requestedOrderType === 'limit_order'
          ? { limit_price: String(entry), time_in_force: 'gtc', reduce_only: false }
          : {})
      };

      await logExecutor(
        'INFO',
        '[Executor] Preparing Testnet ' + requestedOrderType.replace('_', ' ') + ' bracket order',
        {
          environment: 'testnet',
          symbol: normalizedSymbol,
          side: direction,
          qty: quantity,
          orderType: body.order_type,
          referenceEntryPrice: entry,
          stopLossPrice: stop,
          takeProfitPrice: target,
          bracketStopTriggerMethod: body.bracket_stop_trigger_method,
          clientOrderId: body.client_order_id
        }
      );

      return submitOrder(product, body, {
        strategy,
        role: 'ENTRY',
        referenceEntryPrice: entry
      });
    });
  }

  async function closePosition(symbol, qty, options = {}) {
    return withSymbolLock(symbol, async () => {
      const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
      const quantity = numberOrNull(qty);
      const positionId = stringOrEmpty(options?.positionId);
      const closeReason = stringOrEmpty(options?.closeReason).toUpperCase();
      const expectedSide = stringOrEmpty(options?.expectedSide).toUpperCase();
      const expectedProductId = numberOrNull(options?.expectedProductId);
      const strategy = strategyValue(options?.strategy);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error('qty must be a positive whole number of contracts');
      }
      if (!positionId || !['TIMEOUT', 'STOP_LOSS', 'TAKE_PROFIT'].includes(closeReason)) {
        throw new Error('Automatic close requires a stable position id and supported close reason');
      }
      if (!['BUY', 'SELL'].includes(expectedSide)) {
        throw new Error('Automatic close requires the canonical position side');
      }

      // EXIT is exposure-reducing and remains available during E-STOP, but
      // assertSafety still hard-locks this route to the Delta India Testnet host.
      await assertSafety(normalizedSymbol, 'EXIT');
      const clientOrderId = buildCloseClientOrderId(positionId, closeReason);

      // First resolve any earlier submission by its stable exchange identity.
      // Never POST a second close when the first request may have been accepted.
      let existingOrder = null;
      try {
        existingOrder = await getOrderByClientOrderId(clientOrderId);
      } catch (error) {
        if (Number(error?.status) !== 404) {
          await logExecutor('ERROR', '[Executor] Close-order idempotency lookup failed; duplicate submission blocked', {
            environment: 'testnet', symbol: normalizedSymbol, positionId,
            closeReason, clientOrderId, error: String(error?.message || error).slice(0, 220)
          });
          throw error;
        }
      }
      if (existingOrder) {
        const existingState = stringOrEmpty(existingOrder.state).toUpperCase();
        if (['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(existingState)) {
          await logExecutor('ERROR', '[Executor] Prior close order is terminal without a confirmed flat position', {
            environment: 'testnet', symbol: normalizedSymbol, positionId,
            closeReason, clientOrderId, state: existingState,
            positionStatus: 'OPEN', duplicateSubmissionBlocked: true
          });
          throw new Error('Existing idempotent close order is terminal (' + existingState + '); position remains OPEN');
        }
        await logExecutor('INFO', '[Executor] Reusing existing idempotent close order; no duplicate POST sent', {
          environment: 'testnet', symbol: normalizedSymbol, positionId,
          closeReason, clientOrderId, orderId: existingOrder.id ?? null,
          state: existingState || 'UNKNOWN'
        });
        return existingOrder;
      }

      // The exchange lookup was a definite 404. A durable reservation means a
      // previous worker may have timed out before learning the exchange result;
      // do not blindly submit again if that state cannot be reconciled.
      const priorReservations = await database.select(
        'dd_orders',
        'client_order_id=eq.' + encodeURIComponent(clientOrderId) +
          '&select=client_order_id,state,raw&limit=1'
      );
      if (!Array.isArray(priorReservations)) {
        throw new Error('Close-order reservation lookup is incomplete; duplicate submission blocked');
      }
      if (priorReservations.length) {
        const reservation = priorReservations[0];
        const state = stringOrEmpty(reservation?.state).toUpperCase() || 'UNKNOWN';
        const outcome = stringOrEmpty(reservation?.raw?.outcome).toLowerCase();
        // A definite 4xx rejection means Delta did not accept an order. It is
        // safe to retry with the same deterministic client ID; ambiguous
        // PENDING/UNKNOWN outcomes remain blocked to prevent duplicate exposure.
        if (!(state === 'FAILED' && outcome === 'rejected')) {
          await logExecutor('ERROR', '[Executor] Existing close reservation has no exchange acknowledgement; duplicate POST blocked', {
            environment: 'testnet', symbol: normalizedSymbol, positionId,
            closeReason, clientOrderId, reservationState: state,
            positionStatus: 'OPEN'
          });
          throw new Error('Existing close reservation is ' + state + ' but exchange lookup returned 404; refusing duplicate close');
        }
        await logExecutor('WARN', '[Executor] Retrying a definitively rejected close with the same stable client_order_id', {
          environment: 'testnet', symbol: normalizedSymbol, positionId,
          closeReason, clientOrderId, reservationState: state
        });
      }

      const positions = await getOpenPositions();
      const position = positions.find(row => row.symbol === normalizedSymbol);
      if (!position) {
        await logExecutor('INFO', '[Executor] Position is already flat; no close order required', {
          environment: 'testnet', symbol: normalizedSymbol, positionId,
          closeReason, clientOrderId
        });
        return { state: 'ALREADY_FLAT', client_order_id: clientOrderId };
      }
      if (position.side !== expectedSide) {
        throw new Error('Exchange/local position side mismatch; reduce-only close blocked');
      }
      if (expectedProductId !== null && position.product_id !== expectedProductId) {
        throw new Error('Exchange/local product ID mismatch; reduce-only close blocked');
      }
      if (quantity > position.qty) throw new Error('Close quantity exceeds the open position quantity');
      if (quantity !== position.qty) {
        throw new Error('Partial close is disabled in this phase; full position quantity is required');
      }

      const product = await resolveProduct(normalizedSymbol, { entryOnly: false });
      if (position.product_id !== null && position.product_id !== product.id) {
        throw new Error('Exchange position product does not match the live Delta Testnet product');
      }

      // Do not remove SL/TP protection before the market close is accepted.
      // If Delta rejects the close, the position and its existing protection stay intact.
      const order = await submitOrder(product, {
        product_id: product.id,
        size: quantity,
        side: position.side === 'BUY' ? 'sell' : 'buy',
        order_type: 'market_order',
        reduce_only: true,
        client_order_id: clientOrderId
      }, { strategy, role: 'EXIT', reserve: true });

      const acceptedState = stringOrEmpty(order?.state).toUpperCase();
      if (['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(acceptedState)) {
        await logExecutor('ERROR', '[Executor] Delta acknowledged a terminally rejected close; position remains OPEN', {
          environment: 'testnet', symbol: normalizedSymbol, positionId,
          closeReason, clientOrderId, orderId: order?.id ?? null,
          state: acceptedState, positionStatus: 'OPEN'
        });
        throw new Error('Delta Testnet close order was not accepted (' + acceptedState + ')');
      }

      // Cancel protective reduce-only orders only after REST confirms the
      // position is flat. If the snapshot is delayed or the close is partial,
      // leave protection untouched for the next reconciliation cycle.
      if (['FILLED', 'CLOSED'].includes(acceptedState) && numberOrNull(order?.unfilled_size) === 0) {
        let confirmedFlat = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const latest = await getOpenPositions();
          confirmedFlat = !latest.some(row => row.symbol === normalizedSymbol && row.qty > 0);
          if (confirmedFlat) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
        if (confirmedFlat) {
          const openOrders = await getOpenOrders();
          const protections = openOrders.filter(row =>
            (numberOrNull(row?.product_id) === product.id ||
              stringOrEmpty(row?.product_symbol || row?.symbol).toUpperCase() === normalizedSymbol) &&
            (row?.reduce_only === true || Boolean(row?.stop_order_type) || row?.bracket_order === true)
          );
          for (const protection of protections) {
            const orderId = numberOrNull(protection?.id);
            if (orderId === null) {
              await logExecutor('ERROR', '[Executor] Flat position has a protective order without an exchange id', {
                environment: 'testnet', symbol: normalizedSymbol, positionId,
                closeReason, clientOrderId
              });
              continue;
            }
            await cancelOrderById(orderId);
          }
        } else {
          await logExecutor('WARN', '[Executor] Close order is filled but position snapshot is not yet flat; protection retained', {
            environment: 'testnet', symbol: normalizedSymbol, positionId,
            closeReason, clientOrderId, orderId: order?.id ?? null
          });
        }
      }

      return order;
    });
  }

  const optionsExecution = createDeltaOptionsExecution({
    env,
    request,
    database,
    getAccountSnapshot,
    logExecutor,
    buildClientOrderId,
    now,
    isMarketTickFresh
  });

  async function previewOptionsOrder(input) {
    return optionsExecution.previewOptionsOrder(input);
  }

  async function placeOptionsOrder(input) {
    return optionsExecution.placeOptionsOrder(input);
  }

  async function monitorOptionsExits() {
    return optionsExecution.monitorOptionsExits();
  }

  return Object.freeze({
    placeOrder,
    placeBracketOrder,
    previewOptionsOrder,
    placeOptionsOrder,
    monitorOptionsExits,
    closePosition,
    getOpenPositions,
    getOpenOrders,
    getOrderById,
    getOrderByClientOrderId,
    cancelOrderById,
    getFillsPage,
    getWalletTransactionsPage,
    getAccountSnapshot,
    getRecentCloseDetails,
    getProductMetadata: resolveProduct,
    assertConfigured
  });
}

export const deltaExecutor = createDeltaExecutor();
export const placeOrder = (...args) => deltaExecutor.placeOrder(...args);
export const placeBracketOrder = (...args) => deltaExecutor.placeBracketOrder(...args);
export const closePosition = (...args) => deltaExecutor.closePosition(...args);
export const getOpenPositions = (...args) => deltaExecutor.getOpenPositions(...args);
