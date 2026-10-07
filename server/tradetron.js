import { CONFIG } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = v => String(v ?? '').trim();

export class TradetronBridge {
  constructor() {
    this.enabled = CONFIG.tradetronBridgeEnabled;
    this.baseUrl = CONFIG.tradetronBaseUrl.replace(/\/$/, '');
    this.authToken = clean(CONFIG.tradetronAuthToken);
    this.timeoutMs = Math.max(2000, Number(CONFIG.tradetronTimeoutMs) || 10000);
  }

  isConfigured() {
    return this.enabled && !!this.authToken;
  }

  async sendPairs(pairs) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }

    const payload = { 'auth-token': this.authToken };
    pairs.forEach(([key, value], index) => {
      const suffix = index === 0 ? '' : String(index);
      payload['key' + suffix] = key;
      payload['value' + suffix] = String(value);
    });

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(this.baseUrl + '/api?', {
          method: 'POST',
          headers: {
            accept: 'text/plain, application/json',
            'content-type': 'application/json',
            'user-agent': 'DealDost-DeltaScanner/2.0'
          },
          body: JSON.stringify(payload),
          cache: 'no-store',
          signal: controller.signal
        });
        const body = (await response.text()).trim();
        if (response.status === 429 && attempt === 0) {
          await sleep(4000);
          continue;
        }
        if (!response.ok) throw new Error('Tradetron API ' + response.status + ': ' + body.slice(0, 240));
        return { ok: true, body: body.slice(0, 240) };
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Tradetron API request failed');
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

    // Tradetron expects all runtime variables in ONE ordered JSON request.
    // The first pair uses key/value; subsequent pairs use key1/value1, etc.
    // Reset the opposite signal before triggering the requested side.
    const triggerKey = normalizedSide === 'BUY' ? 'api_buy' : 'api_sell';
    const resetKey = normalizedSide === 'BUY' ? 'api_sell' : 'api_buy';
    const writes = [
      [triggerKey, 1],
      [resetKey, 0],
      [selected, 1],
      [other, 0],
      [selected + '_qty', quantity],
      [selected + '_ep', Number(entryPrice)],
      [selected + '_sl', Number(sl)],
      [selected + '_tp', Number(tp)]
    ];

    const result = await this.sendPairs(writes);

    return {
      ok: !!result.ok,
      symbol: selected,
      side: normalizedSide,
      qty: quantity,
      executionId: clean(executionId),
      triggerKey,
      response: result.body
    };
  }
}
