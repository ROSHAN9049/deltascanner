import { CONFIG } from '../server/config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
const n = value => Number.isFinite(+value) ? +value : 0;

function cleanBaseUrl(value) {
  const raw = String(value || 'https://api.tradetron.tech/api').trim();
  return raw.replace(/\/+$/, '');
}

function symbolEnvPart(symbol) {
  return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function keyEnvName(symbol, side) {
  const suffix = side === 'BUY' ? 'LONG' : side === 'SELL' ? 'SHORT' : '';
  return suffix ? 'TRADETRON_KEY_' + symbolEnvPart(symbol) + '_' + suffix : '';
}

function valueEnvName(symbol, side) {
  const suffix = side === 'BUY' ? 'LONG' : side === 'SELL' ? 'SHORT' : '';
  return suffix ? 'TRADETRON_VALUE_' + symbolEnvPart(symbol) + '_' + suffix : '';
}

export class TradetronBridge {
  constructor() {
    this.enabled = truthy(process.env.TRADETRON_ENABLED);
    this.route = String(process.env.EXECUTION_ROUTE || 'DELTA_TESTNET').trim().toUpperCase();
    this.apiUrl = cleanBaseUrl(process.env.TRADETRON_API_URL);
    this.token = String(process.env.TRADETRON_API_TOKEN || '').trim();
    this.defaultValue = String(process.env.TRADETRON_DEFAULT_VALUE || '1').trim() || '1';
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

  keyFor(symbol, side) {
    const envName = keyEnvName(symbol, side);
    return envName ? String(process.env[envName] || '').trim() : '';
  }

  valueFor(symbol, side) {
    const envName = valueEnvName(symbol, side);
    return envName
      ? String(process.env[envName] || this.defaultValue).trim() || this.defaultValue
      : '';
  }

  configuredFor(symbol, side) {
    return Boolean(
      this.enabled &&
      this.route === 'TRADETRON' &&
      this.token &&
      ['BUY', 'SELL'].includes(side) &&
      this.keyFor(symbol, side)
    );
  }

  statusFor(symbol, side) {
    const keyEnv = keyEnvName(symbol, side);
    const configured = this.configuredFor(symbol, side);
    return {
      symbol,
      side,
      configured,
      keyConfigured: Boolean(keyEnv && process.env[keyEnv]),
      valueConfigured: Boolean(valueEnvName(symbol, side) && process.env[valueEnvName(symbol, side)]),
      value: this.valueFor(symbol, side)
    };
  }

  async send(symbol, side, context = {}) {
    if (!this.configuredFor(symbol, side)) {
      return {
        sent: false,
        skipped: true,
        reason: 'explicit_tradetron_key_required',
        symbol,
        side
      };
    }

    const key = this.keyFor(symbol, side);
    const value = this.valueFor(symbol, side);
    const fingerprint = [
      key,
      value,
      String(context.strategy || ''),
      String(context.score || ''),
      String(context.sl || ''),
      String(context.tp || '')
    ].join('|');

    const last = this.lastSent.get(fingerprint) || 0;
    if (Date.now() - last < this.dedupeMs) {
      return { sent: false, deduped: true, key, value };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'DealDost-Delta-Tradetron/1.1'
        },
        body: JSON.stringify({
          'auth-token': this.token,
          key,
          value
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
        value,
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
      const result = await this.send(signal.symbol, signal.side, {
        strategy: candidate.strategy,
        score: signal.score,
        sl: signal.sl,
        tp: signal.tp
      });

      results.push({
        symbol: signal.symbol,
        strategy: candidate.strategy,
        side: signal.side,
        ...result
      });

      await sleep(50);
    }

    return results;
  }
}
