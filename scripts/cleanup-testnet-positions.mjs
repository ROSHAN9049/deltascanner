#!/usr/bin/env node
import crypto from 'node:crypto';

const REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_TIMEOUT_MS = 30000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (!['--audit', '--close', '--confirm'].includes(flag)) {
      throw new Error('Unknown argument: ' + flag);
    }
  }
  if (flags.has('--audit') && flags.has('--close')) {
    throw new Error('Choose one mode: --audit or --close.');
  }
  if (flags.has('--confirm') && !flags.has('--close')) {
    throw new Error('--confirm is valid only with --close.');
  }
  if (flags.has('--close') && !flags.has('--confirm')) {
    throw new Error('Close mode requires BOTH --close and --confirm. No orders were sent.');
  }
  return { mode: flags.has('--close') ? 'close' : 'audit' };
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return String(value ?? '').trim();
}

function createClient() {
  const apiKey = text(process.env.DELTA_TESTNET_API_KEY);
  const apiSecret = text(process.env.DELTA_TESTNET_API_SECRET);
  if (!apiKey || !apiSecret) {
    throw new Error('Missing DELTA_TESTNET_API_KEY or DELTA_TESTNET_API_SECRET environment secret.');
  }

  async function request(method, path, params = {}, body = null) {
    const query = encodeQuery(params);
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', apiSecret)
      .update(method + timestamp + path + query + payload, 'utf8')
      .digest('hex');
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'DealDost-Delta-Testnet-Cleanup/1.0',
      'api-key': apiKey,
      signature,
      timestamp
    };
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

    // A POST is deliberately never retried: a timeout can leave order acceptance ambiguous.
    const response = await fetch(REST_BASE + path + query, {
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
      throw new Error('Delta Testnet ' + method + ' ' + path + ' failed (' +
        response.status + '): ' + (code || reason || 'request_failed'));
    }
    return data || { success: true, result: null };
  }

  return { request };
}

function rowsFrom(response) {
  if (Array.isArray(response?.result)) return response.result;
  if (Array.isArray(response?.result?.positions)) return response.result.positions;
  return [];
}

function normalizePosition(row) {
  const signedSource = row?.size ?? row?.signed_size;
  const sizeSource = signedSource ?? row?.qty ?? row?.quantity;
  const size = numberOrNull(sizeSource);
  const symbol = text(row?.product_symbol || row?.symbol).toUpperCase();
  if (!symbol || size === null || size === 0) return null;

  let side;
  if (signedSource !== null && signedSource !== undefined && signedSource !== '') {
    side = size < 0 ? 'SHORT' : 'LONG';
  } else {
    const explicitSide = text(row?.position_side || row?.side || row?.direction).toLowerCase();
    if (['short', 'sell'].includes(explicitSide)) side = 'SHORT';
    else if (['long', 'buy'].includes(explicitSide)) side = 'LONG';
    else {
      return { symbol, qty: Math.abs(size), side: 'UNKNOWN', productId: numberOrNull(row?.product_id ?? row?.productId), invalidReason: 'quantity is unsigned and no reliable side field was supplied', raw: row };
    }
  }

  return {
    symbol,
    qty: Math.abs(size),
    side,
    productId: numberOrNull(row?.product_id ?? row?.productId),
    entryPrice: numberOrNull(row?.entry_price),
    markPrice: numberOrNull(row?.mark_price ?? row?.current_price ?? row?.last_traded_price),
    unrealizedPnl: numberOrNull(row?.unrealized_pnl ?? row?.unrealizedPnl),
    raw: row
  };
}

function walletBalances(wallet) {
  if (Array.isArray(wallet?.result)) return wallet.result;
  if (Array.isArray(wallet?.result?.balances)) return wallet.result.balances;
  return [];
}

