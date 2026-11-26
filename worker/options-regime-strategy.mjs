const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const average = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const alpha = 2 / (period + 1);
  let current = average(values.slice(0, period));
  const output = Array(values.length).fill(null);
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * alpha + current * (1 - alpha);
    output[index] = current;
  }
  return output;
}

function atrSeries(candles, period = 14) {
  const ranges = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  if (ranges.length < period) return [];
  const output = Array(ranges.length).fill(null);
  let current = average(ranges.slice(0, period));
  output[period - 1] = current;
  for (let index = period; index < ranges.length; index += 1) {
    current = ((current * (period - 1)) + ranges[index]) / period;
    output[index] = current;
  }
  return output;
}

function adxValue(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 2) return null;
  const tr = [];
  const plusDm = [];
  const minusDm = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  let smoothTr = tr.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dx = [];
  for (let index = period; index <= tr.length; index += 1) {
    if (index > period) {
      smoothTr = smoothTr - (smoothTr / period) + tr[index - 1];
      smoothPlus = smoothPlus - (smoothPlus / period) + plusDm[index - 1];
      smoothMinus = smoothMinus - (smoothMinus / period) + minusDm[index - 1];
    }
    if (!(smoothTr > 0)) continue;
    const plusDi = 100 * smoothPlus / smoothTr;
    const minusDi = 100 * smoothMinus / smoothTr;
    const denominator = plusDi + minusDi;
    dx.push(denominator > 0 ? 100 * Math.abs(plusDi - minusDi) / denominator : 0);
  }
  if (dx.length < period) return null;
  let adx = average(dx.slice(0, period));
  for (let index = period; index < dx.length; index += 1) {
    adx = ((adx * (period - 1)) + dx[index]) / period;
  }
  return Number.isFinite(adx) ? adx : null;
}

function assessTimeframe(rawCandles, period = 14) {
  // Callers pass normalized REST candles; discard the still-forming tail.
  const candles = Array.isArray(rawCandles) ? rawCandles.slice(0, -1) : [];
  if (candles.length < period * 2 + 8) return { valid: false, reason: 'INSUFFICIENT_CANDLES' };
  if (candles.some(row => ![row.open, row.high, row.low, row.close].every(value => Number.isFinite(Number(value))))) {
    return { valid: false, reason: 'INVALID_CANDLE' };
  }

  const closes = candles.map(row => Number(row.close));
  const ema = emaSeries(closes, 21);
  const atr = atrSeries(candles, period);
  const adx = adxValue(candles, period);
  const index = candles.length - 1;
  const currentEma = ema[index];
  const priorEma = ema[index - 5];
  const currentAtr = atr[index - 1];
  if (![adx, currentEma, priorEma, currentAtr].every(Number.isFinite) || !(currentAtr > 0)) {
    return { valid: false, reason: 'INDICATOR_UNAVAILABLE' };
  }
  const slopeAtr = (currentEma - priorEma) / currentAtr;
  const trending = adx > 25 && Math.abs(slopeAtr) > 0.3;
  const lastFiveInsideBand = candles.slice(-5).every((candle, offset) => {
    const candleIndex = candles.length - 5 + offset;
    const emaValue = ema[candleIndex];
    const atrValue = atr[candleIndex - 1];
    return Number.isFinite(emaValue) && Number.isFinite(atrValue) && atrValue > 0 &&
      Number(candle.close) >= emaValue - 1.5 * atrValue &&
      Number(candle.close) <= emaValue + 1.5 * atrValue;
  });
  const sideways = adx < 20 && lastFiveInsideBand;
  return {
    valid: true,
    adx,
    ema21: currentEma,
    atr14: currentAtr,
    emaSlopeAtr: slopeAtr,
    lastFiveInsideBand,
    regime: trending ? 'TRENDING' : sideways ? 'SIDEWAYS' : 'UNKNOWN'
  };
}

/**
 * Both the 15m and 1h timeframe must independently confirm the same regime.
 * Missing/stale data, indicator disagreement, or ADX 20–25 returns UNKNOWN.
 */
