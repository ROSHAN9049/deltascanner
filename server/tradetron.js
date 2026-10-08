import { CONFIG } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = v => String(v ?? '').trim();

export class TradetronBridge {
  constructor({
    enabled = CONFIG.tradetronBridgeEnabled,
    authToken = CONFIG.tradetronAuthToken,
    supportedSymbols = CONFIG.tradetronSupportedSymbols
  } = {}) {
    this.enabled = !!enabled;
    this.dynamicEnabled = CONFIG.tradetronDynamicBridgeEnabled;
    this.baseUrl = CONFIG.tradetronBaseUrl.replace(/\/$/, '');
    this.authToken = clean(authToken);
    this.supportedSymbols = [...new Set((Array.isArray(supportedSymbols) ? supportedSymbols : [])
      .map(x => clean(x).toUpperCase()).filter(x => /^[A-Z0-9]+USD$/.test(x) && x !== 'USD'))];
    this.timeoutMs = Math.max(2000, Number(CONFIG.tradetronTimeoutMs) || 10000);
  }

  isConfigured() {
    return this.enabled && !!this.authToken;
  }

  supportsFuturesSymbol(symbol) {
    const selected = clean(symbol).toUpperCase();
    return this.supportedSymbols.includes(selected);
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

  async emitEntry({ symbol, side, qty, entryPrice, sl, tp1, tp, executionId, strategy }) {
    if (!this.isConfigured()) return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };

    const selected=clean(symbol).toUpperCase(), normalizedSide=clean(side).toUpperCase(), engine=clean(strategy).toUpperCase()||'MOMENTUM';
    if (!['BUY','SELL'].includes(normalizedSide)) throw new Error('Tradetron bridge side must be BUY or SELL');
    if (!['MOMENTUM','SCALPING'].includes(engine)) throw new Error('Tradetron futures bridge strategy is invalid: '+engine);
    const quantity=Math.max(1,Math.floor(Number(qty)||0));
    const prices={entryPrice:Number(entryPrice),sl:Number(sl),tp1:Number(tp1),tp:Number(tp)};
    if (!Number.isFinite(prices.entryPrice)||!Number.isFinite(prices.sl)||!Number.isFinite(prices.tp)||quantity<1) throw new Error('Tradetron bridge entry payload is invalid');
    if (!/^[A-Z0-9]+USD$/.test(selected)||selected==='USD') throw new Error('Tradetron futures bridge symbol is invalid: '+selected);

    const execution=clean(executionId), triggerKey=normalizedSide==='BUY'?'api_buy':'api_sell';
    // Tradetron's existing Signal Bridge reads <SYMBOL>_q (not only
    // <SYMBOL>_qty). Set quantity and price metadata before raising any entry
    // trigger so the strategy cannot consume stale runtime values.
    const writes=[
      [selected,normalizedSide==='BUY'?1:3],
      [selected+'_xl',0],[selected+'_xs',0],
      [selected+'_q',quantity],[selected+'_qty',quantity],
      [selected+'_ep',prices.entryPrice],[selected+'_sl',prices.sl],[selected+'_tp',prices.tp],
      ['tt_engine',engine],['tt_symbol',selected],['tt_side',normalizedSide],['tt_qty',quantity],
      ['tt_ep',prices.entryPrice],['tt_sl',prices.sl],['tt_tp1',Number.isFinite(prices.tp1)?prices.tp1:0],['tt_tp',prices.tp],
      ['tt_exec_id',execution],
      [normalizedSide==='BUY'?'api_sell':'api_buy',0],
      [selected+'_el',normalizedSide==='BUY'?1:0],
      [selected+'_es',normalizedSide==='SELL'?1:0],
      ['tt_buy',normalizedSide==='BUY'?1:0],
      ['tt_sell',normalizedSide==='SELL'?1:0],
      [triggerKey,1]
    ];
    const result=await this.sendPairs(writes);
    setTimeout(()=>this.sendPairs([[selected+'_el',0],[selected+'_es',0],[triggerKey,0],['tt_buy',0],['tt_sell',0]]).catch(()=>{}),3000);
    return {ok:!!result.ok,symbol:selected,side:normalizedSide,qty:quantity,executionId:execution,triggerKey,actionCode:normalizedSide==='BUY'?1:3,response:result.body,dynamic:true,engine,contract:'legacy_symbol_el_es+dynamic_tt_v3'};
  }

