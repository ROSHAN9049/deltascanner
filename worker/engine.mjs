import crypto from 'node:crypto';
import WebSocket from 'ws';
import { CONFIG } from '../server/config.js';
import { DeltaAdapter } from './delta-adapter.mjs';
import { analyse, analyseOption } from './strategy.mjs';
import * as db from '../server/db.js';
import { TradetronBridge } from '../server/tradetron.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(+v) ? +v : 0;
const iso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const sideExit = side => side === 'BUY' ? 'sell' : 'buy';
const clientId = (prefix, symbol) => (prefix + '-' + symbol.slice(0, 12) + '-' + Date.now().toString(36)).slice(0, 32);
const roundDown = (v, step) => {
  const s = Math.max(1, n(step) || 1);
  return Math.floor(v / s) * s;
};
const roundTick = (v, tick) => tick > 0 ? Math.round(v / tick) * tick : v;
const cleanPrice = v => {
  const x = n(v);
  if (!(x > 0)) return String(v);
  return x.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
};

export class DeltaEngine {
  constructor() {
    this.adapter = new DeltaAdapter();
    this.tradetron = new TradetronBridge();
    this.tradetronOptions = new TradetronBridge({ enabled: CONFIG.tradetronOptionsBridgeEnabled, authToken: CONFIG.tradetronOptionsAuthToken });
    this.unsupportedBridgeWarnings = new Set();
    this.leaseId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.lastTickAt = 0;
    this.lastTickerFetch = 0;
    this.lastUniverseRefresh = 0;
    this.lastCandleRefresh = 0;
    this.lastAnalysis = 0;
    this.lastReconcile = 0;
    this.lastAccount = 0;
    this.lastSignals = [];
    this.lastOptionSignals = [];
    this.optionTickerMap = new Map();
    this.lastOptionTickerFetch = 0;
    this.tickerMap = new Map();
    this.products = [];
    this.productMap = new Map();
    this.candles = new Map();
    this.ws = null;
    this.wsRetry = 0;
    this.running = false;
    this.privateExecutionAvailable = false;
    this.lastMarketCacheWrite = 0;
    this.candleWarmCursor = 0;
  }

  async log(level, message, data) {
    await db.log(level, message, data);
  }

  async acquireLease() {
    const result = await db.rpc('acquire_dd_lease', {
      p_lease_id: this.leaseId,
      p_worker_id: CONFIG.workerId,
      p_ttl_seconds: 45
    });
    const ok = Array.isArray(result) ? result.some(x => x === true || x.acquire_dd_lease === true) : result === true;
    if (!ok) throw new Error('Trading lease is held by another worker');
  }

  async releaseLease() {
    try { await db.rpc('release_dd_lease', { p_lease_id: this.leaseId }); } catch {}
  }

  async loadSettings() {
    const rows = await db.select('dd_settings', 'id=eq.1&select=*');
    return rows && rows[0] ? rows[0] : {};
  }

  async updateEngineState(patch) {
    try { await db.update('dd_settings', 'id=eq.1', { ...patch, updated_at: iso() }); } catch (e) { await this.log('ERROR', 'State persistence failed', { error: e.message }); }
  }

  async refreshProducts() {
    const raw = await this.adapter.products();
    const active = (Array.isArray(raw) ? raw : []).filter(p =>
      p.contract_type === 'perpetual_futures' &&
      p.state === 'live' &&
      p.trading_status === 'operational' &&
      p.only_reduce_only_orders_allowed !== true
    );
    this.products = active;
    this.productMap = new Map(active.map(p => [p.symbol, p]));
    this.lastUniverseRefresh = Date.now();
    await this.log('INFO', 'Delta product universe refreshed', { active: active.length });
  }