export function detectOptionsMarketRegime({ candles15m, candles1h } = {}) {
  const fifteenMinute = assessTimeframe(candles15m);
  const hourly = assessTimeframe(candles1h);
  if (!fifteenMinute.valid || !hourly.valid) {
    return {
      regime: 'UNKNOWN',
      reason: !fifteenMinute.valid ? '15M_' + fifteenMinute.reason : '1H_' + hourly.reason,
      fifteenMinute,
      hourly
    };
  }
  const regime = fifteenMinute.regime === hourly.regime &&
    fifteenMinute.regime !== 'UNKNOWN'
    ? fifteenMinute.regime
    : 'UNKNOWN';
  return {
    regime,
    reason: regime === 'UNKNOWN' ? 'TIMEFRAME_DISAGREEMENT_OR_NEUTRAL_ADX' : 'CONFIRMED',
    fifteenMinute,
    hourly
  };
}

export function strategyForOptionsRegime(regime) {
  const normalized = String(regime || '').trim().toUpperCase();
  if (normalized === 'TRENDING') return 'OPTIONS_BUY';
  if (normalized === 'SIDEWAYS') return 'OPTIONS_SELL';
  return null;
}

export function normalizeIvRank(ticker) {
  const candidates = [
    ticker?.iv_rank,
    ticker?.ivRank,
    ticker?.greeks?.iv_rank,
    ticker?.greeks?.ivRank
  ];
  for (const candidate of candidates) {
    const rank = finite(candidate);
    if (rank !== null && rank >= 0 && rank <= 100) return rank;
  }
  return null;
}

export function normalizeIvPercentile(ticker) {
  const candidates = [
    ticker?.iv_percentile,
    ticker?.ivPercentile,
    ticker?.details?.ivPercentile,
    ticker?.greeks?.iv_percentile,
    ticker?.greeks?.ivPercentile
  ];
  for (const candidate of candidates) {
    const percentile = finite(candidate);
    if (percentile !== null && percentile >= 0 && percentile <= 100) return percentile;
  }
  return null;
}

export function evaluateIvRank(strategy, ivRank) {
  const rank = finite(ivRank);
  const normalized = String(strategy || '').trim().toUpperCase();
  if (rank === null || rank < 0 || rank > 100) {
    return { allowed: false, reason: 'IV Rank unavailable or invalid; entry blocked', ivRank: null };
  }
  if (normalized === 'OPTIONS_BUY' && rank >= 40) {
    return { allowed: false, reason: 'BUY requires IV Rank < 40', ivRank: rank };
  }
  if (normalized === 'OPTIONS_SELL' && rank <= 50) {
    return { allowed: false, reason: 'SELL requires IV Rank > 50', ivRank: rank };
  }
  if (!['OPTIONS_BUY', 'OPTIONS_SELL'].includes(normalized)) {
    return { allowed: false, reason: 'Unsupported Options strategy', ivRank: rank };
  }
  return { allowed: true, reason: null, ivRank: rank };
}

export function evaluateIvMetrics(strategy, ivRank, ivPercentile) {
  const rankDecision = evaluateIvRank(strategy, ivRank);
  const percentile = finite(ivPercentile);
  if (!rankDecision.allowed) {
    return { ...rankDecision, ivPercentile: percentile !== null ? percentile : null };
  }
  if (percentile === null || percentile < 0 || percentile > 100) {
    return {
      allowed: false,
      reason: 'IV Percentile unavailable or insufficient daily history; entry blocked',
      ivRank: rankDecision.ivRank,
      ivPercentile: null
    };
  }
  const normalized = String(strategy || '').trim().toUpperCase();
  if (normalized === 'OPTIONS_BUY' && percentile >= 20) {
    return {
      allowed: false, reason: 'BUY requires IV Percentile < 20',
      ivRank: rankDecision.ivRank, ivPercentile: percentile
    };
  }
  if (normalized === 'OPTIONS_SELL' && percentile <= 80) {
    return {
      allowed: false, reason: 'SELL requires IV Percentile > 80',
      ivRank: rankDecision.ivRank, ivPercentile: percentile
    };
  }
  return {
    allowed: true, reason: null,
    ivRank: rankDecision.ivRank, ivPercentile: percentile
  };
}

export function normalizeOptionGreeks(ticker = {}) {
  const details = ticker?.details && typeof ticker.details === 'object' ? ticker.details : {};
  const nested = ticker?.greeks || details?.greeks || details?.optionGreeks || {};
  return {
    delta: finite(ticker.delta ?? details.delta ?? nested.delta),
    gamma: finite(ticker.gamma ?? details.gamma ?? nested.gamma),
    theta: finite(ticker.theta ?? details.theta ?? nested.theta),
    vega: finite(ticker.vega ?? details.vega ?? nested.vega)
  };
}