  async emitExit({ symbol, side, reason, executionId }) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }
    const selected = clean(symbol).toUpperCase();
    const normalizedSide = clean(side).toUpperCase();
    const exitReason = clean(reason).toUpperCase() || 'SCANNER_EXIT';
    if (!/^[A-Z0-9]+USD$/.test(selected) || selected === 'USD') {
      throw new Error('Tradetron futures exit symbol is invalid: ' + selected);
    }
    if (!['BUY','SELL','LONG','SHORT'].includes(normalizedSide)) {
      throw new Error('Tradetron exit side is invalid: ' + normalizedSide);
    }
    const isLong = normalizedSide === 'BUY' || normalizedSide === 'LONG';
    const execution = clean(executionId);
    const longExit = selected + '_xl';
    const shortExit = selected + '_xs';
    // Existing Signal Bridge uses _xl for closing a long and _xs for closing
    // a short. Raise the appropriate exit flag last, after clearing entry flags.
    const writes = [
      [selected + '_el', 0],
      [selected + '_es', 0],
      ['api_buy', 0],
      ['api_sell', 0],
      ['tt_buy', 0],
      ['tt_sell', 0],
      ['tt_symbol', selected],
      ['tt_side', isLong ? 'BUY' : 'SELL'],
      ['tt_exit_reason', exitReason],
      ['tt_exec_id', execution],
      [longExit, isLong ? 1 : 0],
      [shortExit, isLong ? 0 : 1]
    ];
    const result = await this.sendPairs(writes);
    setTimeout(() => this.sendPairs([[longExit, 0], [shortExit, 0]]).catch(() => {}), 3000);
    return {
      ok: !!result.ok,
      symbol: selected,
      side: isLong ? 'BUY' : 'SELL',
      reason: exitReason,
      executionId: execution,
      triggerKey: isLong ? longExit : shortExit,
      response: result.body
    };
  }

  async emitOptionSpread({ symbol, hedgeSymbol, side, qty, entryPrice, sl, tp1, tp, underlying, optionType, expiryMs, executionId }) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: this.enabled ? 'TRADETRON_AUTH_TOKEN missing' : 'bridge disabled' };
    }
    const selected = clean(symbol).toUpperCase();
    const hedge = clean(hedgeSymbol).toUpperCase();
    const normalizedSide = clean(side).toUpperCase();
    const asset = clean(underlying).toUpperCase();
    if (!/^[CP]-[A-Z0-9]+-[0-9.]+-\d{6}$/.test(selected) || !/^[CP]-[A-Z0-9]+-[0-9.]+-\d{6}$/.test(hedge)) {
      throw new Error('Invalid Tradetron option spread symbol');
    }
    if (normalizedSide !== 'SELL') throw new Error('Tradetron option spread side must be SELL');
    const quantity = Math.max(1, Math.floor(Number(qty) || 0));
    if (!Number.isFinite(Number(entryPrice))) throw new Error('Tradetron option spread entry is invalid');
    const execution = clean(executionId);
    const writes = [
      ['tt_engine', 'OPTIONS'],
      ['tt_option_short_symbol', selected],
      ['tt_option_hedge_symbol', hedge],
      ['tt_option_side', 'SELL'],
      ['tt_option_qty', quantity],
      ['tt_option_ep', Number(entryPrice)],
      ['tt_option_sl', Number(sl) || 0],
      ['tt_option_tp1', Number(tp1) || 0],
      ['tt_option_tp', Number(tp) || 0],
      ['tt_option_underlying', asset],
      ['tt_option_type', clean(optionType).toUpperCase()],
      ['tt_option_expiry', Math.round(Number(expiryMs) || 0)],
      ['tt_option_exec_id', execution],
      ['tt_option_buy', 0],
      ['tt_option_sell', 1],
      ['tt_option_spread', 1]
    ];
    const result = await this.sendPairs(writes);
    setTimeout(() => this.sendPairs([['tt_option_sell', 0], ['tt_option_spread', 0]]).catch(() => {}), 3000);
    return {
      ok: !!result.ok,
      symbol: selected,
      hedgeSymbol: hedge,
      side: 'SELL',
      qty: quantity,
      executionId: execution,
      triggerKey: 'tt_option_sell',
      response: result.body,
      option: true,
      spread: true
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
      ['tt_engine', 'OPTIONS'],
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
    setTimeout(() => this.sendPairs([['tt_option_buy', 0], ['tt_option_sell', 0]]).catch(() => {}), 3000);
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
