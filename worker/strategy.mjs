const n = v => Number.isFinite(+v) ? +v : 0;

const RESOLUTION_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };

export function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const map = new Map();
  for (const raw of rows) {
    const time = n(raw?.time);
    const open = n(raw?.open), high = n(raw?.high), low = n(raw?.low), close = n(raw?.close);
    if (!time || !open || !high || !low || !close) continue;
    const t = time > 2_000_000_000_000 ? time / 1_000_000 : time;
    map.set(t, {
      time: t,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Math.max(0, n(raw?.volume || raw?.v))
    });
  }
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-100);
}

export function closed(candles) {
  const a = normalizeCandles(candles);
  return a.length > 2 ? a.slice(0, -1) : [];
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

export function vwap(candles, period = 30) {
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

function macdHistogram(candles) {
  const a = closed(candles).map(c => n(c.close));
  if (a.length < 35) return 0;
  const calc = (period, values) => {
    const k = 2 / (period + 1);
    let e = values[0];
    for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  };
  const macd = calc(12, a) - calc(26, a);
  const signalValues = [];
  for (let i = 0; i < a.length; i++) {
    const slice = a.slice(0, i + 1);
    if (slice.length >= 26) signalValues.push(calc(12, slice) - calc(26, slice));
  }
  const signal = signalValues.length >= 9 ? calc(9, signalValues) : 0;
  return macd - signal;
}

function trendForBase(c) {
  const e5 = ema(c, 5), e13 = ema(c, 13), p = n(closed(c).at(-1)?.close);
  if (p > e5 && e5 > e13) return 'BULL';
  if (p < e5 && e5 < e13) return 'BEAR';
  return 'FLAT';
}

function trendForContext(c) {
  const e20 = ema(c, 20), e50 = ema(c, 50);
  if (e20 > e50) return 'BULL';
  if (e20 < e50) return 'BEAR';
  return 'FLAT';
}

function roundToTick(v, tick) {
  if (!tick || !Number.isFinite(v)) return v;
  return Math.round(v / tick) * tick;
}

function pctChange(now, then) {
  const a = n(now), b = n(then);
  return b ? (a - b) / b * 100 : 0;
}

export function analyse(ticker, product, c1, c5, c15, btc5, btc15, strategy, cfg) {
  const main = strategy === 'SCALPING' ? c1 : c5;
  const closedMain = closed(main);
  const closed15 = closed(c15);
  const closedBtc5 = closed(btc5);
  const closedBtc15 = closed(btc15);
  const candlesFresh = closedMain.length >= 60 && closed15.length >= 60 && closedBtc5.length >= 60 && closedBtc15.length >= 60;

  const price = n(ticker.mark_price || ticker.close);
  const change = n(ticker.ltp_change_24h);
  const bid = n(ticker.quotes?.best_bid);
  const ask = n(ticker.quotes?.best_ask);
  const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 99;

  const e5 = ema(main, 5), e13 = ema(main, 13), e21 = ema(main, 21);
  const e20 = ema(c15, 20), e50 = ema(c15, 50);
  const r = rsi(main), vr = volumeRatio(main), a = atr(main), a15 = atr(c15), vw = vwap(main, 30);
  const macd = macdHistogram(main);
  const tBase = trendForBase(main), t15 = trendForContext(c15);
  const btcT5 = trendForBase(btc5), btcT15 = trendForContext(btc15);

  const lastMain = closedMain.at(-1), prevMain = closedMain.at(-2);
  const momentumPct = pctChange(price, closedMain.at(-6)?.close || price);
  const contextPct = pctChange(closed15.at(-1)?.close || price, closed15.at(-4)?.close || price);
  const rangeAtr = a > 0 ? Math.abs(n(lastMain?.high) - n(lastMain?.low)) / a : 99;
  const emaDistanceAtr = a > 0 ? Math.abs(price - e21) / a : 99;

  const longAligned = e5 > e13 && e20 > e50 && price >= vw && momentumPct >= 0;
  const shortAligned = e5 < e13 && e20 < e50 && price <= vw && momentumPct <= 0;
  const bullishContext = tBase === 'BULL' && t15 === 'BULL';
  const bearishContext = tBase === 'BEAR' && t15 === 'BEAR';

  const longRsi = strategy === 'MOMENTUM' ? r >= 55 && r <= 72 : r >= 52 && r <= 72 && price >= vw;
  const shortRsi = strategy === 'MOMENTUM' ? r >= 28 && r <= 45 : r >= 28 && r <= 48 && price <= vw;
  const longVolume = vr >= 1.6;
  const longAnti = change <= 12;
  const shortAnti = change >= -12;
  const btcLongOk = btcT5 !== 'BEAR' && btcT15 !== 'BEAR';
  const btcShortOk = btcT5 !== 'BULL' && btcT15 !== 'BULL';
  const longCandidate = longAligned || bullishContext;
  const shortCandidate = shortAligned || bearishContext;

  let longScore = 0, shortScore = 0;
  if (e5 > e13) longScore += 12; else if (e5 < e13) shortScore += 12;
  if (e20 > e50) longScore += 10; else if (e20 < e50) shortScore += 10;
  if (longRsi) longScore += 14; if (shortRsi) shortScore += 14;
  if (macd > 0) longScore += 12; else if (macd < 0) shortScore += 12;
  if (price > vw) longScore += 8; else if (price < vw) shortScore += 8;
  if (vr >= 1.6) {
    if (momentumPct >= 0) longScore += 14; else shortScore += 14;
  } else {
    const partial = Math.max(0, Math.min(1, vr / 1.6)) * 14;
    if (momentumPct >= 0) longScore += partial; else shortScore += partial;
  }
  if (Math.abs(momentumPct) >= (strategy === 'MOMENTUM' ? 0.25 : 0.12)) {
    if (momentumPct > 0) longScore += 10; else if (momentumPct < 0) shortScore += 10;
  }
  if (contextPct > 0) longScore += 5; else if (contextPct < 0) shortScore += 5;
  if (t15 === 'BULL') longScore += 15; else if (t15 === 'BEAR') shortScore += 15;
  if (tBase === t15 && tBase !== 'FLAT') {
    if (tBase === 'BULL') longScore += 8; else if (tBase === 'BEAR') shortScore += 8;
  }
  if (rangeAtr <= 2.25) { longScore += 3; shortScore += 3; }
  if (emaDistanceAtr <= 1.75) { longScore += 3; shortScore += 3; }
  if (spreadPct <= 0.25) { longScore += 3; shortScore += 3; }

  const winnerIsLong = longScore >= shortScore;
  const side = winnerIsLong ? 'BUY' : 'SELL';
  const winner = Math.max(longScore, shortScore);
  const loser = Math.min(longScore, shortScore);
  const separation = Math.max(0, winner - loser);
  const score = Math.max(0, Math.min(100, Math.round(winner * 0.88 + Math.min(12, separation * 0.22))));

  const btcOk = side === 'BUY' ? btcLongOk : btcShortOk;
  const rsiOk = side === 'BUY' ? longRsi : shortRsi;
  const antiChase = side === 'BUY' ? longAnti : shortAnti;
  const aligned = side === 'BUY' ? longAligned : shortAligned;

  const highVol = a15 > 0 && price > 0 ? (a15 / price) * 100 > 2.2 : false;
  const lowVol = a15 > 0 && price > 0 ? (a15 / price) * 100 < 0.15 : false;
  const regime = highVol ? 'HIGH_VOLATILITY' : lowVol ? 'LOW_VOLATILITY' : t15 === 'BULL' ? 'TREND_UP' : t15 === 'BEAR' ? 'TREND_DOWN' : 'RANGE';

  const stopMin = n(cfg.minStopPct) / 100;
  const atrPct = a > 0 && price > 0 ? 1.25 * a / price : 0;
  const stopPct = Math.max(stopMin, atrPct);
  const rawSl = side === 'BUY' ? price * (1 - stopPct) : price * (1 + stopPct);
  const tick = n(product.tick_size);
  const sl = roundToTick(rawSl, tick);
  const riskDistance = side ? Math.abs(price - sl) : 0;
  const tp1 = side === 'BUY' ? roundToTick(price + riskDistance, tick) : roundToTick(price - riskDistance, tick);
  const tp = side === 'BUY' ? roundToTick(price + riskDistance * n(cfg.rr || 2.5), tick) : roundToTick(price - riskDistance * n(cfg.rr || 2.5), tick);

  const fee = n(product.taker_commission_rate);
  const feeRiskRatio = riskDistance > 0 ? (2 * fee * price + spreadPct / 100 * price) / riskDistance : 99;
  const costGateRatio = strategy === 'MOMENTUM' ? 0.15 : 0.20;

  const stage = !candlesFresh || highVol
    ? 'BLOCKED'
    : score >= n(cfg.scoreMin || 80) && aligned && vr >= 1.6 && rsiOk
      ? 'CONFIRMED'
      : score >= 60 || side
        ? 'SETUP'
        : 'WATCH';

  const blocked = [];
  if (stage !== 'CONFIRMED') blocked.push('Signal not CONFIRMED / score below threshold');
  if (!candlesFresh) blocked.push('Fresh closed candles unavailable');
  if (!rsiOk) blocked.push(strategy === 'SCALPING' ? 'RSI/VWAP' : 'RSI range');
  if (vr < 1.6) blocked.push('Volume spike < 1.60x');
  if (!antiChase) blocked.push('24h anti-chase');
  if (rangeAtr > 2.25) blocked.push('5m range > 2.25x ATR');
  if (emaDistanceAtr > 1.75) blocked.push('Price > 1.75x ATR from EMA21');
  if (!btcOk) blocked.push('BTC regime');
  if (spreadPct > 0.25) blocked.push('Spread > 0.25%');
  if (feeRiskRatio > costGateRatio) blocked.push('Fee + spread > allowed 1R cost');
  if (!price || !riskDistance || !sl) blocked.push('Invalid price/stop');
  if (!Number.isFinite(vr) || !Number.isFinite(r) || !Number.isFinite(a)) blocked.push('Indicator calculation unavailable');

  const quality = {
    trend: Math.min(20, Math.round(Math.abs(e5 - e13) / Math.max(a, 1e-8) * 3 + (tBase === t15 && tBase !== 'FLAT' ? 8 : 4))),
    momentum: Math.min(20, Math.round(Math.abs(momentumPct) * 16)),
    volume: Math.min(15, Math.round(Math.min(vr, 1.6) / 1.6 * 15)),
    volatility: Math.min(15, Math.round(Math.min(3, a > 0 && price > 0 ? a / price * 100 : 0) * 5)),
    structure: Math.min(15, Math.round(Math.abs(price - vw) / Math.max(a, 1e-8) * 3 + 5)),
    regime: highVol ? 2 : lowVol ? 3 : t15 === 'BULL' || t15 === 'BEAR' ? 15 : 8,
    total: score
  };

  return {
    symbol: ticker.symbol,
    productId: product.id,
    price,
    change,
    turnover: n(ticker.turnover_usd || ticker.turnover),
    spreadPct,
    side,
    stage,
    score,
    quality,
    volumeSpike: vr,
    rsi: r,
    trend: tBase,
    confirmTrend: t15,
    btcTrend: btcT5,
    btcConfirmTrend: btcT15,
    regime,
    ema21: e21,
    atr5: a,
    atr15: a15,
    vwap: vw,
    macd,
    momentumPct,
    contextPct,
    rangeAtr,
    emaDistanceAtr,
    stopPct,
    sl,
    tp1,
    tp,
    support: closedMain.length ? Math.min(...closedMain.slice(-20).map(c => n(c.low))) : 0,
    resistance: closedMain.length ? Math.max(...closedMain.slice(-20).map(c => n(c.high))) : 0,
    takerFee: fee,
    makerFee: n(product.maker_commission_rate),
    feeRiskRatio,
    costGateRatio,
    contractValue: n(product.contract_value),
    tickSize: tick,
    notionalType: product.notional_type,
    maxLeverageNotional: n(product.max_leverage_notional),
    blocked: [...new Set(blocked)],
    ready: stage === 'CONFIRMED' && blocked.length === 0,
    candlesFresh
  };
}