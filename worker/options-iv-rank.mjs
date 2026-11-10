const DAY_MS = 86_400_000;

export function normalizeImpliedVolatility(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const percent = parsed <= 3 ? parsed * 100 : parsed;
  return percent > 0 && percent <= 500 ? percent : null;
}

export function extractCurrentImpliedVolatility(ticker = {}) {
  const candidates = [
    ticker.mark_iv, ticker.implied_volatility, ticker.impliedVolatility, ticker.iv,
    ticker.greeks?.mark_iv, ticker.greeks?.implied_volatility,
    ticker.greeks?.impliedVolatility, ticker.greeks?.iv
  ];
  for (const candidate of candidates) {
    const value = normalizeImpliedVolatility(candidate);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Rolling 30-day IV Rank. A minimum seven-day observation span is mandatory.
 * The current observation may be supplied separately when it has just been
 * persisted, making the calculation deterministic for the current scan.
 */
export function calculateRollingIvRank(history, currentIv, now = Date.now()) {
  const current = normalizeImpliedVolatility(currentIv);
  if (current === null || !Array.isArray(history)) {
    return { ivRank: null, ivCurrent: current, historyDays: 0, reason: 'IV_HISTORY_UNAVAILABLE' };
  }
  const cutoff = now - 30 * DAY_MS;
  const samples = history.map(row => ({
    iv: normalizeImpliedVolatility(row?.iv_current ?? row?.iv ?? row?.value),
    at: Date.parse(row?.observed_at ?? row?.recorded_at ?? row?.created_at ?? '')
  })).filter(row => row.iv !== null && Number.isFinite(row.at) && row.at >= cutoff && row.at <= now + 60_000);
  samples.push({ iv: current, at: now });
  if (samples.length < 2) {
    return { ivRank: null, ivCurrent: current, historyDays: 0, reason: 'INSUFFICIENT_IV_HISTORY' };
  }
  const oldest = Math.min(...samples.map(row => row.at));
  const historyDays = Math.max(0, (now - oldest) / DAY_MS);
  if (historyDays < 7) {
    return { ivRank: null, ivCurrent: current, historyDays, reason: 'LESS_THAN_7_DAYS_IV_HISTORY' };
  }
  const values = samples.map(row => row.iv);
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (!(high > low)) {
    return { ivRank: null, ivCurrent: current, historyDays, reason: 'IV_RANGE_NOT_ESTABLISHED' };
  }
  const ivRank = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
  return { ivRank: Number(ivRank.toFixed(4)), ivCurrent: current, ivLow: low, ivHigh: high, historyDays, reason: null };
}
