import { CONFIG } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = v => String(v ?? '').trim();

export class TradetronBridge {
  constructor() {
    this.enabled = CONFIG.tradetronBridgeEnabled;
    this.dynamicEnabled = CONFIG.tradetronDynamicBridgeEnabled;
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

  async emitEntry({ symbol, side, qty, entryPrice, sl, tp1, tp, executionId }) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }

    const selected = clean(symbol).toUpperCase();
    const normalizedSide = clean(side).toUpperCase();
    if (!['BUY', 'SELL'].includes(normalizedSide)) {
      throw new Error('Tradetron bridge side must be BUY or SELL');
    }

    const quantity = Math.max(1, Math.floor(Number(qty) || 0));
    const prices = {
      entryPrice: Number(entryPrice),
      sl: Number(sl),
      tp1: Number(tp1),
      tp: Number(tp)
    };
    if (!Number.isFinite(prices.entryPrice) || !Number.isFinite(prices.sl) || !Number.isFinite(prices.tp) || quantity < 1) {
      throw new Error('Tradetron bridge entry payload is invalid');
    }

    const execution = clean(executionId);
    const triggerKey = normalizedSide === 'BUY' ? 'api_buy' : 'api_sell';
    const resetKey = normalizedSide === 'BUY' ? 'api_sell' : 'api_buy';

    let writes;
    if (this.dynamicEnabled) {
      if (!/^[A-Z0-9]+USD$/.test(selected) || selected === 'USD') {
        throw new Error('Tradetron dynamic bridge symbol is invalid: ' + selected);
      }
      if (!Number.isFinite(prices.tp1)) {
        throw new Error('Tradetron dynamic bridge TP1 is required');
      }

      // Dynamic strategy contract. The Tradetron strategy must use
      // Get Runtime Traded Instrument for tt_symbol and GET RUNTIME for
      // quantity/price/exit variables. Entry conditions are driven by
      // tt_buy/tt_sell and must reset those flags back to 0 after entry/exit.
      writes = [
        ['tt_symbol', selected],
        ['tt_side', normalizedSide],
        ['tt_qty', quantity],
        ['tt_ep', prices.entryPrice],
        ['tt_sl', prices.sl],
        ['tt_tp1', prices.tp1],
        ['tt_tp', prices.tp],
        ['tt_exec_id', execution],
        ['tt_buy', normalizedSide === 'BUY' ? 1 : 0],
        ['tt_sell', normalizedSide === 'SELL' ? 1 : 0],
        ['api_buy', 0],
        ['api_sell', 0]
      ];
    } else {
      // Standard Signal Bridge basket contract. Each symbol is represented by
      // its own runtime flag plus _qty/_ep/_sl/_tp values, while api_buy/api_sell
      // acts as the global trigger. This lets the scanner drive any symbol that
      // already exists in the user's deployed Signal Bridge strategy without
      // changing that Tradetron strategy.
      if (!/^[A-Z0-9]+USD$/.test(selected) || selected === 'USD') {
        throw new Error('Tradetron Signal Bridge symbol is invalid: ' + selected);
      }

      writes = [
        [triggerKey, 1],
        [resetKey, 0],
        [selected, 1],
        [selected + '_qty', quantity],
        [selected + '_ep', prices.entryPrice],
        [selected + '_sl', prices.sl],
        [selected + '_tp', prices.tp]
      ];
    }

    const result = await this.sendPairs(writes);

    return {
      ok: !!result.ok,
      symbol: selected,
      side: normalizedSide,
      qty: quantity,
      executionId: execution,
      triggerKey: this.dynamicEnabled ? (normalizedSide === 'BUY' ? 'tt_buy' : 'tt_sell') : triggerKey,
      response: result.body,
      dynamic: this.dynamicEnabled
    };
  }

  async emitOptionEntry({ symbol, side, qty, entryPrice, sl, tp1, tp, underlying, optionType, expiryMs, executionId }) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }
    const selected = clean(symbol).toUpperCase();
    const normalizedSide = clean(side).toUpperCase();
    const asset = clean(underlying).toUpperCase();
    if (!/^[CP]-[A-Z0-9]+-[0-9.]+-\d{6}$/.test(selected)) throw new Error('Invalid Tradetron option symbol');
    if (!['BUY','SELL'].includes(normalizedSide)) throw new Error('Tradetron option side must be BUY or SELL');
    const quantity = Math.max(1, Math.floor(Number(qty) || 0));
    const prices = { entryPrice: Number(entryPrice), sl: Number(sl), tp1: Number(tp1), tp: Number(tp) };
    if (!Number.isFinite(prices.entryPrice) || !Number.isFinite(prices.sl) || !Number.isFinite(prices.tp)) {
      throw new Error('Tradetron option signal prices are invalid');
    }
    const execution = clean(executionId);
    const writes = [
      ['tt_option_symbol', selected],
      ['tt_option_side', normalizedSide],
      ['tt_option_qty', quantity],
      ['tt_option_ep', prices.entryPrice],
      ['tt_option_sl', prices.sl],
      ['tt_option_tp1', Number.isFinite(prices.tp1) ? prices.tp1 : 0],
      ['tt_option_tp', prices.tp],
      ['tt_option_underlying', asset],
      ['tt_option_type', clean(optionType).toUpperCase()],
      ['tt_option_expiry', Math.round(Number(expiryMs) || 0)],
      ['tt_option_exec_id', execution],
      ['tt_option_buy', normalizedSide === 'BUY' ? 1 : 0],
      ['tt_option_sell', normalizedSide === 'SELL' ? 1 : 0]
    ];
    const result = await this.sendPairs(writes);
    return {
      ok: !!result.ok,
      symbol: selected,
      side: normalizedSide,
      qty: quantity,
      executionId: execution,
      triggerKey: normalizedSide === 'BUY' ? 'tt_option_buy' : 'tt_option_sell',
      response: result.body,
      option: true
    };
  }

}
