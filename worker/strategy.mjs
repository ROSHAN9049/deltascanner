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
function expiryFromOptionSymbol(symbol) {
  const m = String(symbol || '').match(/^[CP]-[A-Z0-9]+-[0-9.]+-(\d{6})$/);
  if (!m) return 0;
  const dd = Number(m[1].slice(0, 2));
  const mm = Number(m[1].slice(2, 4));
  const yy = Number(m[1].slice(4, 6));
  const year = 2000 + yy;
  const ts = Date.UTC(year, Math.max(0, mm - 1), dd, 8, 0, 0);
  return Number.isFinite(ts) ? ts : 0;
}

function optionStrikeFromSymbol(symbol) {
  const m = String(symbol || '').match(/^[CP]-[A-Z0-9]+-([0-9.]+)-\d{6}$/);
  return m ? n(m[1]) : 0;
}

function optionTypeFromTicker(ticker) {
  const t = String(ticker?.contract_type || '').toLowerCase();
  if (t === 'call_options') return 'CALL';
  if (t === 'put_options') return 'PUT';
  const s = String(ticker?.symbol || '').toUpperCase();
  return s.startsWith('C-') ? 'CALL' : s.startsWith('P-') ? 'PUT' : '';
}

function optionGreeks(ticker) {
  const g = ticker?.greeks && typeof ticker.greeks === 'object' ? ticker.greeks : {};
  return {
    delta: n(g.delta ?? ticker.delta),
    gamma: n(g.gamma ?? ticker.gamma),
    theta: n(g.theta ?? ticker.theta),
    vega: n(g.vega ?? ticker.vega),
    rho: n(g.rho ?? ticker.rho)
  };
}

