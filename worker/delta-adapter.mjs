import crypto from 'node:crypto';
import { CONFIG } from '../server/config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function encodeQuery(params) {
  const pairs = [];
  for (const key of Object.keys(params || {}).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}
function bodyText(body) {
  return body === undefined || body === null ? '' : JSON.stringify(body);
}
function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

export class DeltaAdapter {
  constructor() {
    if (CONFIG.environment !== 'TESTNET') throw new Error('Production adapter disabled');
    if (!CONFIG.scanOnly && (!CONFIG.apiKey || !CONFIG.apiSecret)) throw new Error('Delta TESTNET API credentials are missing');
    this.base = CONFIG.restBase;
    this.apiKey = CONFIG.apiKey;
    this.apiSecret = CONFIG.apiSecret;
    this.offsetMs = 0;
    this.queue = Promise.resolve();
    this.lastStatus = 0;
  }
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
  async request(method, path, params, body, auth, withMeta = false) {
    if (auth && CONFIG.scanOnly) throw Object.assign(new Error('SCAN_ONLY_AUTH_DISABLED'), { code: 'scan_only_auth_disabled' });
    const execute = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const query = encodeQuery(params);
        const payload = bodyText(body);
        const ts = String(Math.floor((Date.now() + this.offsetMs) / 1000));
        const signature = auth ? hmac(this.apiSecret, method + ts + path + query + payload) : '';
        const headers = {
          Accept: 'application/json',
          'User-Agent': 'DealDost-Delta-India/2.0'
        };
        if (auth) {
          headers['api-key'] = this.apiKey;
          headers.signature = signature;
          headers.timestamp = ts;
        }
        if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
        const response = await fetch(this.base + path + query, {
          method,
          headers,
          body: body === undefined || body === null ? undefined : payload,
          signal: AbortSignal.timeout(15000)
        });
        this.lastStatus = response.status;
        const serverDate = response.headers.get('date');
        if (serverDate) {
          const parsed = Date.parse(serverDate);
          if (Number.isFinite(parsed)) this.offsetMs = parsed - Date.now();
        }
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (response.ok && data && data.success !== false) {
          return withMeta
            ? { result: data.result, meta: data.meta || {}, date: response.headers.get('date') }
            : data.result;
        }
        if (response.status === 429 || response.status >= 500) {
          const reset = Number(response.headers.get('x-rate-limit-reset') || 0);
          const wait = reset > 0 ? Math.min(30000, reset) : Math.min(10000, 500 * Math.pow(2, attempt));
          await sleep(wait);
          continue;
        }
        const err = new Error((data && data.error && (data.error.message || data.error.code)) || ('HTTP_' + response.status));
        err.code = String((data && data.error && data.error.code) || 'http_error');
        err.status = response.status;
        err.details = data;
        err.clientIp = response.headers.get('x-client-ip') || response.headers.get('x-forwarded-for') || null;
        throw err;
      }
      const err = new Error('rate_limit_or_server_retry_exhausted');
      err.code = 'retry_exhausted';
      err.status = 503;
      throw err;
    };
    if (auth || method !== 'GET') return this.enqueue(execute);
    return execute();
  }
  async health() { return this.request('GET', '/v2/tickers', { contract_types: 'perpetual_futures' }, null, false); }
  async products() {
    const rows = [];
    let after = '';
    for (let page = 0; page < 10; page++) {
      const response = await this.request('GET', '/v2/products', {
        contract_types: 'perpetual_futures', states: 'live', page_size: 100, after
      }, null, false, true);
      rows.push(...(Array.isArray(response?.result) ? response.result : []));
      const next = String(response?.meta?.after || '').trim();
      if (!next || next === after) break;
      after = next;
    }
    return rows;
  }
  tickers() { return this.request('GET', '/v2/tickers', { contract_types: 'perpetual_futures' }, null, false); }
  candles(symbol, resolution, limit) {
    const seconds = ({ '1m': 60, '5m': 300, '15m': 900 })[resolution] || 300;
    const end = Math.floor((Date.now() + this.offsetMs) / 1000);
    const start = end - seconds * ((limit || 120) + 3);
    return this.request('GET', '/v2/history/candles', { resolution, symbol, start, end }, null, false);
  }
  positions() { return this.request('GET', '/v2/positions', { contract_types: 'perpetual_futures' }, null, true); }
  marginedPositions() { return this.request('GET', '/v2/positions/margined', { contract_types: 'perpetual_futures' }, null, true); }
  openOrders() { return this.request('GET', '/v2/orders', { contract_types: 'perpetual_futures', state: 'open', page_size: 100 }, null, true); }
  historyOrders() { return this.request('GET', '/v2/orders/history', { contract_types: 'perpetual_futures', page_size: 100 }, null, true); }
  clientOrder(clientId) { return this.request('GET', '/v2/orders/client_order_id/' + encodeURIComponent(clientId), {}, null, true); }
  fills() { return this.request('GET', '/v2/fills', { contract_types: 'perpetual_futures', page_size: 100 }, null, true); }
  wallet() { return this.request('GET', '/v2/wallet/balances', {}, null, true); }
  heartbeatCreate(body) { return this.request('POST', '/v2/heartbeat/create', {}, body, true); }
  heartbeat(body) { return this.request('POST', '/v2/heartbeat', {}, body, true); }
  placeOrder(body) { return this.request('POST', '/v2/orders', {}, body, true); }
  cancelOrder(body) { return this.request('DELETE', '/v2/orders', {}, body, true); }
  placeBracket(body) { return this.request('POST', '/v2/orders/bracket', {}, body, true); }
  editBracket(body) { return this.request('PUT', '/v2/orders/bracket', {}, body, true); }
  setOrderLeverage(productId, leverage) { return this.request('POST', '/v2/products/' + productId + '/orders/leverage', {}, { leverage }, true); }
}