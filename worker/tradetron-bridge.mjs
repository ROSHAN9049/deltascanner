import { CONFIG } from '../server/config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
const n = value => Number.isFinite(+value) ? +value : 0;

const ACTIONS = Object.freeze({
  BUY: '1',
  LONG_EXIT: '2',
  SHORT: '3',
  SHORT_EXIT: '4'
});

function cleanBaseUrl(value) {
  const raw = String(value || 'https://api.tradetron.tech/api').trim();
  return raw.replace(/\/+$/, '');
}

function keyEnvName(symbol) {
  return 'TRADETRON_KEY_' + String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export class TradetronBridge {
  constructor() {
    this.enabled = truthy(process.env.TRADETRON_ENABLED);
    this.route = String(process.env.EXECUTION_ROUTE || 'DELTA_TESTNET').trim().toUpperCase();
    this.apiUrl = cleanBaseUrl(process.env.TRADETRON_API_URL);
    this.token = String(process.env.TRADETRON_API_TOKEN || '').trim();
    this.maxSignalsPerCycle = Math.max(1, Math.min(5, Math.floor(n(process.env.TRADETRON_MAX_SIGNALS_PER_CYCLE || 1))));
    this.dedupeMs = Math.max(30000, Math.min(15 * 60 * 1000, Math.floor(n(process.env.TRADETRON_DEDUPE_MS || 60000))));
    this.timeoutMs = Math.max(3000, Math.min(20000, Math.floor(n(process.env.TRADETRON_TIMEOUT_MS || 8000))));
    this.lastSent = new Map();

    if (this.route === 'TRADETRON') {
      if (!this.enabled) throw new Error('TRADETRON_ENABLED=true is required when EXECUTION_ROUTE=TRADETRON');
      if (CONFIG.environment !== 'TESTNET') throw new Error('Tradetron bridge is TESTNET-only in this build');
      if (!this.token) throw new Error('TRADETRON_API_TOKEN is required when TRADETRON_ENABLED=true and EXECUTION_ROUTE=TRADETRON');
    }
  }

  keyFor(symbol) {
    const symbolKey = keyEnvName(symbol);
    const configured = process.env[symbolKey];
    return String(configured || symbol || '').trim();
  }

  actionForSide(side) {
    if (side === 'BUY') return ACTIONS.BUY;
    if (side === 'SELL') return ACTIONS.SHORT;
    return '';
  }

  configuredFor(symbol) {
    return Boolean(this.enabled && this.route === 'TRADETRON' && this.token && this.keyFor(symbol));
  }

  async send(symbol, action, context = {}) {
    if (!this.configuredFor(symbol)) return { sent: false, skipped: true, reason: 'bridge_not_configured' };
    if (!Object.values(ACTIONS).includes(String(action))) {
      throw new Error('Unsupported Tradetron signal action');
    }

    const key = this.keyFor(symbol);
    const fingerprint = [
      key,
      String(action),
      String(context.strategy || ''),
      String(context.score || ''),
      String(context.sl || ''),
      String(context.tp || '')
    ].join('|');

    const last = this.lastSent.get(fingerprint) || 0;
    if (Date.now() - last < this.dedupeMs) {
      return { sent: false, deduped: true, key, action: String(action) };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'DealDost-Delta-Tradetron/1.0'
        },
        body: JSON.stringify({
          'auth-token': this.token,
          key,
          value: String(action)
        }),
        signal: controller.signal
      });

      const bodyText = await response.text();
      let body = null;
      try { body = bodyText ? JSON.parse(bodyText) : null; } catch {}

      if (!response.ok) {
        const message = body?.message || body?.error || bodyText || ('HTTP_' + response.status);
        const error = new Error('Tradetron signal rejected: ' + message);
        error.status = response.status;
        throw error;
      }

      this.lastSent.set(fingerprint, Date.now());
      return {
        sent: true,
        status: response.status,
        key,
        action: String(action),
        response: body
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async dispatch(candidates) {
    if (!this.enabled || this.route !== 'TRADETRON') return [];
    const chosen = (candidates || [])
      .filter(x => x?.signal?.stage === 'CONFIRMED' && ['BUY', 'SELL'].includes(x.signal.side))
      .sort((a, b) => n(b.signal.score) - n(a.signal.score))
      .slice(0, this.maxSignalsPerCycle);

    const results = [];
    for (const candidate of chosen) {
      const signal = candidate.signal;
      const result = await this.send(signal.symbol, this.actionForSide(signal.side), {
        strategy: candidate.strategy,
        score: signal.score,
        sl: signal.sl,
        tp: signal.tp
      });
      results.push({ symbol: signal.symbol, strategy: candidate.strategy, side: signal.side, ...result });
      await sleep(50);
    }
    return results;
  }
}