  async refreshTickers() {
    const raw = await this.adapter.tickers();
    const all = (Array.isArray(raw) ? raw : []).filter(x => x.contract_type === 'perpetual_futures');
    const next = new Map();
    for (const t of all) {
      const symbol = String(t.symbol || '').toUpperCase();
      const p = this.productMap.get(symbol);
      if (!p) continue;
      next.set(symbol, { ...t, symbol });
    }
    const ranked = [...next.values()].sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover));
    this.tickerMap = new Map(ranked.map(x => [x.symbol, x]));
    if (ranked.length) this.lastTickAt = Date.now();
    this.lastTickerFetch = Date.now();
  }

  async cacheMarketState(force = false) {
    if (!force && Date.now() - this.lastMarketCacheWrite < 30000) return;
    const rows = [...this.tickerMap.values()]
      .sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover))
      .map((ticker, index) => {
        const p = this.productMap.get(ticker.symbol) || {};
        const bid = n(ticker.quotes?.best_bid ?? ticker.best_bid);
        const ask = n(ticker.quotes?.best_ask ?? ticker.best_ask);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        return {
          symbol: ticker.symbol,
          product_id: n(p.id),
          contract_type: p.contract_type || 'perpetual_futures',
          state: p.state || 'live',
          trading_status: p.trading_status || 'operational',
          underlying_asset: String(p.underlying_asset || p.contract_unit_currency || ticker.symbol || '').replace(/USD$/i, ''),
          price: n(ticker.mark_price || ticker.close),
          mark_price: n(ticker.mark_price),
          change_24h: n(ticker.ltp_change_24h),
          turnover_usd: n(ticker.turnover_usd || ticker.turnover),
          volume: n(ticker.volume),
          open_interest: n(ticker.open_interest),
          bid, ask,
          spread_pct: mid > 0 ? (ask - bid) / mid * 100 : 0,
          tick_size: n(p.tick_size),
          contract_value: n(p.contract_value),
          notional_type: p.notional_type || null,
          max_leverage: n(p.default_leverage),
          max_leverage_notional: n(p.max_leverage_notional),
          position_notional_limit: n(p.position_notional_limit || p.position_limit_notional),
          market_rank: index + 1,
          active: true,
          cached_at: iso(),
          details: {
            description: p.description || null,
            shortDescription: p.short_description || null,
            makerFee: n(p.maker_commission_rate),
            takerFee: n(p.taker_commission_rate),
            launchTime: p.launch_time || null,
            settlementTime: p.settlement_time || null,
            productSpecs: p.product_specs || null,
            tags: p.tags || p.ui_config?.tags || []
          }
        };
      });
    await db.upsertMany('dd_market_cache', rows, 'symbol');
    this.lastMarketCacheWrite = Date.now();
    await this.log('INFO', 'Full Delta market cache refreshed', { perpetuals: rows.length });
  }

  async refreshCandle(symbol, resolution) {
    const key = resolution + ':' + symbol;
    const value = await this.adapter.candles(symbol, resolution, 100);
    this.candles.set(key, Array.isArray(value) ? value : []);
    return this.candles.get(key);
  }

  async refreshCandleWarmup() {
    const ranked = [...this.tickerMap.values()]
      .sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover));
    if (!ranked.length) return;
    const batchSize = 8;
    const total = ranked.length;
    const work = [];
    let scanned = 0;
    while (scanned < Math.min(batchSize, total)) {
      const symbol = ranked[(this.candleWarmCursor + scanned) % total].symbol;
      for (const resolution of ['1m', '5m', '15m']) {
        if (!this.candles.has(resolution + ':' + symbol)) work.push([symbol, resolution]);
      }
      scanned++;
    }
    this.candleWarmCursor = (this.candleWarmCursor + scanned) % total;

    let cursor = 0;
    const runner = async () => {
      while (cursor < work.length) {
        const [symbol, resolution] = work[cursor++];
        try {
          await this.refreshCandle(symbol, resolution);
        } catch (e) {
          await this.log('WARN', 'Candle warmup failed', { symbol, resolution, error: e.message });
        }
      }
    };
    await Promise.all([runner(), runner(), runner(), runner(), runner(), runner()]);
    this.lastCandleRefresh = Date.now();
  }

  getCandles(symbol, resolution) {
    return this.candles.get(resolution + ':' + symbol) || [];
  }

  btcSymbol() {
    if (this.productMap.has('BTCUSD')) return 'BTCUSD';
    return [...this.productMap.keys()].find(x => x.toUpperCase().startsWith('BTC')) || '';
  }

  positionSizing(signal, account, settings) {
    const equity = n(account.equity);
    const cv = n(signal.contractValue);
    const price = n(signal.price);
    const stopDistance = Math.abs(n(signal.price) - n(signal.sl));
    const riskBudget = equity * n(settings.risk_pct || 1) / 100;
    if (!equity || !cv || !price || !stopDistance || !riskBudget) return null;
    if (signal.notionalType && signal.notionalType !== 'vanilla') return null;
    const riskPerContract = stopDistance * cv;
    let qty = roundDown(riskBudget / riskPerContract, 1);
    const configuredCap = equity * n(settings.max_leverage || 3);
    const productCap = n(signal.maxLeverageNotional) > 0 ? n(signal.maxLeverageNotional) : configuredCap;
    const notionalCap = Math.min(configuredCap, productCap);
    qty = Math.min(qty, roundDown(notionalCap / (price * cv), 1));
    if (qty < 1) return null;
    const notional = qty * price * cv;
    const risk = qty * riskPerContract;
    const marginEstimate = notional / Math.max(1, n(settings.max_leverage || 3));
    if (n(account.available) > 0 && marginEstimate > n(account.available)) return null;
    return { qty, notional, risk, marginEstimate };
  }

  async accountSnapshot(settings = {}) {
    if (CONFIG.tradetronBridgeEnabled || !this.privateExecutionAvailable) {
      const equity = Math.max(0, Number(CONFIG.tradetronCapitalUsd) || 5000);
      return { equity, available: equity, unrealized: 0, positions: [] };
    }
    const [wallet, positions] = await Promise.all([
      this.adapter.wallet(),
      this.adapter.marginedPositions()
    ]);
    const meta = wallet && wallet.meta ? wallet.meta : {};
    const balances = Array.isArray(wallet) ? wallet : [];
    const equity = n(meta.net_equity) || balances.reduce((s, x) => s + n(x.balance), 0);
    const available = balances.reduce((s, x) => s + n(x.available_balance), 0);
    const open = Array.isArray(positions) ? positions.filter(p => Math.abs(n(p.size)) > 0) : [];
    const unrealized = open.reduce((s, p) => s + n(p.unrealized_pnl), 0);
    return { equity, available, unrealized, positions: open };
  }

  async recentTrades() {
    return db.select('dd_trades', 'order=closed_at.desc&limit=200');
  }

  async riskGate(signal, strategy, account, settings, openPositions, trades) {
    const reasons = [...(signal.blocked || [])];
    const continuous = settings.continuous_mode !== false;

    if (settings.emergency_stop) reasons.push('Emergency Stop');
    if (!settings.enabled || !settings.auto_trade) reasons.push('Auto OFF');
    if (openPositions.some(p => String(p.symbol) === String(signal.symbol) && n(p.qty) > 0)) reasons.push('Duplicate symbol');
    if (openPositions.length >= Math.max(1, n(settings.max_open_positions || 3))) reasons.push('Max open positions');
    if (!signal.candlesFresh && strategy !== 'OPTIONS_BUY') reasons.push('Fresh closed candles unavailable');
    if (n(account.equity) <= 0) reasons.push('Account equity unavailable');

    let size = null;
    if (strategy === 'OPTIONS_BUY') {
      const qty = Math.floor(this.optionQuantity(signal, account, settings));
      const cv = Math.max(1e-9, n(signal?.ticker?.contract_value) || 1);
      const mark = n(signal.mark);
      const stopPct = Math.max(1, n(settings.options_buy_stop_pct || 25));
      const notional = qty * mark * cv;
      const risk = qty * mark * (stopPct / 100) * cv;
      if (qty < 1) reasons.push('Risk budget below 1 contract');
      else if (n(account.available) > 0 && notional > n(account.available)) reasons.push('Margin / minimum contract size');
      else size = { qty, notional, risk, marginEstimate: notional };
      if (signal.executionLocked) reasons.push('Option execution route locked');
    } else if (signal.side) {
      size = this.positionSizing(signal, account, settings);
      if (!size) reasons.push('Margin / minimum contract size');
      if (n(signal.feeRiskRatio) > n(signal.costGateRatio)) reasons.push('Fee + spread exceeds 1R cost budget');
    }

    // Standard Tradetron Signal Bridge is basket-based. Any Delta futures
    // symbol is eligible here as long as the already-deployed Tradetron
    // strategy exposes that symbol's bridge variables.

    const todayNet = trades.filter(t => String(t.closed_at || '').slice(0, 10) === today()).reduce((s, t) => s + n(t.net_pnl), 0);
    if (todayNet <= -n(account.equity) * 0.01) reasons.push('Daily loss 1% hard stop');

    if (!continuous) {
      const engineCap = strategy === 'MOMENTUM' ? 3 : 3;
      if (openPositions.filter(p => p.strategy === strategy).length >= engineCap) reasons.push(strategy + ' cap');
      if (openPositions.length >= 6) reasons.push('Total cap 6');
      const symbolTrades = trades.filter(t => t.symbol === signal.symbol);
      const last = symbolTrades[0];
      if (last && Date.now() - new Date(last.closed_at || 0).getTime() < 15 * 60 * 1000) reasons.push('15m cooldown');
      if (last && n(last.net_pnl) < 0 && Date.now() - new Date(last.closed_at || 0).getTime() < 90 * 60 * 1000) reasons.push('90m losing-symbol cooldown');

      const recent = trades.filter(t => t.strategy === strategy).slice(0, 20);
      const wins = recent.filter(t => n(t.net_pnl) > 0).length;
      const recentNet = recent.reduce((s, t) => s + n(t.net_pnl), 0);
      if (recent.length >= 10 && (wins / recent.length < 0.35 || recentNet < 0)) reasons.push('Engine expectancy throttle');

      const losses = trades.filter(t => n(t.net_pnl) < 0).slice(0, 2);
      if (losses.length >= 2) {
        const a = new Date(losses[0].closed_at || 0).getTime();
        const b = new Date(losses[1].closed_at || 0).getTime();
        if (a >= b && a - b < 90 * 60 * 1000) reasons.push('2 consecutive losses');
      }
    }
    return { reasons: [...new Set(reasons)], size };
  }

  async refreshOptionTickers() {
    const configured = String(this.currentSettings?.options_underlyings || 'BTC,ETH,XAUT')
      .split(',')
      .map(x => x.trim().toUpperCase())
      .filter(x => /^[A-Z0-9]+$/.test(x));
    const underlyings = [...new Set(configured.length ? configured : ['BTC', 'ETH', 'XAUT'])];
    const results = await Promise.all(underlyings.map(async underlying => {
      try {
        const rows = await this.adapter.optionTickers(underlying);
        return (Array.isArray(rows) ? rows : []).map(x => ({ ...x, underlying }));
      } catch (e) {
        await this.log('WARN', 'Option chain refresh failed', { underlying, error: e.message });
        return [];
      }
    }));
    const next = new Map();
    for (const rows of results) {
      for (const t of rows) {
        const symbol = String(t.symbol || '').toUpperCase();
        if (symbol && /^[CP]-/.test(symbol)) next.set(symbol, { ...t, symbol });
      }
    }
    this.optionTickerMap = next;
    this.lastOptionTickerFetch = Date.now();
    await this.log('INFO', 'Option universe refreshed', { contracts: next.size, underlyings });
  }


  optionRiskBudget(account, settings) {
    const equity = n(account?.equity);
    const pct = Math.max(0.05, n(settings.options_max_risk_pct || 0.30));
    return equity > 0 ? equity * pct / 100 : 0;
  }

  optionQuantity(signal, account, settings) {
    const budget = this.optionRiskBudget(account, settings);
    const cv = Math.max(1e-9, n(signal?.ticker?.contract_value) || 1);
    const mark = n(signal?.mark);
    const stopPct = Math.max(1, n(settings.options_buy_stop_pct || 25));
    if (!budget || !mark) return 0;
    const riskPerContract = mark * stopPct / 100 * cv;
    return riskPerContract > 0 ? Math.floor(budget / riskPerContract) : 0;
  }

  pickOptionHedge(shortSignal, chain) {
    return chain
      .filter(x => String(x.optionType).toUpperCase() === String(shortSignal.optionType).toUpperCase())
      .filter(x => n(x.expiryMs) === n(shortSignal.expiryMs))
      .filter(x => n(x.mark) > 0 && n(x.ask) > 0 && n(x.strike) > 0)
      .filter(x => Math.abs(n(x.delta)) >= 0.05 && Math.abs(n(x.delta)) <= 0.15)
      .filter(x => shortSignal.optionType === 'CALL'
        ? n(x.strike) > n(shortSignal.strike)
        : n(x.strike) < n(shortSignal.strike))
      .sort((a, b) => Math.abs(Math.abs(n(a.delta)) - 0.10) - Math.abs(Math.abs(n(b.delta)) - 0.10))[0] || null;
  }


  async analyseOptions(futuresItems, account, settings, openPositions) {
    if (settings.options_enabled === false) {
      this.lastOptionSignals = [];
      return [];
    }
    const cfg = {
      buyMinDelta: settings.options_buy_min_delta,
      buyMaxDelta: settings.options_buy_max_delta,
      sellMinDelta: settings.options_sell_min_delta,
      sellMaxDelta: settings.options_sell_max_delta,
      minOi: settings.options_min_oi,
      minVolume: settings.options_min_volume,
      maxSpreadPct: settings.options_max_spread_pct,
      minDays: settings.options_min_days_to_expiry,
      maxDays: settings.options_max_days_to_expiry,
      scoreMin: settings.score_min,
      buyStopPct: settings.options_buy_stop_pct,
      buyTp1Pct: settings.options_buy_tp1_pct,
      buyTpPct: settings.options_buy_tp_pct
    };
    const chains = new Map();
    for (const ticker of this.optionTickerMap.values()) {
      const rawAsset = String(ticker.underlying || '').toUpperCase();
      const optionSymbol = String(ticker.symbol || '').toUpperCase();
      const parts = optionSymbol.split('-');
      const asset = rawAsset || parts[1] || optionSymbol;
      if (!asset) continue;
      if (!chains.has(asset)) chains.set(asset, []);
      chains.get(asset).push(ticker);
    }

    const out = [];
    for (const item of futuresItems || []) {
      const underlying = [item.mom, item.scalp].filter(Boolean).sort((a, b) => n(b.score) - n(a.score))[0];
      const asset = String(item.ticker?.symbol || '').toUpperCase().replace(/USD$/, '');
      const chain = chains.get(asset) || [];
      if (!underlying || !chain.length) continue;

      if (settings.options_buy_enabled !== false) {
        const candidates = chain
          .map(ticker => ({ ticker, signal: analyseOption(ticker, underlying, 'OPTIONS_BUY', cfg) }))
          .filter(x => x.signal.targetType === (underlying.side === 'BUY' ? 'CALL' : 'PUT'))
          .sort((a, b) => n(b.signal.score) - n(a.signal.score));
        const best = candidates[0];
        if (best) {
          const s = best.signal;
          const q = this.optionQuantity({ ...s, ticker: best.ticker }, account, settings);
          const duplicate = (openPositions || []).some(p => String(p.symbol) === s.symbol && n(p.qty) > 0);
          const optionOpenCount = (openPositions || []).filter(p => String(p.strategy || '').startsWith('OPTIONS_') && n(p.qty) > 0).length;
          const optionCap = Math.max(1, n(settings.options_max_open_positions || 1));
          const executionLocked = !CONFIG.tradetronOptionsBridgeEnabled || !this.tradetronOptions.isConfigured();
          const blocked = [...s.blocked];
          if (q < 1) blocked.push('Risk budget below 1 contract');
          if (duplicate) blocked.push('Duplicate option position');
          if (optionOpenCount >= optionCap && !duplicate) blocked.push('Options position cap ' + optionCap);
          if (executionLocked) blocked.push('Tradetron option signal route unavailable');
          const ready = s.ready && q >= 1 && !duplicate && !executionLocked;
          const cv = Math.max(1e-9, n(best.ticker.contract_value) || 1);
          const row = { ...s, ticker: best.ticker, strategy: 'OPTIONS_BUY', qty: q,
            notional: q * s.mark * cv,
            risk: q * s.mark * (Math.max(1, n(settings.options_buy_stop_pct || 25)) / 100) * cv,
            blocked, executionLocked, ready };
          await db.insert('dd_signals', {
            symbol: row.symbol, product_id: n(best.ticker.product_id || best.ticker.id),
            rank: 1, strategy: 'OPTIONS_BUY', price: row.mark, change_24h: row.underlyingChange,
            turnover_usd: n(best.ticker.turnover_usd || best.ticker.turnover), spread_pct: row.spreadPct,
            volume_spike: row.volume, score: row.score, stage: row.stage, side: 'BUY',
            rsi: underlying.rsi, trend: underlying.trend, confirm_trend: underlying.confirmTrend,
            btc_trend: underlying.btcTrend, ema21: underlying.ema21, atr_5m: underlying.atr5,
            atr_15m: underlying.atr15, support: underlying.support, resistance: underlying.resistance,
            stop_price: row.sl, tp1_price: row.tp1, tp_price: row.tp, qty_contracts: row.qty,
            notional: row.notional, risk_usd: row.risk, fee_risk_ratio: 0, ready,
            blocked_reasons: blocked,
            details: { engine: 'OPTIONS_BUY', optionType: row.optionType, strike: row.strike,
              dte: row.dte, expiryMs: row.expiryMs, delta: row.delta, gamma: row.gamma, theta: row.theta,
              vega: row.vega, bid: row.bid, ask: row.ask, openInterest: row.oi, volume: row.volume,
              underlyingSymbol: row.underlyingSymbol, underlyingScore: row.underlyingScore,
              executionLocked, signalOnly: CONFIG.signalOnly, tradetronRoute: 'tt_option_*' }
          });
          out.push(row);
        }
      }

      if (settings.options_sell_enabled !== false) {
        const candidates = chain
          .map(ticker => ({ ticker, signal: analyseOption(ticker, underlying, 'OPTIONS_SELL', cfg) }))
          .filter(x => x.signal.targetType === (underlying.side === 'BUY' ? 'PUT' : 'CALL'))
          .sort((a, b) => n(b.signal.score) - n(a.signal.score));
        const best = candidates[0];
        if (best) {
          const s = best.signal;
          const hedgeCandidates = chain
            .map(ticker => analyseOption(ticker, underlying, 'OPTIONS_SELL', cfg))
            .filter(h => String(h.optionType) === String(s.optionType) &&
              n(h.expiryMs) === n(s.expiryMs) &&
              Math.abs(n(h.delta)) >= 0.05 && Math.abs(n(h.delta)) <= 0.15 &&
              n(h.mark) > 0 && n(h.ask) > 0 &&
              (s.optionType === 'CALL' ? n(h.strike) > n(s.strike) : n(h.strike) < n(s.strike)))
            .sort((a, b) => Math.abs(Math.abs(n(a.delta)) - 0.10) - Math.abs(Math.abs(n(b.delta)) - 0.10));
          const hedge = hedgeCandidates[0] || null;
          const credit = hedge ? n(s.bid) - n(hedge.ask) : 0;
          const width = hedge ? Math.abs(n(s.strike) - n(hedge.strike)) : 0;
          const maxRiskPerSpread = Math.max(0, width - credit);
          const budget = this.optionRiskBudget(account, settings);
          const q = maxRiskPerSpread > 0 ? Math.floor(budget / maxRiskPerSpread) : 0;
          const blocked = [...s.blocked];
          const optionOpenCount = (openPositions || []).filter(p => String(p.strategy || '').startsWith('OPTIONS_') && n(p.qty) > 0).length;
          const optionCap = Math.max(1, n(settings.options_max_open_positions || 1));
          if (optionOpenCount >= optionCap) blocked.push('Options position cap ' + optionCap);
          if (!hedge) blocked.push('Defined-risk hedge unavailable');
          if (!(credit > 0)) blocked.push('Net credit <= 0');
          if (q < 1) blocked.push('Spread risk exceeds option risk budget');
          const optionRouteReady = CONFIG.tradetronOptionsBridgeEnabled && this.tradetronOptions.isConfigured();
          if (!optionRouteReady) blocked.push('Tradetron option signal route unavailable');
          const ready = s.ready && q >= 1 && !!hedge && credit > 0 && optionRouteReady;
          const row = { ...s, ticker: best.ticker, strategy: 'OPTIONS_SELL', qty: q,
            hedgeSymbol: hedge?.symbol || '', hedgeStrike: hedge?.strike || 0, hedgeDelta: hedge?.delta || 0,
            credit, maxRiskPerSpread, notional: Math.max(0, credit * q), risk: maxRiskPerSpread * q,
            blocked, executionLocked: false, ready, optionRouteReady };
          await db.insert('dd_signals', {
            symbol: row.symbol, product_id: n(best.ticker.product_id || best.ticker.id),
            rank: 1, strategy: 'OPTIONS_SELL', price: row.mark, change_24h: row.underlyingChange,
            turnover_usd: n(best.ticker.turnover_usd || best.ticker.turnover), spread_pct: row.spreadPct,
            volume_spike: row.volume, score: row.score, stage: row.stage, side: 'SELL',
            rsi: underlying.rsi, trend: underlying.trend, confirm_trend: underlying.confirmTrend,
            btc_trend: underlying.btcTrend, ema21: underlying.ema21, atr_5m: underlying.atr5,
            atr_15m: underlying.atr15, support: underlying.support, resistance: underlying.resistance,
            stop_price: 0, tp1_price: 0, tp_price: 0, qty_contracts: row.qty,
            notional: row.notional, risk_usd: row.risk, fee_risk_ratio: 0, ready: row.ready,
            blocked_reasons: blocked,
            details: { engine: 'OPTIONS_SELL', optionType: row.optionType, strike: row.strike,
              dte: row.dte, expiryMs: row.expiryMs, delta: row.delta, bid: row.bid, ask: row.ask,
              openInterest: row.oi, volume: row.volume, hedgeSymbol: row.hedgeSymbol,
              hedgeStrike: row.hedgeStrike, hedgeDelta: row.hedgeDelta, credit: row.credit,
              maxRiskPerSpread: row.maxRiskPerSpread, executionLocked: true, signalOnly: CONFIG.signalOnly, tradetronRoute: 'tt_option_*',
              definedRiskOnly: settings.options_sell_defined_risk_only !== false }
          });
          out.push(row);
        }
      }
    }
    this.lastOptionSignals = out;
    return out;
  }

  async analyseUniverse(account, settings, openPositions, trades) {
    const btc = this.btcSymbol();
    if (!btc) {
      this.lastSignals = [];
      await this.log('WARN', 'BTC regime unavailable; entries fail closed', {});
      return;
    }
    const btc5 = this.getCandles(btc, '5m');
    const btc15 = this.getCandles(btc, '15m');
    const out = [];
    const signalCacheRows = [];
    const tickers = [...this.tickerMap.values()];
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i], p = this.productMap.get(ticker.symbol);
      if (!p) continue;
      const c1 = this.getCandles(ticker.symbol, '1m');
      const c5 = this.getCandles(ticker.symbol, '5m');
      const c15 = this.getCandles(ticker.symbol, '15m');
      const mom = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'MOMENTUM', {
        minStopPct: n(settings.momentum_sl_min_pct || 0.95),
        rr: n(settings.momentum_rr || 2.0),
        scoreMin: n(settings.score_min || 65),
        volumeMin: n(settings.volume_min || 0.75),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 4.0),
        emaDistanceMax: n(settings.ema_distance_max || 3.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.20,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      const scalp = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'SCALPING', {
        minStopPct: n(settings.scalping_sl_min_pct || 0.75),
        rr: n(settings.scalping_rr || 2.0),
        scoreMin: n(settings.score_min || 70),
        volumeMin: n(settings.volume_min || 1.25),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 3.0),
        emaDistanceMax: n(settings.ema_distance_max || 2.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.25,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      for (const s of [mom, scalp]) {
        const size = this.positionSizing(s, account, settings);
        const gate = await this.riskGate(s, s === mom ? 'MOMENTUM' : 'SCALPING', account, settings, openPositions, trades);
        const strategyName = s === mom ? 'MOMENTUM' : 'SCALPING';
        const cacheRow = {
          cache_key: s.symbol + ':' + strategyName,
          symbol: s.symbol, product_id: s.productId, strategy: strategyName,
          price: s.price, change_24h: s.change, turnover_usd: s.turnover, spread_pct: s.spreadPct,
          volume_spike: s.volumeSpike, score: s.score, stage: s.stage, side: s.side,
          rsi: s.rsi, trend: s.trend, confirm_trend: s.confirmTrend, btc_trend: s.btcTrend,
          ema21: s.ema21, atr_5m: s.atr5, atr_15m: s.atr15, support: s.support, resistance: s.resistance,
          stop_price: s.sl, tp1_price: s.tp1, tp_price: s.tp,
          qty_contracts: size ? size.qty : 0, notional: size ? size.notional : 0,
          risk_usd: size ? size.risk : 0, fee_risk_ratio: s.feeRiskRatio,
          ready: s.ready && gate.reasons.length === 0, blocked_reasons: gate.reasons,
          cached_at: iso(),
          details: {
            rsi: s.rsi, vwap: s.vwap, fee: s.takerFee, candlesFresh: s.candlesFresh,
            localScore: s.localScore, btcRegimeOverride: s.btcRegimeOverride,
            btcOverrideScoreMin: s.btcOverrideScoreMin, btcOverrideVolumeMin: s.btcOverrideVolumeMin,
            fullMarketScan: true
          }
        };
        signalCacheRows.push(cacheRow);
        // Keep durable signal history for actionable states only. WATCH states
        // remain in the low-cost cache and do not fill the history table every minute.
        if (s.stage !== 'WATCH' || cacheRow.ready) {
          await db.insert('dd_signals', {
            symbol: s.symbol, product_id: s.productId, rank: i + 1,
            strategy: strategyName, price: s.price, change_24h: s.change,
            turnover_usd: s.turnover, spread_pct: s.spreadPct, volume_spike: s.volumeSpike,
            score: s.score, stage: s.stage, side: s.side, rsi: s.rsi, trend: s.trend,
            confirm_trend: s.confirmTrend, btc_trend: s.btcTrend, ema21: s.ema21,
            atr_5m: s.atr5, atr_15m: s.atr15, support: s.support, resistance: s.resistance,
            stop_price: s.sl, tp1_price: s.tp1, tp_price: s.tp,
            qty_contracts: size ? size.qty : 0, notional: size ? size.notional : 0,
            risk_usd: size ? size.risk : 0, fee_risk_ratio: s.feeRiskRatio,
            ready: cacheRow.ready, blocked_reasons: gate.reasons,
            details: cacheRow.details
          });
        }
      }
      out.push({ ticker, product: p, mom, scalp });
    }
    const optionSignals = await this.analyseOptions(out, account, settings, openPositions || []);
    const byUnderlying = new Map();
    for (const s of optionSignals) {
      const key = String(s.underlyingSymbol || '').toUpperCase();
      if (!byUnderlying.has(key)) byUnderlying.set(key, {});
      if (s.strategy === 'OPTIONS_BUY') byUnderlying.get(key).buy = s;
      if (s.strategy === 'OPTIONS_SELL') byUnderlying.get(key).sell = s;
    }
    for (const item of out) {
      const symbol = String(item.ticker?.symbol || '').toUpperCase();
      const key = symbol.endsWith('USD') ? symbol.slice(0, -3) : symbol;
      item.options = byUnderlying.get(key) || {};
    }
    await db.upsertMany('dd_signal_cache', signalCacheRows, 'cache_key');

    const optionCache = new Map();
    for (const s of optionSignals) {
      const underlying = String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, '');
      const key = underlying + ':' + s.strategy;
      const previous = optionCache.get(key);
      if (!previous || n(s.score) > n(previous.score)) optionCache.set(key, s);
    }
    const optionCacheRows = [...optionCache.values()].map(s => ({
      cache_key: String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, '') + ':' + s.strategy,
      underlying: String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, ''),
      strategy: s.strategy,
      symbol: s.symbol,
      product_id: n(s.ticker?.product_id || s.productId),
      option_type: s.optionType,
      strike: s.strike,
      expiry_ms: Math.round(n(s.expiryMs)),
      dte: s.dte,
      mark: s.mark,
      bid: s.bid,
      ask: s.ask,
      spread_pct: s.spreadPct,
      oi: s.oi,
      volume: s.volume,
      delta: s.delta,
      gamma: s.gamma,
      theta: s.theta,
      vega: s.vega,
      score: s.score,
      stage: s.stage,
      side: s.side,
      ready: s.ready,
      blocked_reasons: s.blocked || [],
      cached_at: iso(),
      details: {
        optionType: s.optionType,
        strike: s.strike,
        dte: s.dte,
        expiryMs: s.expiryMs,
        underlyingSymbol: s.underlyingSymbol,
        underlyingAsset: s.underlyingAsset || String(s.underlyingSymbol || '').replace(/USD$/, ''),
        underlyingScore: s.underlyingScore,
        underlyingSide: s.underlyingSide,
        underlyingChange: s.underlyingChange,
        bid: s.bid,
        ask: s.ask,
        volume: s.volume,
        openInterest: s.oi,
        fullMarketScan: true,
        goldOptionSettlement: String(s.underlyingSymbol || '').toUpperCase().startsWith('XAUT')
      }
    }));
    await db.upsertMany('dd_option_cache', optionCacheRows, 'cache_key');

    this.lastSignals = out;
  }

  async findExistingClient(client) {

    try { return await this.adapter.clientOrder(client); } catch { return null; }
  }

  async findBridgeExecution(executionId) {
    try {
      const rows = await db.select('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId) + '&select=state,updated_at&limit=1');
      return rows && rows[0] ? rows[0] : null;
    } catch (e) {
      await this.log('ERROR', 'Tradetron bridge idempotency lookup failed; entry blocked', { executionId, error: e.message });
      return { state: 'DB_ERROR' };
    }
  }

  async waitPosition(symbol) {
    for (let i = 0; i < 12; i++) {
      const rows = await this.adapter.positions(symbol);
      const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' ? [rows] : []);
      const p = list.find(x =>
        String(x.product_symbol || x.symbol || '').toUpperCase() === symbol.toUpperCase() &&
        Math.abs(n(x.size)) > 0
      );
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  async openTrade(item, strategy, signal, account, settings, openPositions, trades) {
    if (strategy === 'OPTIONS_BUY' || strategy === 'OPTIONS_SELL') return this.openOptionTrade(item, signal, account, settings, openPositions, trades);
    if (signal.stage !== 'CONFIRMED' || signal.score < n(settings.score_min || 80)) return false;
    const gate = await this.riskGate(signal, strategy, account, settings, openPositions, trades);
    if (gate.reasons.length || !gate.size) return false;

    // When Tradetron bridge mode is enabled, Tradetron owns execution.
    // Never fall through to direct Delta order placement, which would create
    // duplicate execution paths.
    if (CONFIG.tradetronBridgeEnabled) {
      if (!this.tradetron.isConfigured()) {
        await this.log('ERROR', 'Tradetron bridge enabled but auth token is missing; entry blocked', {
          symbol: signal.symbol, strategy, side: signal.side
        });
        return false;
      }
      if (!this.tradetron.supportsFuturesSymbol(signal.symbol)) {
        const warningKey = String(signal.symbol || '').toUpperCase();
        if (!this.unsupportedBridgeWarnings.has(warningKey)) {
          this.unsupportedBridgeWarnings.add(warningKey);
          await this.log('WARN', 'Tradetron entry blocked: symbol is not in the configured fixed basket', {
            symbol: warningKey,
            strategy,
            supportedSymbols: CONFIG.tradetronSupportedSymbols
          });
        }
        return false;
      }
      // One bridge execution per signal candle. This is stable across the
      // worker's 15s scan loop, but permits a fresh signal on a later candle.
      const signalCandle = Number(signal.signalCandleTs || signal.candleTs || 0);
      const executionId = 'TT-' + strategy + '-' + signal.symbol + '-' + signal.side + '-' + (signalCandle > 0 ? signalCandle : Math.floor(Date.now() / 60000));
      const prior = await this.findBridgeExecution(executionId);
      if (prior?.state === 'DB_ERROR' || prior?.state === 'SIGNAL_SENT') return false;
      if (prior?.state === 'PENDING') {
        const ageMs = Date.now() - new Date(prior.updated_at || 0).getTime();
        if (Number.isFinite(ageMs) && ageMs < 2 * 60 * 1000) return false;
      }

      // Tradetron owns positions in SIGNAL_ONLY mode. Avoid repeatedly firing
      // the same symbol/engine while the scanner cannot read Tradetron's
      // simulated positions back directly. The durable signal ledger provides
      // a five-minute throttle while preserving unlimited opportunity slots.
      if (CONFIG.signalOnly) {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const recent = await db.select(
          'dd_orders',
          'order_type=eq.tradetron_signal&symbol=eq.' + encodeURIComponent(signal.symbol) +
          '&strategy=eq.' + encodeURIComponent(strategy) +
          '&created_at=gte.' + encodeURIComponent(cutoff) +
          '&select=id,state,created_at&limit=1'
        );
        if (recent?.length) return false;
      }

      try {
        await db.upsert('dd_orders', {
          id: executionId,
          product_id: signal.productId,
          symbol: signal.symbol,
          side: signal.side === 'BUY' ? 'buy' : 'sell',
          order_type: 'tradetron_signal',
          size: gate.size.qty,
          state: 'PENDING',
          client_order_id: executionId,
          role: 'ENTRY',
          strategy,
          execution_id: executionId,
          raw: {
            source: 'tradetron_bridge',
            entry_price: signal.price,
            stop_price: signal.sl,
            tp_price: signal.tp
          }
        }, 'client_order_id');

        const result = await this.tradetron.emitEntry({
          symbol: signal.symbol,
          side: signal.side,
          qty: gate.size.qty,
          entryPrice: signal.price,
          sl: signal.sl,
          tp1: signal.tp1,
          tp: signal.tp,
          executionId,
          strategy
        });
        if (!result.ok) {
          await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId), {
            state: 'FAILED',
            updated_at: iso()
          }).catch(() => {});
          await this.log('ERROR', 'Tradetron bridge signal failed; direct Delta entry blocked', {
            symbol: signal.symbol, strategy, side: signal.side, executionId
          });
          return false;
        }

        await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId), {
          state: 'SIGNAL_SENT',
          updated_at: iso(),
          raw: {
            source: 'tradetron_bridge',
            entry_price: signal.price,
            stop_price: signal.sl,
            tp_price: signal.tp,
            bridge_response: result.response || null,
            bridge_trigger_key: result.triggerKey || null,
            bridge_dynamic: result.dynamic === true
          }
        });

        await this.log('INFO', 'Tradetron production signal emitted; Delta direct entry skipped', {
          symbol: signal.symbol, strategy, side: signal.side, qty: gate.size.qty,
          entry: signal.price, sl: signal.sl, tp: signal.tp, executionId
        });
        return true;
      } catch (e) {
        await this.log('ERROR', 'Tradetron bridge exception; direct Delta entry blocked', {
          symbol: signal.symbol, strategy, side: signal.side, error: e.message
        });
        return false;
      }
    }

    if (!this.privateExecutionAvailable) {
      await this.log('WARN', 'Direct Delta execution unavailable; entry blocked while scanner remains online', {
        symbol: signal.symbol, strategy, side: signal.side
      });
      return false;
    }

    const entryCid = clientId(strategy === 'MOMENTUM' ? 'DDM' : 'DDS', signal.symbol);
    if (await this.findExistingClient(entryCid)) return false;

    try { await this.adapter.setOrderLeverage(signal.productId, Math.min(3, Math.max(1, n(settings.max_leverage || 3)))); }
    catch (e) { await this.log('WARN', 'Leverage configuration rejected; entry skipped', { symbol: signal.symbol, error: e.message }); return false; }

    const entry = await this.adapter.placeOrder({
      product_id: signal.productId,
      size: gate.size.qty,
      side: signal.side === 'BUY' ? 'buy' : 'sell',
      order_type: 'market_order',
      client_order_id: entryCid
    });
    const entryId = String(entry.id);
    await db.upsert('dd_orders', {
      id: entryId, product_id: signal.productId, symbol: signal.symbol,
      side: signal.side === 'BUY' ? 'buy' : 'sell', order_type: 'market_order',
      size: gate.size.qty, unfilled_size: n(entry.unfilled_size), state: entry.state,
      client_order_id: entryCid, role: 'ENTRY', strategy, execution_id: entryCid, raw: entry
    }, 'client_order_id');

    const pos = await this.waitPosition(signal.symbol);
    if (!pos) {
      await this.log('ERROR', 'Entry order accepted but position not visible; no new trade state created', { symbol: signal.symbol, entryId });
      return false;
    }

    const actualQty = Math.abs(n(pos.size));
    const entryPrice = n(pos.entry_price) || signal.price;
    const tick = n(signal.tickSize);
    const sl = roundTick(signal.side === 'BUY' ? Math.min(signal.sl, entryPrice - tick) : Math.max(signal.sl, entryPrice + tick), tick);
    const riskDistance = Math.abs(entryPrice - sl);
    const tp1 = roundTick(signal.side === 'BUY' ? entryPrice + riskDistance : entryPrice - riskDistance, tick);
    const requestedRisk = Math.abs(n(signal.tp) - n(signal.price));
    const rr = riskDistance > 0 && requestedRisk > 0 ? Math.max(1, requestedRisk / Math.max(1e-12, Math.abs(n(signal.price) - n(signal.sl)))) : 2;
    const tp = roundTick(signal.side === 'BUY' ? entryPrice + riskDistance * rr : entryPrice - riskDistance * rr, tick);
    const executionId = entryCid;

    try {
      await this.adapter.placeBracket({
        product_id: signal.productId,
        stop_loss_order: { order_type: 'market_order', stop_price: String(sl) },
        take_profit_order: { order_type: 'market_order', stop_price: String(tp) },
        bracket_stop_trigger_method: 'mark_price'
      });
      const tp1Qty = Math.max(1, Math.min(actualQty, roundDown(actualQty * n(settings.tp1_pct || 33) / 100, 1)));
      const tp1Cid = clientId('TP1', signal.symbol);
      const tp1Order = await this.adapter.placeOrder({
        product_id: signal.productId,
        size: tp1Qty,
        side: sideExit(signal.side),
        order_type: 'market_order',
        stop_order_type: 'take_profit_order',
        stop_price: String(tp1),
        stop_trigger_method: 'mark_price',
        reduce_only: true,
        client_order_id: tp1Cid
      });
      await db.upsert('dd_orders', {
        id: String(tp1Order.id), product_id: signal.productId, symbol: signal.symbol,
        side: sideExit(signal.side), order_type: 'market_order', stop_order_type: 'take_profit_order',
        size: tp1Qty, unfilled_size: n(tp1Order.unfilled_size), state: tp1Order.state,
        client_order_id: tp1Cid, role: 'TP1', strategy, execution_id: executionId, raw: tp1Order
      }, 'client_order_id');

      const openOrders = await this.adapter.openOrders();
      const protectedOrders = (Array.isArray(openOrders) ? openOrders : []).filter(o =>
        n(o.product_id) === n(signal.productId) &&
        (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
      );
      if (!protectedOrders.length) throw new Error('Exchange-side protection not visible after bracket placement');

      await db.insert('dd_positions', {
        symbol: signal.symbol, product_id: signal.productId,
        side: signal.side, qty: actualQty, entry_price: entryPrice, current_price: n(signal.price),
        stop_price: sl, tp1_price: tp1, tp_price: tp, initial_qty: actualQty,
        entry_order_id: entryId, client_order_id: entryCid, execution_id: executionId,
        strategy, origin: 'ENGINE', protection_verified: true, tp1_order_id: String(tp1Order.id),
        opened_at: iso()
      });

      await this.log('INFO', 'TESTNET trade opened with verified protection', {
        symbol: signal.symbol, strategy, side: signal.side, qty: actualQty,
        entry: entryPrice, sl, tp1, tp, risk: gate.size.risk, notional: gate.size.notional
      });
      return true;
    } catch (e) {
      await this.log('ERROR', 'Entry protection or persistence failed', {
        symbol: signal.symbol, error: e.message, code: e.code || null, status: e.status || null, details: e.details || null
      });
      // The protection calls happen before local state persistence. If protection
      // succeeded but DB persistence failed, leave the exchange-side protection
      // intact and let reconcile recover the local state on the next cycle.
      const hasProtectedState = await this.ensurePositionProtection({
        symbol: signal.symbol, product_id: signal.productId, side: signal.side,
        qty: actualQty, initial_qty: actualQty, entry_price: entryPrice,
        stop_price: sl, tp1_price: tp1, tp_price: tp, strategy, execution_id: executionId,
        protection_verified: false, opened_at: iso()
      }, { size: actualQty, product_id: signal.productId, mark_price: entryPrice }, []).catch(() => false);
      if (!hasProtectedState) {
        await this.closePosition(signal.symbol, signal.productId, actualQty, signal.side, 'UNPROTECTED');
      }
      return false;
    }
  }

  async openOptionTrade(item, signal, account, settings, openPositions, trades) {
    if (signal.stage !== 'CONFIRMED' || !signal.ready) return false;
    if (!CONFIG.tradetronOptionsBridgeEnabled || !this.tradetronOptions.isConfigured()) return false;

    const executionId = 'TT-OPT-' + String(signal.strategy) + '-' +
      String(signal.symbol).replace(/[^A-Z0-9]/g, '').slice(0, 18) + '-' +
      (Number(signal.expiryMs) || Math.floor(Date.now() / 60000));
    const prior = await this.findBridgeExecution(executionId);
    if (prior?.state === 'DB_ERROR' || prior?.state === 'SIGNAL_SENT') return false;

    try {
      const result = signal.strategy === 'OPTIONS_SELL'
        ? await this.tradetronOptions.emitOptionSpread({
            symbol: signal.symbol,
            hedgeSymbol: signal.hedgeSymbol,
            side: 'SELL',
            qty: signal.qty,
            entryPrice: signal.mark,
            sl: signal.sl || 0,
            tp1: signal.tp1 || 0,
            tp: signal.tp || 0,
            underlying: signal.underlyingAsset || signal.underlyingSymbol,
            optionType: signal.optionType,
            expiryMs: signal.expiryMs,
            executionId
          })
        : await this.tradetronOptions.emitOptionEntry({
            symbol: signal.symbol,
            side: 'BUY',
            qty: signal.qty,
            entryPrice: signal.mark,
            sl: signal.sl,
            tp1: signal.tp1,
            tp: signal.tp,
            underlying: signal.underlyingAsset || signal.underlyingSymbol,
            optionType: signal.optionType,
            expiryMs: signal.expiryMs,
            executionId
          });

      if (!result?.ok) return false;

      await db.upsert('dd_orders', {
        id: executionId,
        product_id: n(signal.ticker?.product_id || signal.productId),
        symbol: signal.symbol,
        side: signal.strategy === 'OPTIONS_SELL' ? 'sell' : 'buy',
        order_type: 'tradetron_signal',
        size: signal.qty,
        state: 'SIGNAL_SENT',
        client_order_id: executionId,
        role: 'ENTRY',
        strategy: signal.strategy,
        execution_id: executionId,
        raw: {
          source: 'tradetron_option_bridge',
          option_type: signal.optionType,
          underlying: signal.underlyingAsset || signal.underlyingSymbol,
          hedge_symbol: signal.hedgeSymbol || null,
          entry_price: signal.mark,
          response: result.response || 'Ok'
        }
      }, 'client_order_id');

      await this.log('INFO', 'Tradetron option signal emitted; direct Delta option execution skipped', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        underlying: signal.underlyingSymbol,
        qty: signal.qty,
        executionId
      });
      return true;
    } catch (e) {
      await this.log('WARN', 'Tradetron option signal failed', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        error: e.message
      });
      return false;
    }
  }

  async manageOptionPositionRow(row, exchangePosition, setting, openOrders = []) {
    const qty = Math.abs(n(exchangePosition?.size));
    const mark = n(exchangePosition?.mark_price || row.current_price);
    if (qty <= 0) return;

    const product = this.optionTickerMap.get(row.symbol) || {};
    const tick = n(product.tick_size);
    const roundOption = v => tick > 0 ? roundTick(v, tick) : v;
    const entry = n(row.entry_price);
    const fee = n(product.taker_commission_rate);
    const stop = n(row.stop_price);
    const tp1 = n(row.tp1_price);
    const tp = n(row.tp_price);
    const base = Array.isArray(openOrders) ? openOrders.filter(o => n(o.product_id) === n(row.product_id)) : [];

    const stopCid = clientId('OSL', row.symbol);
    const tp1Cid = String('OTP1-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
    const tpCid = clientId('OTP', row.symbol);

    const hasStop = base.some(o => String(o.client_order_id || '') === stopCid || (o.stop_order_type === 'stop_loss_order' && n(o.size) >= qty));
    if (!hasStop && stop > 0) {
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'stop_loss_order', stop_price: cleanPrice(roundOption(stop)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: stopCid
      });
    }

    const tp1Exists = base.some(o => String(o.client_order_id || '') === tp1Cid || (o.stop_order_type === 'take_profit_order' && n(o.size) > 0 && n(o.size) < qty));
    if (!tp1Exists && tp1 > 0) {
      const tp1Qty = Math.max(1, Math.min(qty, roundDown(qty * n(setting.options_buy_tp1_pct || 30) / 100, 1)));
      await this.adapter.placeOrder({
        product_id: row.product_id, size: tp1Qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'take_profit_order', stop_price: cleanPrice(roundOption(tp1)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: tp1Cid
      });
    }

    const tpExists = base.some(o => String(o.client_order_id || '') === tpCid || (o.stop_order_type === 'take_profit_order' && n(o.size) >= qty));
    if (!tpExists && tp > 0) {
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'take_profit_order', stop_price: cleanPrice(roundOption(tp)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: tpCid
      });
    }

    const tp1Done = qty < n(row.initial_qty) && !row.tp1_done;
    if (tp1Done) {
      const be = roundOption(fee > 0 ? entry * (1 + 2 * fee) : entry);
      const fresh = await this.adapter.openOrders();
      const stopOrder = (Array.isArray(fresh) ? fresh : []).find(o => String(o.client_order_id || '') === stopCid);
      if (stopOrder) {
        await this.adapter.cancelOrder({ id: Number(stopOrder.id), product_id: row.product_id }).catch(() => {});
      }
      const beCid = String('OSLBE-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'stop_loss_order', stop_price: String(be),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: beCid
      });
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        qty, tp1_done: true, stop_price: be, current_price: mark, updated_at: iso()
      });
      await this.log('INFO', 'Options TP1 detected; stop moved to break-even', { symbol: row.symbol, qty, stop: be });
      return;
    }

    if (Date.now() - new Date(row.opened_at).getTime() > n(setting.max_hold_minutes || 240) * 60000) {
      await this.closePosition(row.symbol, row.product_id, qty, 'BUY', 'TIMEOUT');
    }

    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
      qty, current_price: mark, updated_at: iso()
    });
  }

  async closePosition(symbol, productId, qty, side, reason) {
    const rows = await db.select('dd_positions', 'symbol=eq.' + encodeURIComponent(symbol) + '&qty=gt.0&limit=1');
    if (rows && rows[0]) await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(rows[0].execution_id), { requested_exit_reason: reason, updated_at: iso() });
    const cid = clientId('CLS', symbol);
    if (await this.findExistingClient(cid)) return;
    await this.adapter.placeOrder({
      product_id: productId,
      size: Math.max(1, Math.floor(qty)),
      side: sideExit(side),
      order_type: 'market_order',
      reduce_only: true,
      client_order_id: cid
    });
  }

  async ensurePositionProtection(row, exchangePosition, openOrders = []) {
    const qty = Math.abs(n(exchangePosition?.size));
    const productId = n(row.product_id || exchangePosition?.product_id);
    if (qty <= 0 || !productId) return false;

    const tick = n(this.productMap.get(row.symbol)?.tick_size) || n(row.tick_size) || 0;
    const stop = roundTick(n(row.stop_price), tick);
    const tp1 = roundTick(n(row.tp1_price), tick);
    const tp = roundTick(n(row.tp_price), tick);
    if (!(stop > 0 && tp1 > 0 && tp > 0)) {
      await this.log('ERROR', 'Recovered position has incomplete protection prices', {
        symbol: row.symbol, executionId: row.execution_id, stop, tp1, tp
      });
      return false;
    }

    const sameProduct = (Array.isArray(openOrders) ? openOrders : []).filter(o => n(o.product_id) === productId);
    let protectedOrders = sameProduct.filter(o =>
      o.stop_order_type ||
      o.bracket_order ||
      n(o.bracket_stop_loss_price) ||
      n(o.bracket_take_profit_price)
    );

    const hasBracket = protectedOrders.some(o =>
      n(o.bracket_stop_loss_price) > 0 && n(o.bracket_take_profit_price) > 0
    );

    let bracketExistsByApi = false;
    if (!hasBracket) {
      try {
        await this.adapter.placeBracket({
          product_id: productId,
          stop_loss_order: { order_type: 'market_order', stop_price: cleanPrice(stop) },
          take_profit_order: { order_type: 'market_order', stop_price: cleanPrice(tp) },
          bracket_stop_trigger_method: 'mark_price'
        });
      } catch (e) {
        const details = e?.details || null;
        if (e?.code === 'bracket_order_exists') {
          bracketExistsByApi = true;
          const freshOrders = await this.adapter.openOrders().catch(() => []);
          protectedOrders = (Array.isArray(freshOrders) ? freshOrders : []).filter(o =>
            n(o.product_id) === productId &&
            (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
          );
        } else {
          // Some Delta products can reject a bracket payload even though
          // equivalent standalone reduce-only stop/TP orders are valid.
          // Fall back to exchange-side standalone protection rather than
          // leaving an already-open ENGINE position unprotected.
          await this.log('WARN', 'Bracket rejected; attempting standalone reduce-only protection', {
            symbol: row.symbol, executionId: row.execution_id, error: e.message,
            code: e.code || null, status: e.status || null, details
          });
          try {
            const suffix = String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '').slice(-20);
            const stopCid = ('RSL-' + suffix).slice(0, 32);
            const tpCid = ('RTP-' + suffix).slice(0, 32);
            const freshOrders = await this.adapter.openOrders().catch(() => []);
            const same = (Array.isArray(freshOrders) ? freshOrders : []).filter(o => n(o.product_id) === productId);
            const nearPrice = (a, b) => {
              const x = n(a), y = n(b);
              return x > 0 && y > 0 && Math.abs(x - y) <= Math.max(Math.abs(y) * 0.0005, tick > 0 ? tick * 2 : 1e-9);
            };
            const stopExisting = same.find(o =>
              String(o.client_order_id || '') === stopCid ||
              (o.stop_order_type === 'stop_loss_order' && n(o.size) >= qty && nearPrice(o.stop_price, stop))
            );
            const tpExisting = same.find(o =>
              String(o.client_order_id || '') === tpCid ||
              (o.stop_order_type === 'take_profit_order' && n(o.size) >= qty && nearPrice(o.stop_price, tp))
            );
            if (!stopExisting) {
              await this.adapter.placeOrder({
                product_id: productId, size: qty, side: sideExit(row.side),
                order_type: 'market_order', stop_order_type: 'stop_loss_order',
                stop_price: cleanPrice(stop), stop_trigger_method: 'mark_price',
                reduce_only: true, client_order_id: stopCid
              });
            }
            if (!tpExisting) {
              await this.adapter.placeOrder({
                product_id: productId, size: qty, side: sideExit(row.side),
                order_type: 'market_order', stop_order_type: 'take_profit_order',
                stop_price: cleanPrice(tp), stop_trigger_method: 'mark_price',
                reduce_only: true, client_order_id: tpCid
              });
            }
            const verifiedOrders = await this.adapter.openOrders();
            protectedOrders = (Array.isArray(verifiedOrders) ? verifiedOrders : []).filter(o =>
              n(o.product_id) === productId &&
              (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
            );
          } catch (fallbackError) {
            await this.log('ERROR', 'Standalone reduce-only protection failed', {
              symbol: row.symbol, executionId: row.execution_id,
              error: fallbackError.message, code: fallbackError.code || null,
              status: fallbackError.status || null, details: fallbackError.details || null
            });
            return false;
          }
        }
      }
      const freshOrders = protectedOrders.length
        ? protectedOrders
        : await this.adapter.openOrders().catch(() => []);
      protectedOrders = (Array.isArray(freshOrders) ? freshOrders : []).filter(o =>
        n(o.product_id) === productId &&
        (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
      );
    }

    const near = (a, b) => {
      const x = n(a), y = n(b);
      if (!(x > 0 && y > 0)) return false;
      const tol = Math.max(Math.abs(y) * 0.0005, tick > 0 ? tick * 2 : 1e-9);
      return Math.abs(x - y) <= tol;
    };
    const hasCombinedBracket = protectedOrders.some(o =>
      n(o.bracket_stop_loss_price) > 0 && n(o.bracket_take_profit_price) > 0
    );
    const hasSeparateStop = protectedOrders.some(o =>
      o.stop_order_type === 'stop_loss_order' &&
      near(o.stop_price || o.bracket_stop_loss_price, stop)
    );
    const hasSeparateTakeProfit = protectedOrders.some(o =>
      o.stop_order_type === 'take_profit_order' &&
      near(o.stop_price || o.bracket_take_profit_price, tp)
    );
    const bracketVerified = bracketExistsByApi || hasCombinedBracket || (hasSeparateStop && hasSeparateTakeProfit);

    const tp1Cid = ('TP1-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
    const tp1Existing = protectedOrders.find(o =>
      o.stop_order_type === 'take_profit_order' &&
      n(o.size) > 0 &&
      n(o.size) < qty &&
      (o.reduce_only === true || String(o.client_order_id || '') === tp1Cid)
    );

    let tp1OrderId = tp1Existing ? String(tp1Existing.id) : null;
    if (!tp1OrderId) {
      const tp1Qty = Math.max(1, Math.min(qty, roundDown(qty * n(this.currentSettings?.tp1_pct || 33) / 100, 1)));
      const prior = await this.findExistingClient(tp1Cid);
      if (prior) {
        tp1OrderId = String(prior.id);
      } else {
        try {
          const tp1Order = await this.adapter.placeOrder({
            product_id: productId,
            size: tp1Qty,
            side: sideExit(row.side),
            order_type: 'market_order',
            stop_order_type: 'take_profit_order',
            stop_price: String(tp1),
            stop_trigger_method: 'mark_price',
            reduce_only: true,
            client_order_id: tp1Cid
          });
          tp1OrderId = String(tp1Order.id);
          await db.upsert('dd_orders', {
            id: String(tp1Order.id), product_id: productId, symbol: row.symbol,
            side: sideExit(row.side), order_type: 'market_order', stop_order_type: 'take_profit_order',
            size: tp1Qty, unfilled_size: n(tp1Order.unfilled_size), state: tp1Order.state,
            client_order_id: tp1Cid, role: 'TP1', strategy: row.strategy, execution_id: row.execution_id, raw: tp1Order
          }, 'client_order_id');
        } catch (e) {
          await this.log('ERROR', 'Recovered position TP1 placement failed', {
            symbol: row.symbol, executionId: row.execution_id, error: e.message,
            code: e.code || null, status: e.status || null, details: e.details || null
          });
          return false;
        }
      }
    }

    const verified = bracketVerified && !!tp1OrderId;
    if (verified) {
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        protection_verified: true,
        tp1_order_id: tp1OrderId,
        updated_at: iso()
      });
      await this.log('INFO', 'Recovered TESTNET position protection verified', {
        symbol: row.symbol, executionId: row.execution_id, qty, stop, tp1, tp, tp1OrderId
      });
    }
    return verified;
  }

  async managePositionRow(row, exchangePosition, setting, openOrders = []) {
    const mark = n(exchangePosition.mark_price || this.tickerMap.get(row.symbol)?.mark_price || row.current_price);
    const qty = Math.abs(n(exchangePosition.size));
    const originalRisk = Math.abs(n(row.entry_price) - n(row.stop_price));
    const fee = n(this.productMap.get(row.symbol)?.taker_commission_rate);
    if (qty <= 0) return;
    if (!row.protection_verified) {
      const protectedNow = await this.ensurePositionProtection(row, exchangePosition, openOrders);
      if (!protectedNow) {
        await this.log('ERROR', 'Unprotected engine position remains blocked from management', {
          symbol: row.symbol, executionId: row.execution_id, qty
        });
        return;
      }
      row.protection_verified = true;
    }
    const changed = qty < n(row.initial_qty) && !row.tp1_done;
    if (changed) {
      const be = row.side === 'BUY' ? n(row.entry_price) * (1 + 2 * fee) : n(row.entry_price) * (1 - 2 * fee);
      const rounded = roundTick(be, n(this.productMap.get(row.symbol)?.tick_size));
      await this.adapter.editBracket({
        id: Number(row.entry_order_id), product_id: row.product_id,
        bracket_stop_loss_price: String(rounded),
        bracket_stop_trigger_method: 'mark_price'
      });
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        qty, tp1_done: true, stop_price: rounded, current_price: mark, updated_at: iso()
      });
      await this.log('INFO', 'TP1 detected; stop moved to break-even plus fees', { symbol: row.symbol, qty, stop: rounded });
      return;
    }
    let stop = n(row.stop_price);
    if (row.tp1_done && originalRisk > 0) {
      const candidate = row.side === 'BUY' ? mark - originalRisk : mark + originalRisk;
      const favorable = row.side === 'BUY' ? candidate > stop : candidate < stop;
      if (favorable) {
        const rounded = roundTick(candidate, n(this.productMap.get(row.symbol)?.tick_size));
        await this.adapter.editBracket({
          id: Number(row.entry_order_id), product_id: row.product_id,
          bracket_stop_loss_price: String(rounded),
          bracket_stop_trigger_method: 'mark_price'
        });
        stop = rounded;
      }
    }
    if (Date.now() - new Date(row.opened_at).getTime() > n(setting.max_hold_minutes || 240) * 60000) {
      await this.closePosition(row.symbol, row.product_id, qty, row.side, 'TIMEOUT');
    }
    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
      qty, current_price: mark, stop_price: stop, updated_at: iso()
    });
  }

  async reconcile() {
    const [positions, orders, fills] = await Promise.all([
      this.adapter.marginedPositions(),
      this.adapter.openOrders(),
      this.adapter.fills()
    ]);
    const exchangePositions = Array.isArray(positions) ? positions.filter(p => Math.abs(n(p.size)) > 0) : [];
    const local = await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    for (const row of local || []) {
      const ep = exchangePositions.find(p => String(p.product_symbol) === String(row.symbol));
      if (row.origin !== 'ENGINE') {
        if (!ep) await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), { qty: 0, updated_at: iso() });
        continue;
      }
      if (ep) {
        if (row.strategy === 'OPTIONS_BUY') {
          await this.manageOptionPositionRow(row, ep, this.currentSettings || {}, Array.isArray(orders) ? orders : []);
        } else {
          await this.managePositionRow(row, ep, this.currentSettings || {}, Array.isArray(orders) ? orders : []);
        }
      } else {
        await this.finalizeClosedTrade(row, Array.isArray(fills) ? fills : [], Array.isArray(orders) ? orders : []);
      }
    }
    const recentHistory = await this.adapter.historyOrders().catch(() => []);
    const allOrders = [...(Array.isArray(orders) ? orders : []), ...(Array.isArray(recentHistory) ? recentHistory : [])];
    for (const ep of exchangePositions) {
      const symbol = String(ep.product_symbol || ep.symbol || '');
      const known = (local || []).some(p => String(p.symbol) === symbol);
      if (known) continue;
      const candidates = allOrders.filter(o => String(o.product_symbol || o.symbol) === symbol);
      const engineOrder = candidates.find(o => {
        const cid = String(o.client_order_id || '');
        return /^(DDM|DDS|DDO)-/.test(cid) && o.reduce_only !== true;
      });
      if (engineOrder) {
        const cid = String(engineOrder.client_order_id);
        const strategy = cid.startsWith('DDM-') ? 'MOMENTUM' : cid.startsWith('DDO-') ? 'OPTIONS_BUY' : 'SCALPING';
        const latest = (await db.select('dd_signals', 'symbol=eq.' + encodeURIComponent(symbol) + '&strategy=eq.' + strategy + '&order=captured_at.desc&limit=1'))?.[0] || {};
        const side = n(ep.size) > 0 ? 'BUY' : 'SELL';
        const protection = candidates.some(o => o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price));
        await db.insert('dd_positions', {
          symbol, product_id: n(ep.product_id || engineOrder.product_id), side,
          qty: Math.abs(n(ep.size)), entry_price: n(ep.entry_price),
          current_price: n(ep.mark_price), stop_price: n(latest.stop_price || engineOrder.bracket_stop_loss_price),
          tp1_price: n(latest.tp1_price), tp_price: n(latest.tp_price || engineOrder.bracket_take_profit_price),
          initial_qty: Math.abs(n(ep.size)), protection_verified: protection,
          entry_order_id: String(engineOrder.id), client_order_id: cid,
          execution_id: cid, strategy, origin: 'ENGINE',
          opened_at: engineOrder.created_at || iso(), updated_at: iso()
        });
        await this.log('WARN', 'Recovered engine position after state gap', { symbol, strategy, clientOrderId: cid });
      } else {
        await db.insert('dd_positions', {
          symbol, product_id: n(ep.product_id), side: n(ep.size) > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(n(ep.size)), entry_price: n(ep.entry_price), current_price: n(ep.mark_price),
          stop_price: 0, tp1_price: 0, tp_price: 0, initial_qty: Math.abs(n(ep.size)),
          strategy: 'EXTERNAL', origin: 'EXTERNAL', execution_id: 'EXTERNAL-' + symbol + '-' + Date.now().toString(36),
          opened_at: ep.created_at || iso(), updated_at: iso()
        });
        await this.log('WARN', 'External Delta position recorded; not auto-managed', { symbol, size: ep.size });
      }
    }
    this.lastReconcile = Date.now();
  }

  async finalizeClosedTrade(row, fills, orders) {
    const openedAt = new Date(row.opened_at || Date.now()).getTime();
    const product = this.productMap.get(row.symbol);
    const productValue = n(product?.contract_value) || 1;
    const relevant = fills.filter(f => String(f.product_symbol || '') === row.symbol && new Date(f.created_at || 0).getTime() >= openedAt - 60000);
    const entrySide = row.side === 'BUY' ? 'buy' : 'sell';
    const exitSide = sideExit(row.side);
    const entries = relevant.filter(f => String(f.side).toLowerCase() === entrySide);
    const exits = relevant.filter(f => String(f.side).toLowerCase() === exitSide);
    const entryQty = entries.reduce((s, f) => s + n(f.size), 0);
    const exitQty = exits.reduce((s, f) => s + n(f.size), 0);
    if (!exitQty) return;
    const entryNotional = entries.reduce((s, f) => s + Math.abs(n(f.notional)), 0);
    const exitNotional = exits.reduce((s, f) => s + Math.abs(n(f.notional)), 0);
    const entryPrice = entryQty ? entries.reduce((s, f) => s + n(f.price) * n(f.size), 0) / entryQty : n(row.entry_price);
    const exitPrice = exitQty ? exits.reduce((s, f) => s + n(f.price) * n(f.size), 0) / exitQty : n(row.current_price);
    const gross = row.side === 'BUY'
      ? (exitNotional - entryNotional)
      : (entryNotional - exitNotional);
    const fees = relevant.reduce((s, f) => s + Math.abs(n(f.commission)), 0);
    const net = gross - fees;
    const linkedOrders = orders.filter(o => relevant.some(f => String(f.order_id) === String(o.id)));
    const hasSl = linkedOrders.some(o => o.stop_order_type === 'stop_loss_order' || n(o.bracket_stop_loss_price));
    const hasTp = linkedOrders.some(o => o.stop_order_type === 'take_profit_order' || n(o.bracket_take_profit_price));
    const hasTp1 = relevant.some(f => String(f.order_id) === String(row.tp1_order_id));
    let reason = row.requested_exit_reason || 'MANUAL';
    if (hasTp1 && exitQty < n(row.initial_qty)) reason = 'TP1';
    else if (hasTp) reason = 'TP';
    else if (hasSl) reason = row.tp1_done ? (n(row.stop_price) !== 0 && ((row.side === 'BUY' && n(row.stop_price) > n(row.entry_price)) || (row.side === 'SELL' && n(row.stop_price) < n(row.entry_price))) ? 'TRAIL' : 'BREAKEVEN') : 'SL';
    if (row.requested_exit_reason) reason = row.requested_exit_reason;

    const executionId = row.execution_id;
    const exists = await db.select('dd_trades', 'execution_id=eq.' + encodeURIComponent(executionId) + '&select=execution_id');
    if (exists && exists.length) {
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(executionId), { qty: 0, updated_at: iso() });
      return;
    }
    const rValue = Math.abs(n(row.entry_price) - n(row.stop_price)) * productValue * Math.max(1, n(row.initial_qty));
    const rMultiple = rValue ? net / rValue : 0;
    const result = net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT';
    const trade = {
      execution_id: executionId, symbol: row.symbol, strategy: row.strategy, side: row.side,
      entry_price: entryPrice, exit_price: exitPrice, qty: Math.max(entryQty, exitQty, n(row.initial_qty)),
      entry_notional: entryNotional, exit_notional: exitNotional, fees, gross_pnl: gross, net_pnl: net,
      pnl_pct: entryNotional ? net / entryNotional * 100 : 0, r_multiple: rMultiple,
      exit_reason: reason, result, entry_fill_ids: entries.map(f => f.id), exit_fill_ids: exits.map(f => f.id),
      opened_at: row.opened_at, closed_at: iso()
    };
    await db.insert('dd_trades', trade);
    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(executionId), { qty: 0, updated_at: iso() });
    if (net > 0) {
      await db.insert('dd_rotation_ledger', {
        execution_id: executionId, profit: net, released: net * 0.90, retained: net * 0.10,
        rotation_id: 'ROT-' + Date.now().toString(36)
      });
    }
    const counters = (await db.select('dd_counters', 'id=eq.1&select=*'))?.[0] || {};
    await db.update('dd_counters', 'id=eq.1', {
      consecutive_losses: net < 0 ? n(counters.consecutive_losses) + 1 : 0,
      last_loss_at: net < 0 ? iso() : counters.last_loss_at,
      updated_at: iso()
    });
    const daily = (await db.select('dd_daily_pnl', 'trade_date=eq.' + encodeURIComponent(today())))?.[0];
    const dayPatch = {
      trade_date: today(),
      realized: n(daily?.realized) + net,
      fees: n(daily?.fees) + fees,
      wins: n(daily?.wins) + (net > 0 ? 1 : 0),
      losses: n(daily?.losses) + (net < 0 ? 1 : 0),
      trades: n(daily?.trades) + 1,
      updated_at: iso()
    };
    await db.upsert('dd_daily_pnl', dayPatch, 'trade_date');
    await this.log('INFO', 'Real closed trade recorded', { executionId, symbol: row.symbol, reason, gross, fees, net });
  }

  connectWs() {
    if (this.ws) return;
    try {
      const ws = new WebSocket(CONFIG.publicWs);
      this.ws = ws;
      ws.on('open', () => {
        this.wsRetry = 0;
        ws.send(JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [
              { name: 'ticker', symbols: ['perpetual_futures'] },
              { name: 'mark_price', symbols: ['perpetual_futures'] },
              { name: 'candlestick_1m', symbols: ['perpetual_futures'] },
              { name: 'candlestick_5m', symbols: ['perpetual_futures'] },
              { name: 'candlestick_15m', symbols: ['perpetual_futures'] }
            ]
          }
        }));
        ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
      });
      ws.on('message', raw => {
        this.lastTickAt = Date.now();
        try {
          const msg = JSON.parse(raw.toString());
          const items = Array.isArray(msg.d) ? msg.d : (msg.d && typeof msg.d === 'object' ? [msg.d] : [msg]);
          for (const x of items) {
            const symbol = String(x.sy || x.symbol || '').replace(/^MARK:/, '');
            if (!symbol) continue;
            if (msg.type === 'mark_price' || String(msg.type).includes('mark_price')) {
              const t = this.tickerMap.get(symbol);
              if (t) this.tickerMap.set(symbol, { ...t, mark_price: n(x.p || x.mark_price || x.c || t.mark_price) });
            } else if (String(msg.type || '').startsWith('candlestick_')) {
              const match = String(msg.type || '').match(/^candlestick_(.+)$/);
              const resolution = match?.[1] || String(x.res || '');
              if (!resolution || !['1m','5m','15m'].includes(resolution)) continue;
              const key = resolution + ':' + symbol;
              const current = Array.isArray(this.candles.get(key)) ? [...this.candles.get(key)] : [];
              const tsRaw = Number(x.ts ?? x.timestamp ?? x.t ?? 0);
              const candle = {
                time: tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw,
                open: n(x.o),
                high: n(x.h),
                low: n(x.l),
                close: n(x.c),
                volume: n(x.v),
                res: resolution
              };
              if (!(candle.close > 0) || !(candle.high > 0) || !(candle.low > 0)) continue;
              const last = current.at(-1);
              if (last && Number(last.time) === Number(candle.time)) current[current.length - 1] = candle;
              else current.push(candle);
              this.candles.set(key, current.slice(-120));
            } else if (msg.type === 'ticker' || msg.type === 'v2/ticker') {
              const t = this.tickerMap.get(symbol) || { symbol };
              this.tickerMap.set(symbol, {
                ...t,
                ...x,
                symbol,
                mark_price: n(x.mark_price || x.mp || t.mark_price),
                close: n(x.close || x.c || t.close),
                ltp_change_24h: n(x.ltp_change_24h || x.ch || t.ltp_change_24h),
                turnover_usd: n(x.turnover_usd || x.v || t.turnover_usd),
                open_interest: n(x.open_interest || x.oi || t.open_interest)
              });
            }
          }
        } catch {}
      });
      ws.on('close', () => {
        this.ws = null;
        const wait = Math.min(30000, 5000 * Math.max(1, ++this.wsRetry));
        setTimeout(() => this.connectWs(), wait);
      });
      ws.on('error', () => {});
    } catch {
      this.ws = null;
      setTimeout(() => this.connectWs(), 10000);
    }
  }

  async manageTradetronPositions(rows, settings = {}) {
    if (!CONFIG.signalOnly || !CONFIG.tradetronBridgeEnabled || !this.tradetron.isConfigured()) return;
    const marketAge = Date.now() - Math.max(this.lastTickerFetch || 0, this.lastTickAt || 0);
    if (marketAge > 90000) {
      await this.log('WARN', 'Tradetron exit monitor skipped because market data is stale', { marketAgeMs: marketAge });
      return;
    }

    const now = Date.now();
    const timeoutMs = Math.max(1, n(settings.max_hold_minutes || 240)) * 60000;
    for (const row of Array.isArray(rows) ? rows : []) {
      const symbol = String(row.symbol || '').toUpperCase();
      const strategy = String(row.strategy || '').toUpperCase();
      const qty = Math.abs(n(row.qty));
      const sideValue = String(row.side || '').toUpperCase();
      const side = ['BUY', 'LONG'].includes(sideValue) ? 'BUY'
        : ['SELL', 'SHORT'].includes(sideValue) ? 'SELL' : '';
      // This manager intentionally handles only the existing fixed futures
      // Signal Bridge. Options have separate instrument/hedge semantics.
      if (row.origin !== 'TRADETRON' || qty <= 0 ||
          !/^[A-Z0-9]+USD$/.test(symbol) || symbol === 'USD' ||
          !['MOMENTUM', 'SCALPING'].includes(strategy) || !side) continue;

      const existingReason = String(row.requested_exit_reason || '').toUpperCase();
      const updatedAt = Date.parse(row.updated_at || 0) || 0;
      if (existingReason.startsWith('BRIDGE_EXIT:')) continue;
      if (existingReason && !existingReason.startsWith('BRIDGE_EXIT_PENDING:')) continue;
      if (existingReason.startsWith('BRIDGE_EXIT_PENDING:') && now - updatedAt < 120000) continue;

      const ticker = this.tickerMap.get(symbol);
      const mark = n(ticker?.mark_price || ticker?.close || ticker?.price);
      if (!(mark > 0)) continue;
      const stop = n(row.stop_price);
      const target = n(row.tp_price);
      let reason = '';

      if (side === 'BUY') {
        if (stop > 0 && mark <= stop) reason = 'STOP_LOSS';
        else if (target > 0 && mark >= target) reason = 'TAKE_PROFIT';
      } else {
        if (stop > 0 && mark >= stop) reason = 'STOP_LOSS';
        else if (target > 0 && mark <= target) reason = 'TAKE_PROFIT';
      }

      const openedAt = Date.parse(row.opened_at || 0) || 0;
      if (!reason && openedAt > 0 && now - openedAt >= timeoutMs) reason = 'TIMEOUT';
      if (!reason) continue;

      const executionId = String(row.execution_id || row.client_order_id || '');
      try {
        await db.update('dd_positions',
          'execution_id=eq.' + encodeURIComponent(executionId),
          { requested_exit_reason: 'BRIDGE_EXIT_PENDING:' + reason, current_price: mark, updated_at: iso() }
        );
        const result = await this.tradetron.emitExit({ symbol, side, reason, executionId });
        if (!result.ok) {
          // A confirmed non-success can be retried on the next loop.
          await db.update('dd_positions',
            'execution_id=eq.' + encodeURIComponent(executionId),
            { requested_exit_reason: null, updated_at: iso() }
          ).catch(() => {});
          await this.log('ERROR', 'Tradetron exit signal was not accepted', {
            symbol, side, qty, reason, executionId, response: result.response || null
          });
          continue;
        }
        await db.update('dd_positions',
          'execution_id=eq.' + encodeURIComponent(executionId),
          { requested_exit_reason: 'BRIDGE_EXIT:' + reason, current_price: mark, updated_at: iso() }
        );
        await this.log('INFO', 'Tradetron exit trigger sent from scanner risk monitor', {
          symbol, side, qty, mark, stop, target, reason, executionId,
          triggerKey: result.triggerKey || null
        });
      } catch (error) {
        // Leave the pending marker for two minutes: the request may have
        // reached Tradetron even if the network response was lost.
        await this.log('ERROR', 'Tradetron exit monitor failed closed', {
          symbol, side, qty, reason, executionId, error: error.message
        });
      }
    }
  }

  async scanOnce() {
    await this.acquireLease();
    const settings = { ...{
      enabled: true, auto_trade: true, emergency_stop: false, continuous_mode: true,
      max_open_positions: 3, risk_pct: 0.3, max_leverage: 3, score_min: 65,
      options_underlyings: 'BTC,ETH,XAUT',
      momentum_sl_min_pct: 0.95, scalping_sl_min_pct: 0.75, momentum_rr: 2.5,
      scalping_rr: 2.5, tp1_pct: 33, max_hold_minutes: 240
    }, ...(await this.loadSettings()) };
    this.currentSettings = settings;
    if (Date.now() - this.lastUniverseRefresh > 15 * 60 * 1000 || !this.products.length) await this.refreshProducts();
    if (Date.now() - this.lastTickerFetch > 30000 || !this.tickerMap.size) {
      await this.refreshTickers();
      await this.cacheMarketState(true);
    } else {
      await this.cacheMarketState(false);
    }
    await this.refreshCandleWarmup();
    if (settings.options_enabled !== false && (Date.now() - this.lastOptionTickerFetch > 60000 || !this.optionTickerMap.size)) await this.refreshOptionTickers();

    const account = await this.accountSnapshot(settings);
    // In production SIGNAL_ONLY mode, dd_positions are legacy scanner-owned
    // execution records and must never be treated as live positions. Tradetron
    // owns execution; actual Offline positions arrive through the Tradetron
    // activity webhook and are exposed separately by the API.
    let openRows = CONFIG.signalOnly ? await db.select('dd_positions', 'origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc') : await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    if (
      !CONFIG.signalOnly &&
      this.privateExecutionAvailable &&
      Date.now() - this.lastReconcile > 60000 &&
      (!CONFIG.tradetronBridgeEnabled || (openRows || []).length)
    ) {
      try {
        await this.reconcile();
        this.lastReconcile = Date.now();
      } catch (e) {
        await this.log('WARN', 'Legacy Delta position reconciliation unavailable; direct engine remains fail-closed', {
          error: e.message, bridge: CONFIG.tradetronBridgeEnabled
        });
      }
      openRows = await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    }
    // In production SIGNAL_ONLY mode, manage exits only for verified Tradetron
    // futures positions materialized by the outbound activity webhook. This
    // does not submit any direct Delta Exchange order.
    if (CONFIG.signalOnly) await this.manageTradetronPositions(openRows || [], settings);
    const trades = await this.recentTrades();
    if (Date.now() - this.lastAnalysis > 55000 || !this.lastSignals.length) {
      await this.analyseUniverse(account, settings, openRows || [], trades || []);
      this.lastAnalysis = Date.now();
    }
    const positions = openRows || [];
    if (settings.enabled && settings.auto_trade && !settings.emergency_stop) {
      const candidates = [];
      for (const item of this.lastSignals) {
        const futuresChoices = [
          { strategy: 'MOMENTUM', signal: item.mom },
          { strategy: 'SCALPING', signal: item.scalp }
        ].filter(x => x.signal?.stage === 'CONFIRMED' && x.signal?.ready);
        for (const choice of futuresChoices) candidates.push({ item, ...choice });

        const optionBuy = item.options?.buy;
        if (optionBuy?.stage === 'CONFIRMED' && optionBuy?.ready) {
          candidates.push({ item, strategy: 'OPTIONS_BUY', signal: optionBuy });
        }
        const optionSell = item.options?.sell;
        if (optionSell?.stage === 'CONFIRMED' && optionSell?.ready) {
          candidates.push({ item, strategy: 'OPTIONS_SELL', signal: optionSell });
        }
      }

      candidates.sort((a, b) => {
        const scoreDelta = n(b.signal.score) - n(a.signal.score);
        if (scoreDelta) return scoreDelta;
        const rank = { MOMENTUM: 4, SCALPING: 3, OPTIONS_BUY: 2, OPTIONS_SELL: 2 };
        return (rank[b.strategy] || 0) - (rank[a.strategy] || 0);
      });

      const maxPositions = CONFIG.signalOnly ? Number.POSITIVE_INFINITY : Math.max(1, n(settings.max_open_positions || 3));

      // Signal-only mode is execution-routed through Tradetron. Keep a small
      // rolling guard so the 15s scanner loop cannot flood the external API,
      // while allowing Momentum + Scalping + one Options opportunity through.
      // Per-symbol/candle idempotency still runs inside openTrade().
      let bridgeSignalsInWindow = 0;
      if (CONFIG.signalOnly) {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        try {
          const recent = await db.select(
            'dd_orders',
            'order_type=eq.tradetron_signal&created_at=gte.' + encodeURIComponent(cutoff) +
            '&select=id&limit=10'
          );
          bridgeSignalsInWindow = Array.isArray(recent) ? recent.length : 0;
        } catch (e) {
          await this.log('WARN', 'Bridge rate guard lookup failed; cycle remains fail-safe', { error: e.message });
          bridgeSignalsInWindow = 3;
        }
      }

      for (const c of candidates) {
        if (CONFIG.signalOnly && bridgeSignalsInWindow >= 3) break;
        const freshAccount = await this.accountSnapshot(settings);
        const freshPositions = CONFIG.signalOnly ? await db.select('dd_positions', 'origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc') : await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
        if ((freshPositions || []).length >= maxPositions) break;
        const opened = await this.openTrade(c.item, c.strategy, c.signal, freshAccount, settings, freshPositions || [], trades);
        if (opened) {
          if (CONFIG.signalOnly) bridgeSignalsInWindow++;
          await sleep(250);
        }
      }
    }

    const unrealized = account.positions.reduce((s, p) => s + n(p.unrealized_pnl), 0);
    const closed = trades || [];
    const realized = closed.reduce((s, t) => s + n(t.net_pnl), 0);
    const feesToday = closed.filter(t => String(t.closed_at || '').slice(0, 10) === today()).reduce((s, t) => s + n(t.fees), 0);
    const idle = candidatesText(this.lastSignals);
    await this.updateEngineState({
      equity: account.equity, available_balance: account.available, realized_pnl: realized,
      unrealized_pnl: unrealized, fees_today: feesToday,
      last_tick_at: new Date(this.lastTickAt || Date.now()).toISOString(),
      worker_started_at: new Date(this.startedAt).toISOString(), idle_reason: idle
    });
    await this.log('INFO', 'Worker heartbeat scan', { lastTickAt: this.lastTickAt, signals: this.lastSignals.length, positions: positions.length });
  }

  async run() {
    if (!CONFIG.signalOnly || CONFIG.directDeltaExecutionEnabled) throw new Error('Production direct execution disabled; scanner must be SIGNAL_ONLY');
    this.running = true;
    this.connectWs();
    await this.log('INFO', 'Delta production SIGNAL_ONLY worker started', { workerId: CONFIG.workerId });
    while (this.running) {
      try { await this.scanOnce(); }
      catch (e) {
        await this.log('ERROR', 'Engine failed closed for cycle', {
          error: e.message, code: e.code || null, status: e.status || null, details: e.details || null
        });
      }
      await sleep(15000);
    }
  }

  async stop() {
    this.running = false;
    try { this.ws?.close(); } catch {}
    await this.releaseLease();
  }
}

function candidatesText(signals) {
  const stage = {};
  const blocked = {};
  for (const item of signals || []) {
    for (const s of [item.mom, item.scalp]) {
      stage[s.stage] = (stage[s.stage] || 0) + 1;
      for (const reason of (s.blocked || []).slice(0, 3)) blocked[reason] = (blocked[reason] || 0) + 1;
    }
  }
  const top = Object.entries(blocked).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0] + ' (' + x[1] + ')').join(', ');
  return 'WATCH ' + (stage.WATCH || 0) + ' · SETUP ' + (stage.SETUP || 0) + ' · CONFIRMED ' + (stage.CONFIRMED || 0) + ' · Top blocks: ' + (top || 'none');
}
