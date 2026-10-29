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
    if (settingsRows[0].emergency_stop !== false) {
      throw new Error('Emergency Stop state is unknown; Delta Testnet execution is blocked');
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
      await assertSafety(normalizedSymbol, 'ENTRY');
      const product = await resolveProduct(normalizedSymbol);

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
      const body = {
        product_id: product.id,
        size: quantity,
        side: direction.toLowerCase(),
        order_type: 'market_order',
        client_order_id: buildClientOrderId(options?.clientOrderId, prefix, normalizedSymbol),
        bracket_stop_loss_price: String(stop),
        bracket_take_profit_price: String(target),
        bracket_stop_trigger_method: 'mark_price'
      };

      await logExecutor(
        'INFO',
        '[Executor] Preparing Testnet market bracket order',
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
      if (quantity !== position.qty) {
        throw new Error('Partial close is disabled in this phase to avoid cancelling protection for a remaining position');
      }
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
    getProductMetadata: resolveProduct,
    assertConfigured
  });
}

export const deltaExecutor = createDeltaExecutor();
export const placeOrder = (...args) => deltaExecutor.placeOrder(...args);
export const placeBracketOrder = (...args) => deltaExecutor.placeBracketOrder(...args);
export const closePosition = (...args) => deltaExecutor.closePosition(...args);
export const getOpenPositions = (...args) => deltaExecutor.getOpenPositions(...args);