function accountMetrics(wallet) {
  const equityCandidates = [
    wallet?.meta?.net_equity, wallet?.meta?.equity, wallet?.meta?.total_equity,
    wallet?.result?.net_equity, wallet?.result?.equity, wallet?.result?.total_equity
  ].map(numberOrNull).filter(value => value !== null && value > 0);
  let equity = equityCandidates[0] ?? null;

  const settlement = new Set(['USD', 'USDT', 'USDC', 'INR']);
  const balances = walletBalances(wallet).filter(row =>
    settlement.has(text(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase()));
  if (equity === null && balances.length) {
    const numericBalances = balances.map(row => numberOrNull(row?.balance ?? row?.total_balance ?? row?.wallet_balance));
    if (numericBalances.every(value => value !== null)) {
      equity = balances.reduce((sum, row) =>
        sum + numberOrNull(row?.balance ?? row?.total_balance ?? row?.wallet_balance) +
          (numberOrNull(row?.unrealized_pnl) ?? 0), 0);
    }
  }

  const availableCandidates = [
    wallet?.meta?.available_margin, wallet?.meta?.available_balance,
    wallet?.result?.available_margin, wallet?.result?.available_balance
  ].map(numberOrNull).filter(value => value !== null && value >= 0);
  let available = availableCandidates[0] ?? null;
  if (available === null && balances.length) {
    const numericAvailable = balances.map(row => numberOrNull(row?.available_balance));
    if (numericAvailable.every(value => value !== null)) {
      available = numericAvailable.reduce((sum, value) => sum + value, 0);
    }
  }

  return {
    equity,
    available,
    blockedEstimate: equity !== null && available !== null ? equity - available : null
  };
}

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'UNAVAILABLE';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printAccount(label, metrics) {
  console.log('\n' + label);
  console.log('  Equity:          ' + money(metrics.equity));
  console.log('  Available margin:' + ' ' + money(metrics.available));
  console.log('  Equity - available margin (estimate): ' + money(metrics.blockedEstimate));
}

function printPositions(positions) {
  if (!positions.length) {
    console.log('  No open Delta Testnet perpetual positions.');
    return;
  }
  console.log('  ' + positions.length + ' open position(s):');
  for (const position of positions) {
    console.log('  - ' + position.symbol +
      ' | ' + position.side +
      ' | qty=' + position.qty +
      ' | entry=' + (position.entryPrice === null ? '—' : position.entryPrice) +
      ' | mark=' + (position.markPrice === null ? '—' : position.markPrice) +
      ' | unrealized P&L=' + (position.unrealizedPnl === null ? '—' : position.unrealizedPnl) +
      ' | product_id=' + (position.productId ?? 'UNAVAILABLE'));
    if (position.invalidReason) console.log('    SAFETY: ' + position.invalidReason);
  }
}

async function getPositions(client) {
  const response = await client.request('GET', '/v2/positions/margined', {
    contract_types: 'perpetual_futures'
  });
  return rowsFrom(response).map(normalizePosition).filter(position => position && position.qty > 0);
}

async function getOpenOrders(client) {
  const collected = [];
  for (const state of ['open', 'pending']) {
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 20; page++) {
      const response = await client.request('GET', '/v2/orders', {
        contract_types: 'perpetual_futures',
        state,
        page_size: 100,
        after
      });
      const pageRows = rowsFrom(response);
      collected.push(...pageRows);
      const nextAfter = text(response?.meta?.after);
      if (!nextAfter || nextAfter === after || nextAfter === previousAfter || pageRows.length === 0) break;
      previousAfter = after;
      after = nextAfter;
    }
  }
  const unique = new Map();
  for (const row of collected) unique.set(String(row?.id ?? row?.client_order_id ?? JSON.stringify(row)), row);
  return [...unique.values()];
}

async function getSnapshot(client) {
  const [wallet, positions, orders] = await Promise.all([
    client.request('GET', '/v2/wallet/balances'),
    getPositions(client),
    getOpenOrders(client)
  ]);
  return { wallet: accountMetrics(wallet), positions, orders };
}

async function getProductId(client, position, productsCache) {
  if (Number.isSafeInteger(position.productId) && position.productId > 0) return position.productId;
  let products = productsCache.value;
  if (!products) {
    products = [];
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 20; page++) {
      const response = await client.request('GET', '/v2/products', {
        contract_types: 'perpetual_futures',
        states: 'live',
        page_size: 100,
        after
      });
      const pageRows = rowsFrom(response);
      products.push(...pageRows);
      const nextAfter = text(response?.meta?.after);
      if (!nextAfter || nextAfter === after || nextAfter === previousAfter || pageRows.length === 0) break;
      previousAfter = after;
      after = nextAfter;
    }
    productsCache.value = products;
  }
  const match = products.find(row =>
    text(row?.symbol || row?.product_symbol).toUpperCase() === position.symbol);
  const productId = numberOrNull(match?.id ?? match?.product_id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new Error('Could not safely resolve a live Testnet product id for ' + position.symbol);
  }
  return productId;
}

