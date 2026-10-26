#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DELTA_TESTNET_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
const REQUEST_TIMEOUT_MS = 20_000;
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_POLL_MS = 2_000;

const text = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function assertTestnetOnly(env = process.env) {
  const mode = text(env.DELTA_EXECUTION_MODE).toLowerCase();
  if (mode !== 'testnet') {
    throw new Error('FORCE CLOSE REFUSED: DELTA_EXECUTION_MODE must be exactly testnet. No requests or orders were sent.');
  }
  const configuredBase = text(env.DELTA_TESTNET_REST_BASE || DELTA_TESTNET_REST_BASE).replace(/\/+$/, '');
  if (configuredBase !== DELTA_TESTNET_REST_BASE) {
    throw new Error('FORCE CLOSE REFUSED: endpoint must be the hardcoded Delta Testnet host. No requests or orders were sent.');
  }
  if (DELTA_TESTNET_REST_BASE !== 'https://cdn-ind.testnet.deltaex.org') {
    throw new Error('FORCE CLOSE REFUSED: hardcoded Testnet endpoint guard failed.');
  }
  const apiKey = text(env.DELTA_TESTNET_API_KEY);
  const apiSecret = text(env.DELTA_TESTNET_API_SECRET);
  if (!apiKey || !apiSecret) {
    throw new Error('FORCE CLOSE REFUSED: DELTA_TESTNET_API_KEY and DELTA_TESTNET_API_SECRET are required.');
  }
  return { apiKey, apiSecret };
}

function encodeQuery(params = {}) {
  const pairs = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}

export function normalizeOpenPosition(row) {
  const symbol = text(row?.product_symbol || row?.symbol).toUpperCase();
  const signedValue = row?.size ?? row?.signed_size;
  const quantityValue = signedValue ?? row?.qty ?? row?.quantity;
  const rawSize = numberOrNull(quantityValue);
  if (!symbol || rawSize === null) {
    throw new Error('Delta Testnet returned a malformed position row; refusing to submit any close orders.');
  }

  if (rawSize === 0) return null;

  const hasSignedSize = signedValue !== null && signedValue !== undefined && signedValue !== '';
  let direction;
  if (hasSignedSize) {
    direction = rawSize < 0 ? 'SHORT' : 'LONG';
  } else {
    direction = text(row?.position_side || row?.side || row?.direction).toUpperCase();
    if (['BUY', 'LONG'].includes(direction)) direction = 'LONG';
    else if (['SELL', 'SHORT'].includes(direction)) direction = 'SHORT';
    else {
      throw new Error('Delta Testnet position ' + symbol + ' has unsigned quantity and no reliable side; refusing to submit any close orders.');
    }
  }

  const qty = Math.abs(rawSize);
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new Error('Delta Testnet position ' + symbol + ' has a non-integer contract quantity; refusing to round.');
  }

  const productId = numberOrNull(row?.product_id ?? row?.productId);
  return {
    symbol,
    qty,
    direction,
    closeSide: direction === 'LONG' ? 'sell' : 'buy',
    productId: Number.isSafeInteger(productId) && productId > 0 ? productId : null
  };
}

export function createTestnetClient({ env = process.env, fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const credentials = assertTestnetOnly(env);

  async function request(method, endpointPath, params = {}, body = null) {
    // Every request is pinned to the hardcoded Demo/Testnet host. No env-provided URL is used.
    const query = encodeQuery(params);
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = crypto.createHmac('sha256', credentials.apiSecret)
      .update(method + timestamp + endpointPath + query + payload, 'utf8')
      .digest('hex');
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'Delta-Testnet-Force-Close/1.0',
      'api-key': credentials.apiKey,
      signature,
      timestamp
    };
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

    // Never retry POSTs: after a timeout, acceptance may be ambiguous.
    const response = await fetchImpl(DELTA_TESTNET_REST_BASE + endpointPath + query, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || data?.success === false) {
      const code = text(data?.error?.code || data?.error?.name);
      const reason = text(data?.error?.message || data?.error?.code || data?.message);
      const error = new Error('Delta Testnet ' + method + ' ' + endpointPath + ' failed (' +
        response.status + '): ' + (code || reason || 'request_failed'));
      error.status = response.status;
      error.code = code || 'delta_testnet_request_failed';
      throw error;
    }
    return data;
  }

  async function getOpenPositions() {
    const response = await request('GET', '/v2/positions/margined', {
      contract_types: 'perpetual_futures'
    });
    if (!Array.isArray(response?.result)) {
      throw new Error('Delta Testnet open-position response is malformed; refusing to treat it as an empty account.');
    }

    const positions = response.result
      .map(normalizeOpenPosition)
      .filter(position => position && position.qty > 0);
    const symbols = new Set();
    for (const position of positions) {
      if (symbols.has(position.symbol)) {
        throw new Error('Delta Testnet returned duplicate open rows for ' + position.symbol + '; refusing ambiguous close.');
      }
      symbols.add(position.symbol);
      if (!position.productId) {
        throw new Error('Delta Testnet did not return product_id for ' + position.symbol + '; refusing to guess a contract.');
      }
    }
    return positions;
  }

  async function placeReduceOnlyMarketClose(position) {
    const clientOrderId = ('FCL-' + position.symbol.slice(0, 12) + '-' + Math.floor(now() / 1000).toString(36)).slice(0, 32);
    const body = {
      product_id: position.productId,
      size: position.qty,
      side: position.closeSide,
      order_type: 'market_order',
      reduce_only: true,
      client_order_id: clientOrderId
    };
    // A single signed POST; there is intentionally no retry for ambiguous results.
    const response = await request('POST', '/v2/orders', {}, body);
    const order = response?.result ?? response;
    return {
      symbol: position.symbol,
      qty: position.qty,
      side: position.closeSide,
      reduce_only: body.reduce_only,
      client_order_id: clientOrderId,
      order_id: order?.id ?? null,
      state: text(order?.state || 'unknown').toUpperCase()
    };
  }

  return Object.freeze({ getOpenPositions, placeReduceOnlyMarketClose });
}

