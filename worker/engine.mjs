import crypto from 'node:crypto';
import WebSocket from 'ws';
import { CONFIG } from '../server/config.js';
import { DeltaAdapter } from './delta-adapter.mjs';
import { analyse } from './strategy.mjs';
import { TradetronBridge } from './tradetron-bridge.mjs';
import * as db from '../server/db.js';

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

export class DeltaEngine {
  constructor() {
    this.adapter = new DeltaAdapter();
    this.tradetron = new TradetronBridge();
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
    this.tickerMap = new Map();
    this.products = [];
    this.productMap = new Map();
    this.candles = new Map();
    this.ws = null;
    this.wsRetry = 0;
    this.running = false;
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
      const p = this.productMap.get(t.symbol);
      if (!p) continue;
      next.set(t.symbol, { ...t });
    }
    const ranked = [...next.values()].sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover)).slice(0, 50);
    this.tickerMap = new Map(ranked.map(x => [x.symbol, x]));
    if (ranked.length) this.lastTickAt = Date.now();
    this.lastTickerFetch = Date.now();
  }

  async refreshCandle(symbol, resolution) {
    const key = resolution + ':' + symbol;
    const value = await this.adapter.candles(symbol, resolution, 100);
    this.candles.set(key, Array.isArray(value) ? value : []);
    return this.candles.get(key);
  }

  async refreshAllCandles() {
    const symbols = [...this.tickerMap.keys()];
    const work = [];
    for (const symbol of symbols) {
      for (const res of ['1m', '5m', '15m']) work.push([symbol, res]);
    }
    let cursor = 0;
    const runner = async () => {
      while (cursor < work.length) {
        const item = work[cursor++];
        try { await this.refreshCandle(item[0], item[1]); } catch (e) { await this.log('WARN', 'Candle refresh failed', { symbol: item[0], resolution: item[1], error: e.message }); }
      }
    };
    await Promise.all([runner(), runner(), runner()]);
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

  async accountSnapshot() {
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
    if (openPositions.some(p => p.symbol === signal.symbol && n(p.qty) > 0)) reasons.push('Duplicate symbol');
    if (openPositions.length >= Math.max(1, n(settings.max_open_positions || 20))) reasons.push('Max open positions');
    if (!signal.candlesFresh) reasons.push('Fresh closed candles unavailable');
    if (n(account.equity) <= 0) reasons.push('Account equity unavailable');
    const size = this.positionSizing(signal, account, settings);
    if (!size) reasons.push('Margin / minimum contract size');
    if (signal.feeRiskRatio > signal.costGateRatio) reasons.push('Fee + spread exceeds 1R cost budget');

    if (!continuous) {
      const engineCap = strategy === 'MOMENTUM' ? 3 : 3;
      if (openPositions.filter(p => p.strategy === strategy).length >= engineCap) reasons.push(strategy + ' cap');
      if (openPositions.length >= 6) reasons.push('Total cap 6');
      const symbolTrades = trades.filter(t => t.symbol === signal.symbol);
      const last = symbolTrades[0];
      if (last && Date.now() - new Date(last.closed_at || 0).getTime() < 15 * 60 * 1000) reasons.push('15m cooldown');
      if (last && n(last.net_pnl) < 0 && Date.now() - new Date(last.closed_at || 0).getTime() < 90 * 60 * 1000) reasons.push('90m losing-symbol cooldown');
      const todayNet = trades.filter(t => String(t.closed_at || '').slice(0, 10) === today()).reduce((s, t) => s + n(t.net_pnl), 0);
      if (todayNet <= -n(account.equity) * 0.03) reasons.push('Daily loss 3%');
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
    const tickers = [...this.tickerMap.values()];
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i], p = this.productMap.get(ticker.symbol);
      if (!p) continue;
      const c1 = this.getCandles(ticker.symbol, '1m');
      const c5 = this.getCandles(ticker.symbol, '5m');
      const c15 = this.getCandles(ticker.symbol, '15m');
      const mom = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'MOMENTUM', {
        minStopPct: n(settings.momentum_sl_min_pct || 0.95), rr: n(settings.momentum_rr || 2.5), scoreMin: n(settings.score_min || 80)
      });
      const scalp = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'SCALPING', {
        minStopPct: n(settings.scalping_sl_min_pct || 0.75), rr: n(settings.scalping_rr || 2.5), scoreMin: n(settings.score_min || 80)
      });
      for (const s of [mom, scalp]) {
        const size = this.positionSizing(s, account, settings);
        const gate = await this.riskGate(s, s === mom ? 'MOMENTUM' : 'SCALPING', account, settings, openPositions, trades);
        await db.insert('dd_signals', {
          symbol: s.symbol, product_id: s.productId, rank: i + 1,
          strategy: s === mom ? 'MOMENTUM' : 'SCALPING', price: s.price, change_24h: s.change,
          turnover_usd: s.turnover, spread_pct: s.spreadPct, volume_spike: s.volumeSpike,
          score: s.score, stage: s.stage, side: s.side, rsi: s.rsi, trend: s.trend,
          confirm_trend: s.confirmTrend, btc_trend: s.btcTrend, ema21: s.ema21,
          atr_5m: s.atr5, atr_15m: s.atr15, support: s.support, resistance: s.resistance,
          stop_price: s.sl, tp1_price: s.tp1, tp_price: s.tp,
          qty_contracts: size ? size.qty : 0, notional: size ? size.notional : 0,
          risk_usd: size ? size.risk : 0, fee_risk_ratio: s.feeRiskRatio,
          ready: s.ready && gate.reasons.length === 0, blocked_reasons: gate.reasons,
          details: { rsi: s.rsi, vwap: s.vwap, fee: s.takerFee, candlesFresh: s.candlesFresh }
        });
      }
      out.push({ ticker, product: p, mom, scalp });
    }
    this.lastSignals = out;
  }

  async findExistingClient(client) {
    try { return await this.adapter.clientOrder(client); } catch { return null; }
  }

  async waitPosition(symbol) {
    for (let i = 0; i < 12; i++) {
      const rows = await this.adapter.positions();
      const p = (Array.isArray(rows) ? rows : []).find(x =>
        String(x.product_symbol || x.symbol).toUpperCase() === symbol.toUpperCase() &&
        Math.abs(n(x.size)) > 0
      );
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  async openTrade(item, strategy, signal, account, settings, openPositions, trades) {
    if (signal.stage !== 'CONFIRMED' || signal.score < n(settings.score_min || 80)) return false;
    const gate = await this.riskGate(signal, strategy, account, settings, openPositions, trades);
    if (gate.reasons.length || !gate.size) return false;
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
    const tp = roundTick(signal.side === 'BUY' ? entryPrice + riskDistance * n(settings.momentum_rr || 2.5) : entryPrice - riskDistance * n(settings.momentum_rr || 2.5), tick);
    const executionId = entryCid;

    await db.insert('dd_positions', {
      symbol: signal.symbol, product_id: signal.productId,
      side: signal.side, qty: actualQty, entry_price: entryPrice, current_price: n(signal.price),
      stop_price: sl, tp1_price: tp1, tp_price: tp, initial_qty: actualQty,
      entry_order_id: entryId, client_order_id: entryCid, execution_id: executionId,
      strategy, origin: 'ENGINE', opened_at: iso()
    });

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

      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(executionId), {
        protection_verified: true, tp1_order_id: String(tp1Order.id), updated_at: iso()
      });
      await this.log('INFO', 'TESTNET trade opened with verified protection', {
        symbol: signal.symbol, strategy, side: signal.side, qty: actualQty,
        entry: entryPrice, sl, tp1, tp, risk: gate.size.risk, notional: gate.size.notional
      });
      return true;
    } catch (e) {
      await this.log('ERROR', 'Protection failed; closing immediately', { symbol: signal.symbol, error: e.message });
      await this.closePosition(signal.symbol, signal.productId, actualQty, signal.side, 'UNPROTECTED');
      return false;
    }
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

  async managePositionRow(row, exchangePosition, setting) {
    const mark = n(exchangePosition.mark_price || this.tickerMap.get(row.symbol)?.mark_price || row.current_price);
    const qty = Math.abs(n(exchangePosition.size));
    const originalRisk = Math.abs(n(row.entry_price) - n(row.stop_price));
    const fee = n(this.productMap.get(row.symbol)?.taker_commission_rate);
    if (qty <= 0) return;
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
        await this.managePositionRow(row, ep, this.currentSettings || {});
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
        return /^(DDM|DDS)-/.test(cid) && o.reduce_only !== true;
      });
      if (engineOrder) {
        const cid = String(engineOrder.client_order_id);
        const strategy = cid.startsWith('DDM-') ? 'MOMENTUM' : 'SCALPING';
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
            } else if (msg.type === 'ticker' || msg.type === 'v2/ticker') {
              const t = this.tickerMap.get(symbol) || { symbol };
              this.tickerMap.set(symbol, {
                ...t,
                ...x,
                symbol,
                mark_price: n(x.mark_price || x.mp || t.mark_price),
                close: n(x.close || x.c || t.close),
                ltp_change_24h: n(x.ltp_change_24h || x.ch || t.ltp_change_24h),
                turnover_usd: n(x.turnover_usd || x.v || t.turnover_usd)
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

  async scanOnce() {
    await this.acquireLease();
    const settings = { ...{
      enabled: true, auto_trade: true, emergency_stop: false, continuous_mode: true,
      max_open_positions: 20, risk_pct: 1, max_leverage: 3, score_min: 80,
      momentum_sl_min_pct: 0.95, scalping_sl_min_pct: 0.75, momentum_rr: 2.5,
      scalping_rr: 2.5, tp1_pct: 33, max_hold_minutes: 240
    }, ...(await this.loadSettings()) };
    this.currentSettings = settings;
    if (Date.now() - this.lastUniverseRefresh > 15 * 60 * 1000 || !this.products.length) await this.refreshProducts();
    if (Date.now() - this.lastTickerFetch > 30000 || !this.tickerMap.size) await this.refreshTickers();
    if (Date.now() - this.lastCandleRefresh > 60000 || !this.candles.size) await this.refreshAllCandles();

    const account = await this.accountSnapshot();
    if (Date.now() - this.lastReconcile > 60000) await this.reconcile();
    const openRows = await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    const trades = await this.recentTrades();
    if (Date.now() - this.lastAnalysis > 55000 || !this.lastSignals.length) {
      await this.analyseUniverse(account, settings, openRows || [], trades || []);
      this.lastAnalysis = Date.now();
    }
    const positions = openRows || [];
    if (settings.enabled && settings.auto_trade && !settings.emergency_stop) {
      const candidates = [];
      for (const item of this.lastSignals) {
        const choice = [
          { strategy: 'MOMENTUM', signal: item.mom },
          { strategy: 'SCALPING', signal: item.scalp }
        ].sort((a, b) => b.signal.score - a.signal.score)[0];
        if (choice.signal.stage === 'CONFIRMED') candidates.push({ item, ...choice });
      }
      candidates.sort((a, b) => b.signal.score - a.signal.score);

      if (this.tradetron.route === 'TRADETRON') {
        const dispatched = await this.tradetron.dispatch(candidates);
        if (dispatched.length) await this.log('INFO', 'Tradetron signal dispatch cycle', { results: dispatched });
      } else {
        for (const c of candidates.slice(0, 10)) {
          await this.openTrade(c.item, c.strategy, c.signal, account, settings, positions, trades);
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
    if (CONFIG.environment !== 'TESTNET') throw new Error('Production execution disabled');
    this.running = true;
    this.connectWs();
    await this.log('INFO', 'Delta TESTNET worker started', { workerId: CONFIG.workerId, executionRoute: this.tradetron.route, tradetronBridge: this.tradetron.enabled });
    while (this.running) {
      try { await this.scanOnce(); }
      catch (e) {
        await this.log('ERROR', 'Engine failed closed for cycle', { error: e.message, code: e.code || null });
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
