const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const avg = values => {
  const rows = values.filter(value => Number.isFinite(value));
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
};

function trueRange(candle, previousClose) {
  const high = n(candle?.high), low = n(candle?.low), close = n(candle?.close);
  if (!(high > 0 && low > 0 && close > 0 && high >= low)) return null;
  return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
}

/**
 * Range-market screener for Grid. Missing data fails closed. The function
 * returns a pause signal separately so callers can stop new entries while
 * the existing Grid engine cancels/maintains exposure using its normal guards.
 */
export function screenGridMarket({ ticker = {}, candles = [], config = {}, settings = {} } = {}) {
  const rows = (Array.isArray(candles) ? candles : []).filter(row =>
    n(row?.high) > 0 && n(row?.low) > 0 && n(row?.close) > 0
  );
  const bid = n(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
  const ask = n(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
  const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0;
  const spreadPct = n(ticker?.spread_pct) > 0 ? n(ticker.spread_pct)
    : mid > 0 ? ((ask - bid) / mid) * 100 : null;
  const explicitUsdTurnover = n(ticker?.turnover_usd);
  const turnoverCurrency = String(ticker?.turnover_currency ?? ticker?.quote_currency ?? ticker?.quote_asset ?? '').trim().toUpperCase();
  const quoteTurnover = n(ticker?.turnover);
  const turnover24hUsd = explicitUsdTurnover > 0
    ? explicitUsdTurnover
    : (turnoverCurrency === '' || turnoverCurrency === 'USD') ? quoteTurnover : 0;
  const closes = rows.slice(-20).map(row => n(row.close));
  const path = closes.slice(1).reduce((sum, value, index) => sum + Math.abs(value - closes[index]), 0);
  const net = closes.length > 1 ? Math.abs(closes[closes.length - 1] - closes[0]) : null;
  const trendEfficiency = path > 0 && net !== null ? net / path : null;
  const mean = avg(closes);
  const variance = mean !== null && closes.length >= 2
    ? avg(closes.map(value => (value - mean) ** 2)) : null;
  const bbWidthPct = mean > 0 && variance !== null
    ? (4 * Math.sqrt(variance) / mean) * 100 : null;

  const ranges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const value = trueRange(rows[i], n(rows[i - 1].close));
    if (value !== null) ranges.push(value);
  }
  const recentAtr = avg(ranges.slice(-14));
  const priorAtr = avg(ranges.slice(-28, -14));
  const atrStabilityRatio = recentAtr > 0 && priorAtr > 0 ? recentAtr / priorAtr : null;
  const lastRange = ranges.length ? ranges[ranges.length - 1] : null;
  const baselineRange = avg(ranges.slice(-15, -1));
  const lastClose = closes.length ? closes[closes.length - 1] : 0;
  const atrPct = lastClose > 0 && recentAtr !== null
    ? recentAtr / lastClose * 100 : n(config.atr_pct ?? config.atrPct);
  const volatilitySpike = (atrStabilityRatio !== null && atrStabilityRatio >= 1.8) ||
    (lastRange !== null && baselineRange > 0 && lastRange >= baselineRange * 2.5);
  const minTurnover = Math.max(0, n(settings.grid_screener_min_turnover_usd) || 250000);
  const maxSpread = Math.max(0.01, n(settings.grid_screener_max_spread_pct) || 0.25);
  const minAtrPct = Math.max(0.01, n(settings.grid_screener_min_atr_pct) || 0.10);
  const maxAtrPct = Math.max(minAtrPct, n(settings.grid_screener_max_atr_pct) || 3.0);
  const reasons = [];
  if (turnover24hUsd < minTurnover) reasons.push('GRID_VOLUME_TOO_LOW');
  if (spreadPct === null || spreadPct > maxSpread) reasons.push('GRID_SPREAD_TOO_WIDE');
  if (rows.length < 30 || trendEfficiency === null || bbWidthPct === null) reasons.push('GRID_RANGE_DATA_INSUFFICIENT');
  if (trendEfficiency !== null && trendEfficiency > 0.55) reasons.push('GRID_TRENDING_MARKET');
  if (bbWidthPct !== null && bbWidthPct > 8) reasons.push('GRID_BOLLINGER_WIDTH_TOO_WIDE');
  if (!(atrPct >= minAtrPct && atrPct <= maxAtrPct)) reasons.push('GRID_ATR_OUT_OF_RANGE');
  if (atrStabilityRatio === null || atrStabilityRatio < 0.65 || atrStabilityRatio > 1.5) reasons.push('GRID_ATR_UNSTABLE');
  if (volatilitySpike) reasons.push('GRID_VOLATILITY_SPIKE');

  const lower = n(config.lowerPrice ?? config.grid_lower_price);
  const upper = n(config.upperPrice ?? config.grid_upper_price);
  const rangePct = lower > 0 && upper > lower ? (upper - lower) / ((upper + lower) / 2) * 100 : 0;
  const dynamicRungGapPct = Math.max(0.25, Math.min(1.5, atrPct * 0.8));
  const dynamicLevelsCount = rangePct > 0
    ? Math.max(8, Math.min(12, Math.round(rangePct / dynamicRungGapPct) + 1)) : null;
  return {
    qualified: reasons.length === 0,
    pauseNewEntries: volatilitySpike || (trendEfficiency !== null && trendEfficiency > 0.65),
    blockReason: reasons[0] || null,
    reasons,
    turnover24hUsd,
    spreadPct,
    atrPct: Number.isFinite(atrPct) ? Number(atrPct.toFixed(4)) : null,
    atrStabilityRatio: atrStabilityRatio === null ? null : Number(atrStabilityRatio.toFixed(4)),
    trendEfficiency: trendEfficiency === null ? null : Number(trendEfficiency.toFixed(4)),
    bbWidthPct: bbWidthPct === null ? null : Number(bbWidthPct.toFixed(4)),
    volatilitySpike,
    dynamicRungGapPct: Number(dynamicRungGapPct.toFixed(4)),
    dynamicLevelsCount
  };
}