export function analyseOption(ticker, underlying, strategy, cfg = {}) {
  const symbol = String(ticker?.symbol || '').toUpperCase();
  const optionType = optionTypeFromTicker(ticker);
  const strike = optionStrikeFromSymbol(symbol);
  const expiryMs = expiryFromOptionSymbol(symbol);
  const dte = expiryMs > 0 ? (expiryMs - Date.now()) / 86400000 : 0;
  const mark = n(ticker?.mark_price || ticker?.close);
  const bid = n(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
  const ask = n(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
  const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 99;
  const oi = n(ticker?.open_interest ?? ticker?.openInterest ?? ticker?.oi);
  const volume = n(ticker?.volume);
  const greeks = optionGreeks(ticker);
  const delta = Math.abs(greeks.delta);
  const minDte = Math.max(1, n(cfg.minDays) || 2);
  const maxDte = Math.max(minDte, n(cfg.maxDays) || 14);
  const minOi = Math.max(0, n(cfg.minOi) || 50);
  const minVol = Math.max(0, n(cfg.minVolume) || 1);
  const maxSpread = Math.max(0.1, n(cfg.maxSpreadPct) || 1.5);
  const isBuy = strategy === 'OPTIONS_BUY';
  const underlyingBuy = String(underlying?.side || '').toUpperCase() === 'BUY';
  const targetType = isBuy ? (underlyingBuy ? 'CALL' : 'PUT') : (underlyingBuy ? 'PUT' : 'CALL');
  const deltaMin = n(isBuy ? cfg.buyMinDelta : cfg.sellMinDelta) || (isBuy ? 0.45 : 0.20);
  const deltaMax = n(isBuy ? cfg.buyMaxDelta : cfg.sellMaxDelta) || (isBuy ? 0.65 : 0.35);
  const underlyingScoreMin = n(cfg.scoreMin || 70);
  const underlyingOk = String(underlying?.stage || '') === 'CONFIRMED' && n(underlying?.score) >= underlyingScoreMin;
  const directionOk = !!underlying?.side && optionType === targetType;
  const deltaOk = delta >= deltaMin && delta <= deltaMax;
  const dteOk = dte >= minDte && dte <= maxDte;
  const liqOk = mark > 0 && bid > 0 && ask > 0 && spreadPct <= maxSpread && oi >= minOi && volume >= minVol;
  const antiChaseOk = Math.abs(n(underlying?.change)) <= (isBuy ? 12 : 8);
  const noExpiryRisk = dte >= minDte;
  const score = Math.min(100, Math.round(
    (underlyingOk ? 30 : Math.min(n(underlying?.score) / 80, 1) * 30) +
    (directionOk ? 15 : 0) +
    (deltaOk ? 15 : 0) +
    (liqOk ? 20 : Math.max(0, 20 - Math.min(spreadPct / Math.max(maxSpread, 0.1), 2) * 10)) +
    (dteOk ? 10 : 0) +
    (antiChaseOk ? 10 : 0)
  ));
  const blocked = [];
  if (!underlyingOk) blocked.push('Underlying CONFIRMED / score < ' + underlyingScoreMin);
  if (!directionOk) blocked.push('Underlying direction / option type mismatch');
  if (!deltaOk) blocked.push('Delta outside target band');
  if (!dteOk) blocked.push('Expiry outside configured DTE');
  if (!liqOk) blocked.push('Option liquidity / spread / OI');
  if (!antiChaseOk) blocked.push(isBuy ? '24h anti-chase' : 'Short-option breakout risk');
  if (!noExpiryRisk) blocked.push('Expiry risk');
  const stage = score >= 80 && blocked.length === 0 ? 'CONFIRMED' : (score >= 55 ? 'SETUP' : 'WATCH');
  const stopPct = Math.max(0.01, n(cfg.buyStopPct) || 25);
  const tp1Pct = Math.max(0.01, n(cfg.buyTp1Pct) || 30);
  const tpPct = Math.max(tp1Pct, n(cfg.buyTpPct) || 60);
  const sl = isBuy && mark > 0 ? mark * (1 - stopPct / 100) : 0;
  const tp1 = isBuy && mark > 0 ? mark * (1 + tp1Pct / 100) : 0;
  const tp = isBuy && mark > 0 ? mark * (1 + tpPct / 100) : 0;
  return {
    symbol, optionType, strike, expiryMs, dte, mark, bid, ask, spreadPct, oi, volume,
    delta: greeks.delta, gamma: greeks.gamma, theta: greeks.theta, vega: greeks.vega,
    targetType, strategy, side: isBuy ? 'BUY' : 'SELL', score, stage, blocked,
    ready: stage === 'CONFIRMED' && blocked.length === 0,
    underlyingSymbol: String(underlying?.symbol || ''),
    underlyingScore: n(underlying?.score), underlyingSide: String(underlying?.side || ''),
    underlyingChange: n(underlying?.change), sl, tp1, tp
  };
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
  const isScalping = strategy === 'SCALPING';

  // Entry indicators use the engine timeframe. Direction remains based on
  // the 5m/15m trend stack so scalping does not become a noisy 1m-only system.
  const entryCandles = isScalping ? c1 : c5;
  const closedEntry = closed(entryCandles);
  const closed5 = closed(c5);
  const closed15 = closed(c15);

  const entryE9 = ema(entryCandles, 9);
  const entryE21 = ema(entryCandles, 21);
  const entryE50 = ema(entryCandles, 50);
  const r = rsi(entryCandles);
  const entryVolume = volumeRatio(entryCandles);
  const contextVolume = volumeRatio(c5);
  // Some Delta TESTNET symbols have sparse 1m prints. Require a real volume
  // impulse on either the entry timeframe or the 5m context candle.
  const vr = Math.max(entryVolume, contextVolume);
  const entryAtr = atr(entryCandles);
  const a5 = atr(c5);
  const a15 = atr(c15);
  const vw = vwap(entryCandles);

  const t5 = trendFor5m(c5);
  const t15 = trendFor15m(c15);
  const btcT5 = trendFor5m(btc5);
  const btcT15 = trendFor15m(btc15);
  const lastEntry = closedEntry.at(-1);

  const bullish = t5 === 'BULL' && t15 !== 'BEAR';
  const bearish = t5 === 'BEAR' && t15 !== 'BULL';

  const volumeMin = n(cfg.volumeMin || 1.25);
  const antiChaseMax = n(cfg.antiChasePct || 15);
  const rangeMax = n(cfg.rangeAtrMax || 3.0);
  const emaMax = n(cfg.emaDistanceMax || 2.5);
  const spreadMax = n(cfg.spreadMaxPct || 0.35);
  const costGateRatio = n(cfg.costGateRatio || (isScalping ? 0.25 : 0.20));
  const scoreMin = n(cfg.scoreMin || 70);
  const btcOverrideScoreMin = n(cfg.btcOverrideScoreMin || 90);
  const btcOverrideVolumeMin = n(cfg.btcOverrideVolumeMin || 1.5);
  const pullbackAllowanceAtr = n(cfg.pullbackAllowanceAtr || (isScalping ? 1.25 : 0.75));

  const entryRoom = entryAtr > 0 ? pullbackAllowanceAtr * entryAtr : 0;
  let side = '';
  if (bullish && price > 0 && (entryE21 <= 0 || price >= entryE21 - entryRoom)) side = 'BUY';
  if (bearish && price > 0 && (entryE21 <= 0 || price <= entryE21 + entryRoom)) side = 'SELL';

  const antiChase = side === 'BUY'
    ? change <= antiChaseMax
    : side === 'SELL'
      ? change >= -antiChaseMax
      : true;

  // BTC only vetoes a setup when both confirmation frames agree against it.
  // A FLAT/mixed BTC regime is treated as neutral rather than a hard blocker.
  const btcStronglyOpposed = side === 'BUY'
    ? btcT5 === 'BEAR' && btcT15 === 'BEAR'
    : side === 'SELL'
      ? btcT5 === 'BULL' && btcT15 === 'BULL'
      : false;
  const btcOk = !btcStronglyOpposed;

  const rsiOk = side === 'BUY'
    ? (isScalping
      ? r >= 47 && r <= 75 && (vw <= 0 || price >= vw)
      : r >= 52 && r <= 72)
    : side === 'SELL'
      ? (isScalping
        ? r >= 25 && r <= 53 && (vw <= 0 || price <= vw)
        : r >= 28 && r <= 48)
      : false;

  const rangeAtr = entryAtr > 0 && lastEntry
    ? Math.abs(n(lastEntry.high) - n(lastEntry.low)) / entryAtr
    : 99;
  const emaDistanceAtr = entryAtr > 0 && entryE21 > 0
    ? Math.abs(price - entryE21) / entryAtr
    : 99;

  const stopMin = n(cfg.minStopPct || (isScalping ? 0.75 : 0.95)) / 100;
  const atrStopPct = entryAtr > 0 ? 1.25 * entryAtr / Math.max(price, 1) : 0;
  const marketCostPct = Math.max(0, 2 * n(product.taker_commission_rate) + spreadPct / 100);
  const costFloorStopPct = costGateRatio > 0 ? marketCostPct / costGateRatio : 0;
  const stopPct = Math.max(stopMin, atrStopPct, costFloorStopPct);

  const rawSl = side === 'BUY'
    ? price * (1 - stopPct)
    : side === 'SELL'
      ? price * (1 + stopPct)
      : 0;
  const tick = n(product.tick_size);
  const sl = side ? roundToTick(rawSl, tick) : 0;
  const riskDistance = side ? Math.abs(price - sl) : 0;
  const tp1 = side === 'BUY'
    ? roundToTick(price + riskDistance, tick)
    : side === 'SELL'
      ? roundToTick(price - riskDistance, tick)
      : 0;
  const rr = n(cfg.rr || 2.0);
  const tp = side === 'BUY'
    ? roundToTick(price + riskDistance * rr, tick)
    : side === 'SELL'
      ? roundToTick(price - riskDistance * rr, tick)
      : 0;

  const fee = n(product.taker_commission_rate);
  const feeRiskRatio = riskDistance > 0
    ? (2 * fee * price + spreadPct / 100 * price) / riskDistance
    : 99;

  const trendAligned = bullish || bearish;
  const localScore = Math.round(
    (trendAligned ? 20 : 0) +
    (t5 === t15 && t5 !== 'FLAT' ? 20 : trendAligned ? 10 : 0) +
    (vr >= volumeMin ? 15 : Math.min(vr / Math.max(volumeMin, 0.01), 1) * 15) +
    (rsiOk ? 15 : 0) +
    (emaDistanceAtr <= emaMax ? 10 : 0) +
    (rangeAtr <= rangeMax ? 5 : 0) +
    (antiChase ? 5 : 0) +
    (spreadPct <= spreadMax ? 5 : 0)
  );
  const score = Math.min(100, localScore + (btcOk ? 5 : 0));

  const btcRegimeOverride =
    !!side &&
    btcStronglyOpposed &&
    localScore >= btcOverrideScoreMin &&
    t5 === t15 &&
    t5 !== 'FLAT' &&
    vr >= btcOverrideVolumeMin &&
    rsiOk &&
    antiChase &&
    rangeAtr <= rangeMax &&
    emaDistanceAtr <= emaMax &&
    spreadPct <= spreadMax &&
    feeRiskRatio <= costGateRatio &&
    !!price && !!riskDistance && !!sl;

  const hardReady =
    !!side &&
    score >= scoreMin &&
    !!price &&
    !!riskDistance &&
    !!sl &&
    vr >= volumeMin &&
    rsiOk &&
    antiChase &&
    rangeAtr <= rangeMax &&
    emaDistanceAtr <= emaMax &&
    (btcOk || btcRegimeOverride) &&
    spreadPct <= spreadMax &&
    feeRiskRatio <= costGateRatio;

  const stage = hardReady ? 'CONFIRMED' : (score >= 45 || side ? 'SETUP' : 'WATCH');
  const blocked = [];

  if (!side) {
    blocked.push('No directional trigger');
  } else {
    if (score < scoreMin) blocked.push('Signal score below ' + scoreMin);
    if (!rsiOk) blocked.push('RSI/VWAP');
    if (vr < volumeMin) blocked.push('Volume spike < ' + volumeMin.toFixed(2) + 'x');
    if (!antiChase) blocked.push('24h anti-chase');
    if (rangeAtr > rangeMax) blocked.push('Entry candle range > ' + rangeMax.toFixed(2) + 'x ATR');
    if (emaDistanceAtr > emaMax) blocked.push('Price > ' + emaMax.toFixed(2) + 'x ATR from entry EMA21');
    if (!btcOk && !btcRegimeOverride) blocked.push('BTC regime');
    if (spreadPct > spreadMax) blocked.push('Spread > ' + spreadMax.toFixed(2) + '%');
    if (feeRiskRatio > costGateRatio) blocked.push('Fee + spread > allowed 1R cost');
    if (!price || !riskDistance || !sl) blocked.push('Invalid price/stop');
  }

  const rawCandleTs = Number(closedEntry.at(-1)?.time ?? closedEntry.at(-1)?.timestamp ?? closedEntry.at(-1)?.t ?? 0);
  const signalCandleTs = rawCandleTs > 1e12
    ? Math.floor(rawCandleTs / 60000)
    : rawCandleTs > 1e9
      ? Math.floor(rawCandleTs / 60)
      : 0;

  const supportWindow = closed5.slice(-20).map(c => n(c.low)).filter(v => v > 0);
  const resistanceWindow = closed5.slice(-20).map(c => n(c.high)).filter(v => v > 0);

  return {
    symbol: ticker.symbol, productId: product.id, price, change,
    turnover: n(ticker.turnover_usd || ticker.turnover),
    signalCandleTs, spreadPct, side, stage, score,
    volumeSpike: vr, entryVolumeSpike: entryVolume, contextVolumeSpike: contextVolume,
    rsi: r, trend: t5, confirmTrend: t15, btcTrend: btcT5, btcConfirmTrend: btcT15,
    ema21: entryE21, ema9: entryE9, ema50: entryE50,
    atrEntry: entryAtr, atr5: a5, atr15: a15, vwap: vw,
    rangeAtr, emaDistanceAtr, pullbackAllowanceAtr,
    stopPct, costFloorStopPct, sl, tp1, tp,
    support: supportWindow.length ? Math.min(...supportWindow) : 0,
    resistance: resistanceWindow.length ? Math.max(...resistanceWindow) : 0,
    takerFee: fee, makerFee: n(product.maker_commission_rate),
    feeRiskRatio, costGateRatio, localScore,
    btcRegimeOverride: !!btcRegimeOverride,
    btcStronglyOpposed,
    btcOverrideScoreMin, btcOverrideVolumeMin,
    contractValue: n(product.contract_value), tickSize: tick,
    notionalType: product.notional_type, maxLeverageNotional: n(product.max_leverage_notional),
    blocked, ready: hardReady,
    candlesFresh: closedEntry.length >= 30 && closed15.length >= 30 && closed5.length >= 30
  };
}
