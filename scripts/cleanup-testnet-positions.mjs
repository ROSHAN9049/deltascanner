import crypto from 'node:crypto';
import { appendFileSync } from 'node:fs';

const REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
const POLL_MS = 1000;
const CONFIRM_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;

function parseArgs(argv) {
  const allowed = new Set(['--audit', '--close', '--confirm', '--action']);
  for (let i = 0; i < argv.length; i++) {
    if (!allowed.has(argv[i]) && !argv[i].startsWith('--action=')) throw new Error('Unknown argument: ' + argv[i]);
  }
  const hasAudit = argv.includes('--audit');
  const hasClose = argv.includes('--close');
  if (hasAudit && hasClose) throw new Error('Use either --audit or --close, not both.');
  const actionFlag = argv.find(arg => arg.startsWith('--action='));
  const actionIndex = argv.indexOf('--action');
  if (actionIndex >= 0 && actionFlag) throw new Error('Supply --action only once.');
  let action = hasClose ? 'close' : 'audit';
  if (actionFlag) action = actionFlag.slice('--action='.length);
  if (actionIndex >= 0) action = argv[actionIndex + 1] || '';
  if (!['audit', 'close'].includes(action)) throw new Error('Action must be audit or close.');
  if (hasAudit && action !== 'audit') throw new Error('Conflicting action flags.');
  if (hasClose && action !== 'close') throw new Error('Conflicting action flags.');
  return { action, confirmed: argv.includes('--confirm') };
}

const txt = value => String(value ?? '').trim();
function n(value) {
  if (value === null || value === undefined || value === '') return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
}
const fmt = (value, digits = 8) => value === null || value === undefined || !Number.isFinite(Number(value))
  ? 'unavailable' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });

function encodeQuery(params = {}) {
  const pairs = Object.keys(params).sort()
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  return pairs.length ? '?' + pairs.join('&') : '';
}
function parseJson(body) {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}
function getSettlementBalances(wallet) {
  const result = Array.isArray(wallet?.result) ? wallet.result :
    Array.isArray(wallet?.result?.balances) ? wallet.result.balances : [];
  const assets = new Set(['USD', 'USDT', 'USDC', 'INR']);
  return result.filter(row => assets.has(txt(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase()));
}
function walletSummary(wallet) {
  const directEquity = [
    wallet?.meta?.net_equity, wallet?.meta?.equity, wallet?.meta?.total_equity,
    wallet?.result?.net_equity, wallet?.result?.equity, wallet?.result?.total_equity
  ].map(n).find(value => value !== null && value > 0);
  let equity = directEquity ?? null;
  const balances = getSettlementBalances(wallet);
  if (equity === null && balances.length) {
    const candidate = balances.reduce((sum, row) =>
      sum + (n(row?.balance ?? row?.total_balance ?? row?.wallet_balance) ?? 0) + (n(row?.unrealized_pnl) ?? 0), 0);
    if (candidate > 0) equity = candidate;
  }
  const directAvailable = [
    wallet?.meta?.available_balance, wallet?.meta?.available_margin,
    wallet?.meta?.available_margin_balance, wallet?.result?.available_balance,
    wallet?.result?.available_margin, wallet?.result?.available_margin_balance
  ].map(n).find(value => value !== null && value >= 0);
  let availableMargin = directAvailable ?? null;
  if (availableMargin === null && balances.some(row => n(row?.available_balance) !== null)) {
    availableMargin = balances.reduce((sum, row) => sum + (n(row?.available_balance) ?? 0), 0);
  }
  return { equity, availableMargin };
}
function normalizePosition(row) {
  const signedSize = n(row?.size ?? row?.signed_size ?? row?.qty ?? row?.quantity);
  const symbol = txt(row?.product_symbol || row?.symbol).toUpperCase();
  if (!symbol || signedSize === null || signedSize === 0) return null;
  const rawSide = txt(row?.side || row?.position_side).toLowerCase();
  const side = ['sell', 'short'].includes(rawSide) ? 'SELL'
    : ['buy', 'long'].includes(rawSide) ? 'BUY'
      : signedSize < 0 ? 'SELL' : 'BUY';
  const marginUsed = [
    row?.margin_used, row?.position_margin, row?.initial_margin, row?.margin,
    row?.margin_required, row?.used_margin, row?.reserved_margin, row?.margin_locked
  ].map(n).find(value => value !== null && value >= 0) ?? null;
  return {
    symbol, side, qty: Math.abs(signedSize), signedSize,
    entryPrice: n(row?.entry_price ?? row?.average_entry_price ?? row?.entryPrice),
    markPrice: n(row?.mark_price ?? row?.current_price ?? row?.last_traded_price ?? row?.markPrice),
    unrealizedPnl: n(row?.unrealized_pnl ?? row?.unrealizedPnl),
    marginUsed,
    productId: n(row?.product_id ?? row?.productId)
  };
}
function stateLine(label, account, positions) {
  return label + ' | equity=' + fmt(account.equity, 2) + ' USD | available_margin=' +
    fmt(account.availableMargin, 2) + ' USD | total_open_positions=' + positions.length;
}
function positionLines(positions) {
  return positions.length ? positions.map(p =>
    '  - ' + p.symbol + ' | side=' + p.side + ' | qty=' + fmt(p.qty) +
    ' | entry_price=' + fmt(p.entryPrice) + ' | mark_price=' + fmt(p.markPrice) +
    ' | unrealized_pnl=' + fmt(p.unrealizedPnl, 4) + ' USD | margin_used=' + fmt(p.marginUsed, 4) + ' USD'
  ) : ['  (none)'];
}
function writeSummary(markdown) {
  const path = txt(process.env.GITHUB_STEP_SUMMARY);
  if (!path) return;
  try { appendFileSync(path, markdown + '\n', 'utf8'); }
  catch (error) { console.error('[summary] Unable to write GITHUB_STEP_SUMMARY:', error.message); }
}
function markdownTable(positions) {
  const header = '| Symbol | Side | Qty | Entry | Mark | Unrealized P&L (USD) | Margin used (USD) |\n|---|---|---:|---:|---:|---:|---:|';
  return header + '\n' + (positions.length ? positions.map(p =>
    '| ' + p.symbol + ' | ' + p.side + ' | ' + fmt(p.qty) + ' | ' + fmt(p.entryPrice) +
    ' | ' + fmt(p.markPrice) + ' | ' + fmt(p.unrealizedPnl, 4) + ' | ' + fmt(p.marginUsed, 4) + ' |'
  ).join('\n') : '| — | — | — | — | — | — | — |');
}

function createApi() {
  if (txt(process.env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet') {
    throw new Error('ABORTED: DELTA_EXECUTION_MODE must be exactly "testnet". No API requests were made.');
  }
  const configuredRest = txt(process.env.DELTA_TESTNET_REST_BASE);
  if (configuredRest && configuredRest.replace(/\/+$/, '') !== REST_BASE) {
    throw new Error('ABORTED: DELTA_TESTNET_REST_BASE must match the hardcoded Delta India Testnet URL.');
  }
  const apiKey = txt(process.env.DELTA_TESTNET_API_KEY);
  const apiSecret = txt(process.env.DELTA_TESTNET_API_SECRET);
  if (!apiKey || !apiSecret) throw new Error('DELTA_TESTNET_API_KEY and DELTA_TESTNET_API_SECRET are required.');
  async function request(method, path, params = {}, payload = null) {
    const query = encodeQuery(params);
    const body = payload === null || payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', apiSecret)
      .update(method + timestamp + path + query + body, 'utf8').digest('hex');
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'DealDost-Delta-Testnet-Cleanup/1.0',
      'api-key': apiKey, signature, timestamp
    };
    if (payload !== null && payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(REST_BASE + path + query, {
      method, headers, body: payload === null || payload === undefined ? undefined : body
    });
    const data = parseJson(await response.text());
    if (!response.ok || data?.success === false) {
      const reason = txt(data?.error?.code || data?.error?.name || data?.error?.message || data?.message) || 'request_failed';
      const error = new Error('Delta Testnet ' + method + ' ' + path + ' failed (HTTP ' + response.status + '): ' + reason);
      error.status = response.status;
      throw error;
    }
    return data || { success: true, result: null };
  }
  async function getPositions() {
    const response = await request('GET', '/v2/positions/margined', { contract_types: 'perpetual_futures' });
    return (Array.isArray(response.result) ? response.result : []).map(normalizePosition).filter(Boolean);
  }
  async function getWallet() { return request('GET', '/v2/wallet/balances'); }
  async function snapshot() {
    const [wallet, positions] = await Promise.all([getWallet(), getPositions()]);
    return { account: walletSummary(wallet), positions };
  }
  async function getOpenOrders(symbol) {
    const unique = new Map();
    for (const state of ['open', 'pending']) {
      let after = '';
      let previousAfter = '';
      for (let page = 0; page < 10; page++) {
        const response = await request('GET', '/v2/orders', {
          contract_types: 'perpetual_futures', state, page_size: PAGE_SIZE, after
        });
        const rows = Array.isArray(response.result) ? response.result : [];
        for (const row of rows) {
          if (txt(row?.product_symbol || row?.symbol).toUpperCase() !== symbol) continue;
          unique.set(String(row?.id ?? row?.client_order_id ?? JSON.stringify(row)), row);
        }
        const next = txt(response.meta?.after);
        if (!next || next === after || next === previousAfter || rows.length === 0) break;
        previousAfter = after;
        after = next;
      }
    }
    return [...unique.values()];
  }
  async function productId(position) {
    if (Number.isSafeInteger(position.productId) && position.productId > 0) return position.productId;
    let after = '';
    let previousAfter = '';
    for (let page = 0; page < 10; page++) {
      const response = await request('GET', '/v2/products', {
        contract_types: 'perpetual_futures', states: 'live', page_size: PAGE_SIZE, after
      });
      const rows = Array.isArray(response.result) ? response.result : [];
      const product = rows.find(row =>
        txt(row?.symbol || row?.product_symbol).toUpperCase() === position.symbol &&
        txt(row?.contract_type || 'perpetual_futures').toLowerCase().includes('perpetual'));
      const id = n(product?.id ?? product?.product_id);
      if (Number.isSafeInteger(id) && id > 0) return id;
      const next = txt(response.meta?.after);
      if (!next || next === after || next === previousAfter || rows.length === 0) break;
      previousAfter = after;
      after = next;
    }
    throw new Error('Unable to resolve Testnet product ID for ' + position.symbol + '; no close order was sent.');
  }
  async function closePosition(initialPosition, sequence) {
    const position = (await getPositions()).find(row => row.symbol === initialPosition.symbol);
    if (!position) {
      console.log('[close] ' + initialPosition.symbol + ' already flat; no order sent.');
      return { symbol: initialPosition.symbol, status: 'already-flat', orderId: null };
    }
    if (!Number.isSafeInteger(position.qty) || position.qty <= 0) {
      throw new Error(position.symbol + ' quantity is not a positive whole contract count (' + position.qty + '); refusing to guess.');
    }
    const orders = await getOpenOrders(position.symbol);
    const cancelled = [];
    for (const order of orders) {
      const id = n(order?.id ?? order?.order_id);
      if (id === null) throw new Error('Open order on ' + position.symbol + ' has no exchange ID; cannot safely close.');
      await request('DELETE', '/v2/orders', {}, { id });
      cancelled.push(String(id));
    }
    const id = await productId(position);
    const side = position.side === 'BUY' ? 'sell' : 'buy';
    const clientId = ('DDX-CLEAN-' + position.symbol.slice(0, 10) + '-' + Date.now().toString(36) + '-' + sequence.toString(36)).slice(0, 32);
    const response = await request('POST', '/v2/orders', {}, {
      product_id: id, size: position.qty, side,
      order_type: 'market_order', reduce_only: true, client_order_id: clientId
    });
    const order = response.result ?? response;
    if (!order || typeof order !== 'object' || !(order.id || order.client_order_id || order.state)) {
      throw new Error('No valid order acknowledgement returned for ' + position.symbol + '; check exchange state before retrying.');
    }
    console.log('[close] reduce-only market close submitted: ' + position.symbol + ' qty=' + position.qty +
      ' side=' + side + ' order=' + txt(order.id || order.client_order_id || 'unavailable') +
      ' canceled_open_orders=' + cancelled.length);
    const started = Date.now();
    while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      if (!(await getPositions()).some(row => row.symbol === position.symbol)) {
        console.log('[close] REST confirmed ' + position.symbol + ' is flat.');
        return { symbol: position.symbol, status: 'closed-confirmed', orderId: order.id ?? null };
      }
    }
    throw new Error('Timed out waiting for REST to confirm ' + position.symbol + ' flat. The close request was already submitted; do not blindly retry.');
  }
  return { snapshot, closePosition };
}

async function main() {
  const { action, confirmed } = parseArgs(process.argv.slice(2));
  const api = createApi();
  if (action === 'close' && !confirmed) throw new Error('DESTRUCTIVE ACTION BLOCKED: --close requires --confirm. No orders were sent.');

  console.log('Delta India Testnet positions cleanup');
  console.log('REST endpoint: ' + REST_BASE);
  console.log('Mode: ' + action.toUpperCase() + (action === 'close' ? ' (confirmed)' : ' (read-only)'));
  const before = await api.snapshot();
  console.log('\n' + stateLine('BEFORE', before.account, before.positions));
  console.log('Positions:');
  for (const line of positionLines(before.positions)) console.log(line);

  if (action === 'close' && before.positions.length) {
    if (before.account.equity === null || before.account.availableMargin === null) {
      throw new Error('Equity or available margin could not be read; refusing destructive cleanup.');
    }
    console.log('\nCLOSE ACTION: only the initial position snapshot is targeted. Newly appearing positions will be reported in final verification.');
    const results = [];
    const errors = [];
    for (let i = 0; i < before.positions.length; i++) {
      const position = before.positions[i];
      try { results.push(await api.closePosition(position, i + 1)); }
      catch (error) {
        errors.push({ symbol: position.symbol, error: error.message });
        console.error('[close] ' + position.symbol + ' FAILED: ' + error.message);
      }
    }
    console.log('\nClose results:');
    for (const result of results) console.log('  - ' + result.symbol + ': ' + result.status + (result.orderId ? ' (order ' + result.orderId + ')' : ''));
    for (const item of errors) console.log('  - ' + item.symbol + ': FAILED — ' + item.error);
    const after = await api.snapshot();
    console.log('\n' + stateLine('AFTER', after.account, after.positions));
    console.log('Remaining positions:');
    for (const line of positionLines(after.positions)) console.log(line);
    const success = after.positions.length === 0 && errors.length === 0;
    writeSummary([
      '# Delta Testnet cleanup summary', '',
      '- Action: **CLOSE**',
      '- Endpoint: ' + REST_BASE,
      '- Before: equity **' + fmt(before.account.equity, 2) + ' USD**, available margin **' + fmt(before.account.availableMargin, 2) + ' USD**, open positions **' + before.positions.length + '**',
      '- Confirmed closes/already-flat: **' + results.filter(row => ['closed-confirmed', 'already-flat'].includes(row.status)).length + '**',
      '- Close errors: **' + errors.length + '**',
      '- After: equity **' + fmt(after.account.equity, 2) + ' USD**, available margin **' + fmt(after.account.availableMargin, 2) + ' USD**, open positions **' + after.positions.length + '**',
      '', markdownTable(before.positions), '',
      success ? '**Result: SUCCESS — Delta Testnet reports zero open positions.**' : '**Result: INCOMPLETE — inspect workflow logs and remaining positions before retrying.**'
    ].join('\n'));
    if (!success) process.exitCode = 1;
    return;
  }

  const after = await api.snapshot();
  console.log('\n' + stateLine('AFTER (no changes made)', after.account, after.positions));
  console.log('Positions:');
  for (const line of positionLines(after.positions)) console.log(line);
  if (action === 'audit') {
    console.log('\nAUDIT COMPLETE: read-only. No orders were submitted or cancelled.');
    console.log('To close them, run the workflow with action=close and enter CONFIRM.');
  }
  writeSummary([
    '# Delta Testnet cleanup summary', '',
    '- Action: **' + action.toUpperCase() + '**',
    '- Endpoint: ' + REST_BASE,
    '- Before: equity **' + fmt(before.account.equity, 2) + ' USD**, available margin **' + fmt(before.account.availableMargin, 2) + ' USD**, open positions **' + before.positions.length + '**',
    '- After: equity **' + fmt(after.account.equity, 2) + ' USD**, available margin **' + fmt(after.account.availableMargin, 2) + ' USD**, open positions **' + after.positions.length + '**',
    '', markdownTable(before.positions), '',
    '**Result: ' + (action === 'audit' ? 'AUDIT ONLY — no orders were submitted or cancelled.' : 'No positions were open.') + '**'
  ].join('\n'));
}
main().catch(error => {
  console.error('\nCLEANUP FAILED: ' + (error?.message || String(error)));
  writeSummary(['# Delta Testnet cleanup summary', '', '- Result: **FAILED**', '- Error: ' + String(error?.message || error).replace(/\|/g, '\\|')].join('\n'));
  process.exitCode = 1;
});
