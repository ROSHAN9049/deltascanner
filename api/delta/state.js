import crypto from 'node:crypto';
import { CONFIG } from '../../server/config.js';
import { count, select } from '../../server/db.js';
import { createEngineSessionCookie, hasEngineAccess, isEngineSessionValid } from '../../server/engine-session.js';
import { indiaDateKey } from '../../src/date-utils.js';

const REST_BASE = 'https://cdn-ind.testnet.deltaex.org';
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const text = value => String(value ?? '').trim();

function n(value) {
  if (value === undefined || value === null || value === '') return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
}
function encodeQuery(params = {}) {
  const pairs = Object.keys(params).sort()
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  return pairs.length ? '?' + pairs.join('&') : '';
}
function json(body) {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}
function settlementBalances(wallet) {
  const rows = Array.isArray(wallet?.result) ? wallet.result :
    Array.isArray(wallet?.result?.balances) ? wallet.result.balances : [];
  const currencies = new Set(['USD', 'USDT', 'USDC', 'INR']);
  return rows.filter(row => currencies.has(text(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase()));
}
function summarizeWallet(wallet) {
  const equityFields = [
    wallet?.meta?.net_equity, wallet?.meta?.equity, wallet?.meta?.total_equity,
    wallet?.result?.net_equity, wallet?.result?.equity, wallet?.result?.total_equity
  ];
  let equity = equityFields.map(n).find(value => value !== null && value > 0) ?? null;
  const balances = settlementBalances(wallet);
  if (equity === null && balances.length) {
    const total = balances.reduce((sum, row) =>
      sum + (n(row?.balance ?? row?.total_balance ?? row?.wallet_balance) ?? 0) + (n(row?.unrealized_pnl) ?? 0), 0);
    if (total > 0) equity = total;
  }
  const availableFields = [
    wallet?.meta?.available_balance, wallet?.meta?.available_margin, wallet?.meta?.available_margin_balance,
    wallet?.result?.available_balance, wallet?.result?.available_margin, wallet?.result?.available_margin_balance
  ];
  let availableMargin = availableFields.map(n).find(value => value !== null && value >= 0) ?? null;
  if (availableMargin === null && balances.some(row => n(row?.available_balance) !== null)) {
    availableMargin = balances.reduce((sum, row) => sum + (n(row?.available_balance) ?? 0), 0);
  }
  return { equity, availableMargin };
}

function createDeltaApi() {
  const mode = text(process.env.DELTA_EXECUTION_MODE || 'disabled').toLowerCase();
  if (mode !== 'testnet') return { mode, apiStatus: 'DISABLED', apiError: null, fetchSnapshot: null };

  const configuredBase = text(process.env.DELTA_TESTNET_REST_BASE);
  if (configuredBase && configuredBase.replace(/\/+$/, '') !== REST_BASE) {
    return { mode, apiStatus: 'ERROR', apiError: 'REST endpoint must be the hardcoded Delta India Testnet URL.', fetchSnapshot: null };
  }
  const apiKey = text(process.env.DELTA_TESTNET_API_KEY);
  const apiSecret = text(process.env.DELTA_TESTNET_API_SECRET);
  if (!apiKey || !apiSecret) {
    return {
      mode, apiStatus: 'NOT_CONFIGURED',
      apiError: 'Add Delta Demo/Testnet credentials to the Vercel server environment to show live equity and order count.',
      fetchSnapshot: null
    };
  }

  async function request(method, path, params = {}, payload = null) {
    const query = encodeQuery(params);
    const body = payload === null || payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', apiSecret)
      .update(method + timestamp + path + query + body, 'utf8').digest('hex');
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'DealDost-Delta-Dashboard/1.0',
      'api-key': apiKey,
      signature,
      timestamp
    };
    if (payload !== null && payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(REST_BASE + path + query, {
      method,
      headers,
      body: payload === null || payload === undefined ? undefined : body,
      redirect: 'error',
      cache: 'no-store'
    });
    const data = json(await response.text());
    if (!response.ok || data?.success === false) {
      const reason = text(data?.error?.code || data?.error?.name) || 'request_failed';
      const error = new Error('Delta Testnet request failed (' + response.status + '): ' + reason);
      error.status = response.status;
      throw error;
    }
    return data || { success: true, result: null };
  }

  async function openOrdersCount() {
    const orders = new Map();
    for (const state of ['open', 'pending']) {
      let after = '';
      let priorAfter = '';
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await request('GET', '/v2/orders', {
          contract_types: 'perpetual_futures', state, page_size: PAGE_SIZE, after
        });
        const rows = Array.isArray(response.result) ? response.result : [];
        for (const row of rows) {
          const key = String(row?.id ?? row?.client_order_id ?? JSON.stringify(row));
          orders.set(key, row);
        }
        const nextAfter = text(response.meta?.after);
        if (!nextAfter || nextAfter === after || nextAfter === priorAfter || rows.length === 0) break;
        priorAfter = after;
        after = nextAfter;
      }
    }
    return orders.size;
  }
  async function fetchSnapshot() {
    const [wallet, openOrders] = await Promise.all([
      request('GET', '/v2/wallet/balances'),
      openOrdersCount()
    ]);
    return { account: summarizeWallet(wallet), openOrders };
  }
  return { mode, apiStatus: 'OK', apiError: null, fetchSnapshot };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (CONFIG.engineSecret && isEngineSessionValid(req, CONFIG.engineSecret)) {
    res.setHeader('Set-Cookie', createEngineSessionCookie(CONFIG.engineSecret));
  }
  const authorized = Boolean(CONFIG.engineSecret) && hasEngineAccess(req, CONFIG.engineSecret);
  if (!authorized) return res.status(401).json({ success: false, protected: true, error: 'Private Delta account data is locked.' });

  try {
    const now = new Date();
    const indiaStart = indiaDateKey(now) + 'T00:00:00+05:30';
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [openRows, closedTodayRows, signals24hCount] = await Promise.all([
      select('dd_delta_positions', 'status=eq.OPEN&order=opened_at.desc&limit=500'),
      select('dd_delta_positions', 'status=eq.CLOSED&closed_at=gte.' + encodeURIComponent(indiaStart) + '&select=realized_pnl,closed_at&order=closed_at.desc&limit=10000'),
      count('dd_signals', 'captured_at=gte.' + encodeURIComponent(last24Hours) + '&select=id').catch(error => {
        console.error('[api/delta/state] 24h signal count unavailable:', error.message);
        return null;
      })
    ]);

    const positions = Array.isArray(openRows) ? openRows.filter(row => Number(row?.qty) > 0) : [];
    const realizedValues = (Array.isArray(closedTodayRows) ? closedTodayRows : []).map(row => n(row?.realized_pnl));
    const realizedComplete = realizedValues.every(value => value !== null);
    const realizedToday = realizedComplete ? realizedValues.reduce((sum, value) => sum + value, 0) : null;
    const unrealizedValues = positions.map(row => n(row?.unrealized_pnl));
    const unrealizedComplete = unrealizedValues.every(value => value !== null);
    const unrealizedOpen = unrealizedComplete ? unrealizedValues.reduce((sum, value) => sum + value, 0) : null;
    const todayPnl = realizedToday !== null && unrealizedOpen !== null ? realizedToday + unrealizedOpen : null;

    const deltaApi = createDeltaApi();
    let liveApiStatus = deltaApi.apiStatus;
    let liveApiError = deltaApi.apiError;
    let account = { equity: null, availableMargin: null };
    let openOrders = null;
    let liveApiFetchedAt = null;
    if (deltaApi.fetchSnapshot) {
      try {
        const snapshot = await deltaApi.fetchSnapshot();
        account = snapshot.account;
        openOrders = snapshot.openOrders;
        liveApiStatus = account.equity === null ? 'INCOMPLETE' : 'OK';
        liveApiError = account.equity === null ? 'Account equity was not present in the Delta Testnet wallet response.' : null;
        liveApiFetchedAt = new Date().toISOString();
      } catch (error) {
        liveApiStatus = 'ERROR';
        liveApiError = text(error?.message || error).slice(0, 220);
      }
    }

    return res.status(200).json({
      success: true,
      mode: deltaApi.mode,
      directOrderExecutionEnabled: deltaApi.mode === 'testnet',
      liveApiStatus,
      liveApiError,
      liveApiFetchedAt,
      account,
      openOrders: { count: openOrders, source: 'delta-testnet-api' },
      openPositions: { count: positions.length, rows: positions, source: 'dd_delta_positions' },
      pnl: {
        realizedToday,
        unrealizedOpen,
        totalToday: todayPnl,
        realizedComplete,
        unrealizedComplete,
        source: 'dd_delta_positions'
      },
      signals24h: { count: signals24hCount, source: 'dd_signals', windowHours: 24 },
      capturedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[api/delta/state] Request failed:', text(error?.message || error));
    return res.status(503).json({ success: false, error: 'Delta dashboard data is temporarily unavailable.' });
  }
}