export function evaluateOptionGreeks(strategy, rawGreeks = {}) {
  const normalized = String(strategy || '').trim().toUpperCase();
  const greeks = normalizeOptionGreeks(rawGreeks);
  if (!['OPTIONS_BUY', 'OPTIONS_SELL'].includes(normalized)) {
    return { allowed: false, reason: 'Unsupported Options strategy for Greek validation', greeks };
  }
  if (Object.values(greeks).some(value => value === null)) {
    return { allowed: false, reason: 'Delta, Gamma, Theta and Vega must all be present and finite; entry blocked', greeks };
  }
  const absDelta = Math.abs(greeks.delta);
  const deltaBand = normalized === 'OPTIONS_BUY' ? [0.45, 0.65] : [0.10, 0.20];
  if (absDelta < deltaBand[0] || absDelta > deltaBand[1]) {
    return {
      allowed: false,
      reason: normalized + ' requires absolute Delta between ' + deltaBand[0].toFixed(2) + ' and ' + deltaBand[1].toFixed(2),
      greeks
    };
  }
  if (!(greeks.gamma > 0)) {
    return { allowed: false, reason: 'Gamma must be finite and positive; entry blocked', greeks };
  }
  if (!(greeks.theta < 0)) {
    return { allowed: false, reason: 'Theta must be finite and negative; entry blocked', greeks };
  }
  if (!(greeks.vega >= 0)) {
    return { allowed: false, reason: 'Vega must be finite and non-negative; entry blocked', greeks };
  }
  return { allowed: true, reason: null, greeks };
}

export function evaluateOptionsExit({
  strategy, entryPremium, currentPremium, peakPremium = null,
  troughPremium = null, dte = null, openedAt = null, now = Date.now()
} = {}) {
  const entry = finite(entryPremium);
  const current = finite(currentPremium);
  if (!(entry > 0) || !(current > 0)) {
    return { exit: false, reason: 'QUOTE_OR_ENTRY_PREMIUM_UNAVAILABLE' };
  }
  const normalized = String(strategy || '').trim().toUpperCase();
  if (normalized === 'OPTIONS_BUY') {
    const peak = Math.max(entry, finite(peakPremium) ?? current, current);
    const trailArmed = peak >= entry * 1.3;
    const trailingStopPremium = trailArmed ? peak * 0.8 : null;
    if (current >= entry * 1.5) return {
      exit: true, reason: 'TAKE_PROFIT_50_PERCENT',
      peakPremium: peak, trailingStopPremium
    };
    if (current <= entry * 0.7) return {
      exit: true, reason: 'STOP_LOSS_30_PERCENT',
      peakPremium: peak, trailingStopPremium
    };
    if (trailArmed && current <= trailingStopPremium) return {
      exit: true, reason: 'TRAILING_STOP_20_PERCENT_FROM_PEAK',
      peakPremium: peak, trailingStopPremium
    };
    const opened = Date.parse(openedAt || '');
    if (Number.isFinite(opened) && now - opened >= 5 * 24 * 60 * 60 * 1000) {
      return { exit: true, reason: 'MAX_HOLD_5_DAYS', peakPremium: peak, trailingStopPremium };
    }
    return {
      exit: false, reason: null, peakPremium: peak,
      trailingStopPremium, breakevenTrailArmed: trailArmed
    };
  }
  if (normalized === 'OPTIONS_SELL') {
    const days = finite(dte);
    const trough = Math.min(entry, finite(troughPremium) ?? current, current);
    const trailArmed = trough <= entry * 0.7;
    const trailingStopPremium = trailArmed ? trough * 1.15 : null;
    if (days !== null && days <= 0.5) return {
      exit: true, reason: 'TIME_EXIT_DTE_0_5_DAYS', troughPremium: trough, trailingStopPremium
    };
    if (current <= entry * 0.5) return {
      exit: true, reason: 'TAKE_PROFIT_50_PERCENT_DECAY', troughPremium: trough, trailingStopPremium
    };
    if (current >= entry * 2) return {
      exit: true, reason: 'STOP_LOSS_2X_PREMIUM', troughPremium: trough, trailingStopPremium
    };
    if (trailArmed && current >= trailingStopPremium) return {
      exit: true, reason: 'TRAILING_STOP_15_PERCENT_FROM_TROUGH',
      troughPremium: trough, trailingStopPremium
    };
    return {
      exit: false, reason: null, troughPremium: trough,
      trailingStopPremium, trailingStopArmed: trailArmed
    };
  }
  return { exit: false, reason: 'UNSUPPORTED_OPTIONS_STRATEGY' };
}
