const n = v => Number.isFinite(+v) ? +v : 0;

export function closed(candles) {
  return Array.isArray(candles) && candles.length > 2 ? candles.slice(0, -1) : [];
}
export function ema(candles, period) {
  const a = closed(candles).map(c => n(c.close));
  if (a.length < period) return 0;
  const k = 2 / (period + 1);
  let e = a[0];
  for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
export function rsi(candles, period = 14) {
  const a = closed(candles);
  if (a.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = a.length - period; i < a.length; i++) {
    const d = n(a[i].close) - n(a[i - 1].close);
    if (d > 0) gain += d; else loss -= d;
  }
  if (!loss) return gain ? 100 : 50;
  return 100 - 100 / (1 + gain / loss);
}
export function atr(candles, period = 14) {
  const a = closed(candles);
  if (a.length < period + 1) return 0;
  let total = 0;
  for (let i = a.length - period; i < a.length; i++) {
    const h = n(a[i].high), l = n(a[i].low), pc = n(a[i - 1].close);
    total += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return total / period;
}
export function vwap(candles, period = 20) {
  const a = closed(candles).slice(-period);
  let pv = 0, vol = 0;
  for (const c of a) {
    const v = n(c.volume);
    pv += ((n(c.high) + n(c.low) + n(c.close)) / 3) * v;
    vol += v;
  }
  return vol ? pv / vol : n(a.at(-1)?.close);
}
export function volumeRatio(candles, period = 20) {
  const a = closed(candles);
  if (a.length < period + 1) return 0;
  const current = n(a.at(-1)?.volume);
  const base = a.slice(-period - 1, -1).reduce((s, c) => s + n(c.volume), 0) / period;
  return base ? current / base : 0;
}
function trendFor5m(c) {
  const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), p = n(closed(c).at(-1)?.close);
  if (p > e9 && e9 > e21 && e21 > e50) return 'BULL';
  if (p < e9 && e9 < e21 && e21 < e50) return 'BEAR';
  return 'FLAT';
}
function trendFor15m(c) {
  const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50);
  if (e9 > e21 && e21 > e50) return 'BULL';
  if (e9 < e21 && e21 < e50) return 'BEAR';
  return 'FLAT';
}
function roundToTick(v, tick) {
  if (!tick || !Number.isFinite(v)) return v;
  return Math.round(v / tick) * tick;
}
export function analyse(ticker, product, c1, c5, c15, btc5, btc15, strategy, cfg) {
  const price = n(ticker.mark_price || ticker.close);
  const change = n(ticker.ltp_change_24h);
  const bid = n(ticker.quotes?.best_bid);
  const ask = n(ticker.quotes?.best_ask);
  const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 99;
  const cEntry = strategy === 'MOMENTUM' ? c5 : c1;
  const main = c5;
  const closed5 = closed(c5), closedEntry = closed(cEntry), closed15 = closed(c15);
  const e9 = ema(main, 9), e21 = ema(main, 21), e50 = ema(main, 50);
  const r = rsi(main), vr = volumeRatio(main), a5 = atr(main), a15 = atr(c15), vw = vwap(closedEntry.length ? cEntry : main);
  const t5 = trendFor5m(main), t15 = trendFor15m(c15);
  const btcT5 = trendFor5m(btc5), btcT15 = trendFor15m(btc15);
  const last5 = closed5.at(-1), prev5 = closed5.at(-2);
  const rangeAtr = a5 > 0 ? Math.abs(n(last5?.high) - n(last5?.low)) / a5 : 99;
  const emaDistanceAtr = a5 > 0 ? Math.abs(price - e21) / a5 : 99;
  const bullish = t5 === 'BULL' && t15 === 'BULL';
  const bearish = t5 === 'BEAR' && t15 === 'BEAR';
  let side = '';
  if (bullish && n(last5?.close) >= n(prev5?.close) && price >= e21) side = 'BUY';
  if (bearish && n(last5?.close) <= n(prev5?.close) && price <= e21) side = 'SELL';
  const antiChase = side === 'BUY' ? change <= 12 : side === 'SELL' ? change >= -12 : false;
  const btcOk = side === 'BUY'
    ? btcT5 !== 'BEAR' && btcT15 !== 'BEAR'
    : side === 'SELL'
      ? btcT5 !== 'BULL' && btcT15 !== 'BULL'
      : false;
  const rsiOk = strategy === 'MOMENTUM'
    ? (side === 'BUY' ? r >= 54 && r <= 68 : side === 'SELL' ? r >= 32 && r <= 46 : false)
    : (side === 'BUY' ? r >= 52 && r <= 72 && price >= vw : side === 'SELL' ? r >= 28 && r <= 48 && price <= vw : false);
  const stopMin = (cfg.minStopPct / 100);
  const atrPct = a5 > 0 ? 1.25 * a5 / Math.max(price, 1) : 0;
  const stopPct = Math.max(stopMin, atrPct);
  const rawSl = side === 'BUY' ? price * (1 - stopPct) : side === 'SELL' ? price * (1 + stopPct) : 0;
  const tick = n(product.tick_size);
  const sl = roundToTick(rawSl, tick);
  const riskDistance = side ? Math.abs(price - sl) : 0;
  const tp1 = side === 'BUY' ? roundToTick(price + riskDistance, tick) : side === 'SELL' ? roundToTick(price - riskDistance, tick) : 0;
  const tp = side === 'BUY' ? roundToTick(price + riskDistance * cfg.rr, tick) : side === 'SELL' ? roundToTick(price - riskDistance * cfg.rr, tick) : 0;
  const fee = n(product.taker_commission_rate);
  const feeRiskRatio = riskDistance > 0 ? (2 * fee * price + spreadPct / 100 * price) / riskDistance : 99;
  const costGateRatio = strategy === 'MOMENTUM' ? 0.15 : 0.20;
  const score = Math.min(100, Math.round(
    (bullish || bearish ? 20 : 0) +
    (t5 === t15 && t5 !== 'FLAT' ? 20 : 0) +
    (vr >= 1.6 ? 15 : Math.min(vr / 1.6, 1) * 15) +
    (rsiOk ? 15 : 0) +
    (emaDistanceAtr <= 1.75 ? 10 : 0) +
    (rangeAtr <= 2.25 ? 5 : 0) +
    (antiChase ? 5 : 0) +
    (btcOk ? 5 : 0) +
    (spreadPct <= 0.25 ? 5 : 0)
  ));
  const stage = score >= cfg.scoreMin && side && vr >= 1.6 && rsiOk ? 'CONFIRMED'
    : (score >= 50 || side ? 'SETUP' : 'WATCH');
  const blocked = [];
  if (stage !== 'CONFIRMED') blocked.push('Signal not CONFIRMED / score below threshold');
  if (!rsiOk) blocked.push('RSI/VWAP');
  if (vr < 1.6) blocked.push('Volume spike < 1.60x');
  if (!antiChase) blocked.push('24h anti-chase');
  if (rangeAtr > 2.25) blocked.push('5m range > 2.25x ATR');
  if (emaDistanceAtr > 1.75) blocked.push('Price > 1.75x ATR from EMA21');
  if (!btcOk) blocked.push('BTC regime');
  if (spreadPct > 0.25) blocked.push('Spread > 0.25%');
  if (feeRiskRatio > costGateRatio) blocked.push('Fee + spread > allowed 1R cost');
  if (!price || !riskDistance || !sl) blocked.push('Invalid price/stop');
  return {
    symbol: ticker.symbol, productId: product.id, price, change, turnover: n(ticker.turnover_usd || ticker.turnover),
    spreadPct, side, stage, score, volumeSpike: vr, rsi: r, trend: t5, confirmTrend: t15,
    btcTrend: btcT5, btcConfirmTrend: btcT15, ema21: e21, atr5: a5, atr15: a15, vwap: vw,
    rangeAtr, emaDistanceAtr, stopPct, sl, tp1, tp, support: Math.min(...closed5.slice(-20).map(c => n(c.low))),
    resistance: Math.max(...closed5.slice(-20).map(c => n(c.high))),
    takerFee: fee, makerFee: n(product.maker_commission_rate), feeRiskRatio, costGateRatio,
    contractValue: n(product.contract_value), tickSize: tick, notionalType: product.notional_type,
    maxLeverageNotional: n(product.max_leverage_notional), blocked, ready: stage === 'CONFIRMED' && blocked.length <= 1,
    candlesFresh: closedEntry.length >= 30 && closed15.length >= 30 && closed5.length >= 30
  };
}