export async function runForceClose({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  sleepImpl = sleep,
  log = console.log,
  warn = console.warn,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  verifyPollMs = VERIFY_POLL_MS
} = {}) {
  const args = [...argv];
  if (args.some(arg => arg !== '--confirm')) {
    throw new Error('Unknown argument. Usage: node scripts/force-close-testnet-positions.mjs --confirm');
  }
  if (!args.includes('--confirm')) {
    throw new Error('No orders sent. To close positions on Delta Testnet, pass the explicit --confirm flag.');
  }

  const client = createTestnetClient({ env, fetchImpl, now });
  log('[ForceClose] TESTNET ONLY — endpoint=' + DELTA_TESTNET_REST_BASE);
  log('[ForceClose] Fetching all open perpetual positions...');

  // Validate the entire initial snapshot before sending any order.
  const before = await client.getOpenPositions();
  log('[ForceClose] Open positions found: ' + before.length);
  for (const position of before) {
    log('  - ' + position.symbol + ' ' + position.direction + ' qty=' + position.qty +
      ' product_id=' + position.productId);
  }

  const orderResults = [];
  const failures = [];

  for (const initialPosition of before) {
    try {
      // Refresh state for this symbol immediately before submitting, so a position
      // manually closed or changed after the initial snapshot is not acted on blindly.
      const currentPositions = await client.getOpenPositions();
      const current = currentPositions.find(position => position.symbol === initialPosition.symbol);
      if (!current) {
        log('[ForceClose] ' + initialPosition.symbol + ' is already closed; skipping.');
        continue;
      }

      const result = await client.placeReduceOnlyMarketClose(current);
      orderResults.push(result);
      log('[ForceClose] Close order submitted: ' + JSON.stringify(result));
    } catch (error) {
      const message = String(error?.message || error);
      failures.push({ symbol: initialPosition.symbol, error: message });
      warn('[ForceClose] ' + initialPosition.symbol + ' close failed: ' + message);
    }
  }

  // The margined endpoint can lag after a fill; poll, but do not resend ambiguous orders.
  const deadline = Date.now() + verifyTimeoutMs;
  let remaining = await client.getOpenPositions();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleepImpl(verifyPollMs);
    remaining = await client.getOpenPositions();
  }

  log('[ForceClose] Final verification: open positions=' + remaining.length);
  for (const position of remaining) {
    warn('  STILL OPEN: ' + position.symbol + ' ' + position.direction + ' qty=' + position.qty);
  }
  const summary = {
    endpoint: DELTA_TESTNET_REST_BASE,
    initialOpenPositions: before.length,
    closeOrdersSubmitted: orderResults.length,
    failures,
    remainingPositions: remaining,
    verifiedFlat: remaining.length === 0,
    orderResults
  };
  log('[ForceClose] Summary: ' + JSON.stringify({
    initialOpenPositions: summary.initialOpenPositions,
    closeOrdersSubmitted: summary.closeOrdersSubmitted,
    failures: summary.failures.length,
    remainingPositions: summary.remainingPositions.length,
    verifiedFlat: summary.verifiedFlat
  }));
  return summary;
}

async function main() {
  if (!process.argv.slice(2).includes('--confirm')) {
    console.error('No orders sent. Run once with: node scripts/force-close-testnet-positions.mjs --confirm');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runForceClose();
    if (!result.verifiedFlat || result.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error('[ForceClose] Failed safely: ' + String(error?.message || error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
