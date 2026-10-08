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
    this.base = CONFIG.restBase;
    this.apiKey = CONFIG.apiKey;
    this.apiSecret = CONFIG.apiSecret;
    this.privateAuthConfigured = !!this.apiKey && !!this.apiSecret;
    // In Tradetron bridge mode the worker needs only public Delta market data;
    // Tradetron owns authenticated order/position execution. Keep private
    // methods fail-closed if called accidentally without credentials.
    if (!CONFIG.tradetronBridgeEnabled && !this.privateAuthConfigured) {
      throw new Error('Delta TESTNET API credentials are missing');
    }
    this.offsetMs = 0;
    this.queue = Promise.resolve();
    this.lastStatus = 0;
  }
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
  async request(method, path, params, body, auth) {
    if (auth && !this.privateAuthConfigured) {
      throw new Error('Delta private API unavailable while Tradetron bridge mode is enabled');
    }
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
          body: body === undefined || body === null ? undefined : payload
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
        if (response.ok && data && data.success !== false) return data.result;
        if (response.status === 429 || response.status >= 500) {
          const reset = Number(response.headers.get('x-rate-limit-reset') || 0);
          const wait = reset > 0 ? Math.min(30000, reset) : Math.min(10000, 500 * Math.pow(2, attempt));
          await sleep(wait);
          continue;
        }
        const apiErrorCode = String((data && data.error && data.error.code) || '');
        const apiErrorMessage = String((data && data.error && (data.error.message || data.error.code)) || ('HTTP_' + response.status));
        const err = new Error(apiErrorMessage);
        err.code = apiErrorCode || 'http_error';
        err.status = response.status;
        err.details = data;
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
  products() { return this.request('GET', '/v2/products', { contract_types: 'perpetual_futures', states: 'live', page_size: 50 }, null, false); }
  tickers() { return this.request('GET', '/v2/tickers', { contract_types: 'perpetual_futures' }, null, false); }
  optionTickers(underlying) {
    const asset = String(underlying || '').trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(asset)) throw new Error('Invalid option underlying');
    return this.request('GET', '/v2/tickers', {
      contract_types: 'call_options,put_options',
      underlying_asset_symbols: asset
    }, null, false);
  }
  candles(symbol, resolution, limit) {
    const seconds = ({ '1m': 60, '5m': 300, '15m': 900 })[resolution] || 300;
    const end = Math.floor((Date.now() + this.offsetMs) / 1000);
    const start = end - seconds * ((limit || 120) + 3);
    return this.request('GET', '/v2/history/candles', { resolution, symbol, start, end }, null, false);
  }
  positions(identifier) {
    const raw = String(identifier ?? '').trim();
    if (!raw) return Promise.reject(Object.assign(new Error('Position lookup requires product_id or underlying_asset_symbol'), { code: 'bad_schema', status: 400 }));
    let params;
    if (/^\\d+$/.test(raw)) {
      params = { product_id: Number(raw) };
    } else {
      const parts = raw.split('-');
      const underlying = parts.length >= 2 && /^[CP]$/.test(parts[0]) ? parts[1] : raw.replace(/USD$/i, '');
      if (!/^[A-Z0-9]+$/i.test(underlying)) {
        return Promise.reject(Object.assign(new Error('Invalid position lookup identifier'), { code: 'bad_schema', status: 400 }));
      }
      params = { underlying_asset_symbol: underlying.toUpperCase() };
    }
    return this.request('GET', '/v2/positions', params, null, true);
  }
  marginedPositions(contractTypes = 'perpetual_futures,call_options,put_options') {
    return this.request('GET', '/v2/positions/margined', { contract_types: contractTypes }, null, true);
  }
  openOrders(contractTypes = 'perpetual_futures,call_options,put_options') {
    return this.request('GET', '/v2/orders', { contract_types: contractTypes, state: 'open', page_size: 100 }, null, true);
  }
  historyOrders(contractTypes = 'perpetual_futures,call_options,put_options') {
    return this.request('GET', '/v2/orders/history', { contract_types: contractTypes, page_size: 100 }, null, true);
  }
  clientOrder(clientId) { return this.request('GET', '/v2/orders/client_order_id/' + encodeURIComponent(clientId), {}, null, true); }
  fills(contractTypes = 'perpetual_futures,call_options,put_options') {
    return this.request('GET', '/v2/fills', { contract_types: contractTypes, page_size: 100 }, null, true);
  }
  wallet() { return this.request('GET', '/v2/wallet/balances', {}, null, true); }
  heartbeatCreate(body) { return this.request('POST', '/v2/heartbeat/create', {}, body, true); }
  heartbeat(body) { return this.request('POST', '/v2/heartbeat', {}, body, true); }
  placeOrder(body) { return this.request('POST', '/v2/orders', {}, body, true); }
  cancelOrder(body) { return this.request('DELETE', '/v2/orders', {}, body, true); }
  placeBracket(body) { return this.request('POST', '/v2/orders/bracket', {}, body, true); }
  editBracket(body) { return this.request('PUT', '/v2/orders/bracket', {}, body, true); }
  setOrderLeverage(productId, leverage) { return this.request('POST', '/v2/products/' + productId + '/orders/leverage', {}, { leverage }, true); }
}