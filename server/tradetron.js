import { CONFIG } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = v => String(v ?? '').trim();

export class TradetronBridge {
  constructor() {
    this.enabled = CONFIG.tradetronBridgeEnabled;
    this.baseUrl = CONFIG.tradetronBaseUrl.replace(/\\/$/, '');
    this.authToken = clean(CONFIG.tradetronAuthToken);
    this.timeoutMs = Math.max(2000, Number(CONFIG.tradetronTimeoutMs) || 10000);
  }

  isConfigured() {
    return this.enabled && !!this.authToken;
  }

  async setRuntime(key, value) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(this.baseUrl + '/api');
      url.searchParams.set('auth-token', this.authToken);
      url.searchParams.set('key', key);
      url.searchParams.set('value', String(value));

      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/plain, application/json', 'user-agent': 'DealDost-DeltaScanner/2.0' },
        cache: 'no-store',
        signal: controller.signal
      });
      const body = (await response.text()).trim();
      if (!response.ok) throw new Error('Tradetron API ' + response.status + ': ' + body.slice(0, 240));
      return { ok: true, body: body.slice(0, 240) };
    } finally {
      clearTimeout(timer);
    }
  }

  async emitEntry({ symbol, side, qty, entryPrice, sl, tp, executionId }) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }

    const selected = clean(symbol).toUpperCase();
    if (!['BTCUSD', 'ETHUSD'].includes(selected)) {
      throw new Error('Tradetron bridge symbol not allowed: ' + selected);
    }

    const normalizedSide = clean(side).toUpperCase();
    if (!['BUY', 'SELL'].includes(normalizedSide)) {
      throw new Error('Tradetron bridge side must be BUY or SELL');
    }

    const quantity = Math.max(1, Math.floor(Number(qty) || 0));
    if (!Number.isFinite(Number(entryPrice)) || !Number.isFinite(Number(sl)) || !Number.isFinite(Number(tp)) || quantity < 1) {
      throw new Error('Tradetron bridge entry payload is invalid');
    }

    const other = selected === 'BTCUSD' ? 'ETHUSD' : 'BTCUSD';

    // The Signal Bridge strategy exposes these runtime variables. Set the
    // selector and entry parameters first, then fire the API entry variable.
    const writes = [
      [selected, 1],
      [other, 0],
      [selected + '_qty', quantity],
      [selected + '_ep', Number(entryPrice)],
      [selected + '_sl', Number(sl)],
      [selected + '_tp', Number(tp)]
    ];

    const responses = [];
    for (const [key, value] of writes) {
      responses.push([key, await this.setRuntime(key, value)]);
      await sleep(120);
    }

    const triggerKey = normalizedSide === 'BUY' ? 'api_buy' : 'api_sell';
    responses.push([triggerKey, await this.setRuntime(triggerKey, 1)]);

    return {
      ok: responses.every(([, r]) => r?.ok),
      symbol: selected,
      side: normalizedSide,
      qty: quantity,
      executionId: clean(executionId),
      triggerKey,
      responses: responses.map(([key, result]) => ({ key, ok: !!result?.ok, skipped: !!result?.skipped, body: result?.body || undefined }))
    };
  }
}