async function closeOnePosition(client, position, currentOrders, productsCache) {
  if (!['LONG', 'SHORT'].includes(position.side)) {
    throw new Error(position.symbol + ': position side is ambiguous; refused to submit an order');
  }
  if (!Number.isSafeInteger(position.qty) || position.qty <= 0) {
    throw new Error(position.symbol + ': quantity is not a positive whole number of contracts; refused to round');
  }

  const matchingOrders = currentOrders.filter(order =>
    text(order?.product_symbol || order?.symbol).toUpperCase() === position.symbol ||
    (position.productId !== null && Number(order?.product_id) === position.productId));
  for (const order of matchingOrders) {
    const id = order?.id;
    if (id === null || id === undefined || id === '') {
      throw new Error(position.symbol + ': a same-symbol open order has no exchange id; cannot safely clear it before close');
    }
    await client.request('DELETE', '/v2/orders', {}, { id });
    console.log('  Cancelled same-symbol open order ' + id + ' for ' + position.symbol);
  }

  const productId = await getProductId(client, position, productsCache);
  const closeSide = position.side === 'LONG' ? 'sell' : 'buy';
  const clientOrderId = ('CLN-' + position.symbol.slice(0, 12) + '-' + Date.now().toString(36)).slice(0, 32);
  const body = {
    product_id: productId,
    size: position.qty,
    side: closeSide,
    order_type: 'market_order',
    reduce_only: true,
    client_order_id: clientOrderId
  };
  const response = await client.request('POST', '/v2/orders', {}, body);
  const order = response?.result ?? response;
  console.log('  Close order accepted for ' + position.symbol +
    ' | side=' + closeSide.toUpperCase() +
    ' | qty=' + position.qty +
    ' | reduce_only=true' +
    ' | exchange order id=' + (order?.id ?? 'not returned') +
    ' | state=' + text(order?.state || 'unknown').toUpperCase());
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  const client = createClient();
  console.log('Delta India TESTNET cleanup');
  console.log('Endpoint: ' + REST_BASE);
  console.log('Mode: ' + (mode === 'close' ? 'CLOSE (explicitly confirmed)' : 'AUDIT ONLY (no orders will be placed)'));
  const before = await getSnapshot(client);
  printAccount('BEFORE', before.wallet);
  console.log('\nOpen positions before action:');
  printPositions(before.positions);
  console.log('Open/pending exchange orders: ' + before.orders.length);

  if (mode === 'close') {
    if (!before.positions.length) {
      console.log('\nNo open positions found; no close orders were submitted.');
    } else {
      const productsCache = { value: null };
      const failures = [];
      for (const position of before.positions) {
        console.log('\nClosing ' + position.symbol + '...');
        try {
          // Re-read orders for each position, so a prior cancellation is not repeated.
          const currentOrders = await getOpenOrders(client);
          await closeOnePosition(client, position, currentOrders, productsCache);
        } catch (error) {
          failures.push(position.symbol + ': ' + String(error?.message || error));
          console.error('  FAILED: ' + String(error?.message || error));
        }
      }

      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      let remaining = await getPositions(client);
      while (remaining.length && Date.now() < deadline) {
        await sleep(2000);
        remaining = await getPositions(client);
      }
      if (failures.length) {
        console.error('\nClose operation errors:');
        for (const failure of failures) console.error('  - ' + failure);
      }
      if (remaining.length) {
        console.error('\nVerification timed out with position(s) still open:');
        printPositions(remaining);
      }
    }
  } else {
    console.log('\nAUDIT ONLY: no cancel, close, or other order mutations were sent.');
  }

  const after = await getSnapshot(client);
  printAccount(mode === 'audit' ? 'AFTER (audit-only recheck)' : 'AFTER (post-close verification)', after.wallet);
  console.log('\nOpen positions after action:');
  printPositions(after.positions);
  console.log('Open/pending exchange orders after action: ' + after.orders.length);

  if (mode === 'close' && after.positions.length) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('\nCleanup failed safely: ' + String(error?.message || error));
  process.exitCode = 1;
});
