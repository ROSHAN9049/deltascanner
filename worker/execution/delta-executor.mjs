import crypto from 'node:crypto';
import * as defaultDb from '../../server/db.js';
import { indiaDateKey } from '../../src/date-utils.js';

export const DELTA_TESTNET_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
export const DELTA_TESTNET_PRIVATE_WS_URL = 'wss://socket-ind.testnet.deltaex.org';
export const MAX_DELTA_TESTNET_OPEN_POSITIONS = 20;
export const DELTA_TESTNET_DAILY_LOSS_LIMIT = 0.05;

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
    current_price: numberOrNull(row?.mark_price ?? row?.current_price ?? row?.last_traded_price),
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
  let productsCache = [];
  let productsCachedAt = 0;

  function assertConfigured() {
    return assertDeltaTestnetConfiguration(env);
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

  async function resolveProduct(symbol) {
    const normalized = stringOrEmpty(symbol).toUpperCase();
    const product = (await getProducts()).find(row =>
      stringOrEmpty(row?.symbol || row?.product_symbol).toUpperCase() === normalized &&
      stringOrEmpty(row?.contract_type || 'perpetual_futures').toLowerCase().includes('perpetual')
    );
    const id = numberOrNull(product?.id ?? product?.product_id);
    if (!product || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Delta Testnet perpetual product is not available: ' + normalized);
    }
    return { ...product, id };
  }

  async function getOpenPositions() {
    const response = await request('GET', '/v2/positions/margined', { contract_types: 'perpetual_futures' });
    return (Array.isArray(response.result) ? response.result : [])
      .map(normalizePosition)
      .filter(position => position && position.qty > 0);
  }

  async function getOpenOrders() {
    const rows = [];
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 10; page++) {
      const response = await request('GET', '/v2/orders', {
        contract_types: 'perpetual_futures',
        state: 'open',
        page_size: 100,
        after
      });
      const pageRows = Array.isArray(response.result) ? response.result : [];
      rows.push(...pageRows);
      const nextAfter = stringOrEmpty(response.meta?.after);
      if (!nextAfter || nextAfter === after || nextAfter === previousAfter || pageRows.length === 0) break;
      previousAfter = after;
      after = nextAfter;
    }
    return rows;
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
    const settingsRows = await database.select('dd_settings', 'id=eq.1&select=id,emergency_stop');
    if (!Array.isArray(settingsRows) || !settingsRows.length) {
      throw new Error('Emergency Stop setting is unavailable; Delta Testnet execution is blocked');
    }
    if (settingsRows[0].emergency_stop === true) {
      throw new Error('Emergency Stop is active; Delta Testnet executor refuses all orders');
    }
    if (operation === 'EXIT') return;

    const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
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
    if (openSymbols.size >= MAX_DELTA_TESTNET_OPEN_POSITIONS) {
      throw new Error('Delta Testnet open-position cap reached (' + openSymbols.size + '/' +
        MAX_DELTA_TESTNET_OPEN_POSITIONS + ')');
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

  async function submitOrder(product, body, { strategy = 'MOMENTUM', role = 'ENTRY', reserve = true } = {}) {
    const clientOrderId = stringOrEmpty(body?.client_order_id);
    const normalizedSymbol = stringOrEmpty(product?.symbol || body?.product_symbol).toUpperCase();
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
        reservation: true,
        entry_price: body.limit_price ?? null,
        stop_price: body.bracket_stop_loss_price ?? null,
        tp_price: body.bracket_take_profit_price ?? null,
        reduce_only: body.reduce_only === true
      }
    };
    if (reserve) {
      // Persist a PENDING reservation before the network call; ambiguous timeouts stay blocked.
      await database.upsert('dd_orders', reservation, 'client_order_id');
    }
    try {
      const response = await request('POST', '/v2/orders', {}, body);
      const order = response.result ?? response;
      if (!order || typeof order !== 'object' || !(order.id || order.client_order_id || order.state)) {
        throw new Error('Delta Testnet did not return a valid order acknowledgement');
      }
      if (reserve) {
        await database.update(
          'dd_orders',
          'client_order_id=eq.' + encodeURIComponent(clientOrderId),
          {
            state: stringOrEmpty(order.state || 'open').toUpperCase(),
            updated_at: new Date(now()).toISOString(),
            raw: {
              ...reservation.raw,
              reservation: false,
              accepted: true,
              testnet_order_id: order.id ?? null,
              exchange_state: order.state || null
            }
          }
        ).catch(error => database.log('ERROR', 'Delta Testnet order accepted but reservation update failed; reservation is retained', {
          symbol: normalizedSymbol,
          clientOrderId,
          error: String(error?.message || error)
        }));
      }
      return order;
    } catch (error) {
      if (reserve) {
        const status = Number(error?.status);
        const knownRejected = Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
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
      if (!(entry > 0 && stop > 0 && target > 0)) throw new Error('entry, SL and TP prices must be positive');
      if (direction === 'BUY' && !(stop < entry && target > entry)) {
        throw new Error('BUY bracket prices must satisfy SL < entry < TP');
      }
      if (direction === 'SELL' && !(target < entry && stop > entry)) {
        throw new Error('SELL bracket prices must satisfy TP < entry < SL');
      }
      await assertSafety(normalizedSymbol, 'ENTRY');
      const product = await resolveProduct(normalizedSymbol);
      const strategy = strategyValue(options?.strategy);
      const prefix = strategy === 'MOMENTUM' ? 'DDM' : strategy === 'SCALPING' ? 'DDS' : 'DDG';
      const body = {
        product_id: product.id,
        size: quantity,
        side: direction.toLowerCase(),
        order_type: 'limit_order',
        limit_price: String(entry),
        client_order_id: buildClientOrderId(options?.clientOrderId, prefix, normalizedSymbol),
        bracket_stop_loss_order_type: 'market_order',
        bracket_stop_loss_price: String(stop),
        bracket_take_profit_order_type: 'market_order',
        bracket_take_profit_price: String(target),
        bracket_stop_trigger_method: 'mark_price',
        bracket_take_profit_trigger_method: 'mark_price'
      };
      return submitOrder(product, body, { strategy, role: 'ENTRY' });
    });
  }

  async function closePosition(symbol, qty) {
    return withSymbolLock(symbol, async () => {
      const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
      const quantity = numberOrNull(qty);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('qty must be a positive whole number of contracts');
      await assertSafety(normalizedSymbol, 'EXIT');
      const positions = await getOpenPositions();
      const position = positions.find(row => row.symbol === normalizedSymbol);
      if (!position) throw new Error('No open Delta Testnet position exists for ' + normalizedSymbol);
      if (quantity > position.qty) throw new Error('Close quantity exceeds the open position quantity');
      const product = await resolveProduct(normalizedSymbol);
      const orders = await getOpenOrders();
      const matchingOrders = orders.filter(row =>
        stringOrEmpty(row?.product_symbol || row?.symbol).toUpperCase() === normalizedSymbol
      );
      for (const order of matchingOrders) {
        const id = numberOrNull(order?.id);
        if (id === null) throw new Error('Cannot safely cancel an open order without its exchange order id');
        await request('DELETE', '/v2/orders', {}, { id });
      }
      return submitOrder(product, {
        product_id: product.id,
        size: quantity,
        side: position.side === 'BUY' ? 'sell' : 'buy',
        order_type: 'market_order',
        reduce_only: true,
        client_order_id: buildClientOrderId(null, 'DDX-X', normalizedSymbol)
      }, { strategy: 'MOMENTUM', role: 'EXIT', reserve: false });
    });
  }

  return Object.freeze({
    placeOrder,
    placeBracketOrder,
    closePosition,
    getOpenPositions,
    getOpenOrders,
    getAccountSnapshot,
    assertConfigured
  });
}

export const deltaExecutor = createDeltaExecutor();
export const placeOrder = (...args) => deltaExecutor.placeOrder(...args);
export const placeBracketOrder = (...args) => deltaExecutor.placeBracketOrder(...args);
export const closePosition = (...args) => deltaExecutor.closePosition(...args);
export const getOpenPositions = (...args) => deltaExecutor.getOpenPositions(...args);
