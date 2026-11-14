const DAY_MS = 86_400_000;
export const MIN_IV_PERCENTILE_DAYS = 20;

export function normalizeImpliedVolatility(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const percent = parsed <= 3 ? parsed * 100 : parsed;
  return percent > 0 && percent <= 500 ? percent : null;
}

// Values read back from dd_iv_history are already stored in percentage units.
// Do not re-run decimal conversion: a stored IV of 1.8 means 1.8%, not 180%.
function normalizeStoredIvPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 500 ? parsed : null;
}

export function extractCurrentImpliedVolatility(ticker = {}) {
  const directCandidates = [
    ticker.mark_iv, ticker.implied_volatility, ticker.impliedVolatility, ticker.iv,
    ticker.greeks?.mark_iv, ticker.greeks?.implied_volatility,
    ticker.greeks?.impliedVolatility, ticker.greeks?.iv
  ];
  for (const candidate of directCandidates) {
    const value = normalizeImpliedVolatility(candidate);
    if (value !== null) return value;
  }

  // Delta REST option tickers expose bid_iv and ask_iv under quotes. Use the
  // midpoint when both sides are valid; a one-sided quote is lower confidence.
  const bidIv = normalizeImpliedVolatility(ticker.quotes?.bid_iv);
  const askIv = normalizeImpliedVolatility(ticker.quotes?.ask_iv);
  if (bidIv !== null && askIv !== null) return Number(((bidIv + askIv) / 2).toFixed(6));
  return bidIv ?? askIv ?? null;
}

function resolveMinimumHistoryDays({ testnetExecution = false, minimumHistoryDays = 7 } = {}) {
  const requested = Number(minimumHistoryDays);
  return testnetExecution && Number.isFinite(requested) && requested >= 1 && requested < 7
    ? requested
    : 7;
}

/**
 * Legacy in-memory calculator retained for backwards compatibility. History
 * rows and currentIv are expected in the database's stored percentage units.
 * The Worker uses calculateIvMetricsFromSummary() for complete DB aggregates.
 */
export function calculateRollingIvRank(
  history,
  currentIv,
  now = Date.now(),
  { testnetExecution = false, minimumHistoryDays = 7 } = {}
) {
  const requiredHistoryDays = resolveMinimumHistoryDays({ testnetExecution, minimumHistoryDays });
  const rankMethod = requiredHistoryDays < 7
    ? 'TESTNET_SHORT_WINDOW_' + String(requiredHistoryDays).replace('.', '_') + 'D'
    : 'ROLLING_30D_MIN_7D';
  const current = normalizeStoredIvPercent(currentIv);
  if (current === null || !Array.isArray(history)) {
    return { ivRank: null, ivCurrent: current, historyDays: 0, reason: 'IV_HISTORY_UNAVAILABLE' };
  }
  const cutoff = now - 30 * DAY_MS;
  const samples = history.map(row => ({
    iv: normalizeStoredIvPercent(row?.iv_current ?? row?.iv ?? row?.value),
    at: Date.parse(row?.observed_at ?? row?.recorded_at ?? row?.created_at ?? '')
  })).filter(row => row.iv !== null && Number.isFinite(row.at) && row.at >= cutoff && row.at <= now + 60_000);
  samples.push({ iv: current, at: now });
  if (samples.length < 2) {
    return { ivRank: null, ivCurrent: current, historyDays: 0, reason: 'INSUFFICIENT_IV_HISTORY' };
  }
  const oldest = Math.min(...samples.map(row => row.at));
  const historyDays = Math.max(0, (now - oldest) / DAY_MS);
  if (historyDays < requiredHistoryDays) {
    return {
      ivRank: null,
      ivCurrent: current,
      historyDays,
      minimumHistoryDays: requiredHistoryDays,
      method: rankMethod,
      reason: requiredHistoryDays === 7
        ? 'LESS_THAN_7_DAYS_IV_HISTORY'
        : 'LESS_THAN_TESTNET_SHORT_IV_HISTORY'
    };
  }
  const values = samples.map(row => row.iv);
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (!(high > low)) {
    return {
      ivRank: null, ivCurrent: current, historyDays,
      minimumHistoryDays: requiredHistoryDays, method: rankMethod,
      reason: 'IV_RANGE_NOT_ESTABLISHED'
    };
  }
  const ivRank = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
  return {
    ivRank: Number(ivRank.toFixed(4)),
    ivCurrent: current,
    ivLow: low,
    ivHigh: high,
    historyDays,
    minimumHistoryDays: requiredHistoryDays,
    method: rankMethod,
    reason: null
  };
}

/**
 * Calculate IV Rank from full-group SQL aggregates and IV Percentile from
 * one last observation per completed India trading day. The database RPC
 * calculates min/max over every observation in the 30-day group; only the
 * compact daily series crosses the API boundary.
 */
export function calculateIvMetricsFromSummary(
  rawSummary,
  currentIv,
  now = Date.now(),
  {
    testnetExecution = false,
    minimumHistoryDays = 7,
    minimumPercentileDays = MIN_IV_PERCENTILE_DAYS
  } = {}
) {
  const summary = Array.isArray(rawSummary) ? rawSummary[0] : rawSummary;
  const requiredHistoryDays = resolveMinimumHistoryDays({ testnetExecution, minimumHistoryDays });
  const requiredPercentileDays = Math.max(
    MIN_IV_PERCENTILE_DAYS,
    Number.isFinite(Number(minimumPercentileDays)) ? Number(minimumPercentileDays) : MIN_IV_PERCENTILE_DAYS
  );
  const method = requiredHistoryDays < 7
    ? 'DB_GROUP_AGGREGATE_30D_TESTNET_SHORT_WINDOW_' + String(requiredHistoryDays).replace('.', '_') + 'D'
    : 'DB_GROUP_AGGREGATE_30D_MIN_7D';
  // currentIv is already normalized and stored in database percentage units.
  const current = normalizeStoredIvPercent(currentIv);
  const unavailable = {
    ivRank: null,
    ivPercentile: null,
    ivCurrent: current,
    ivLow: null,
    ivHigh: null,
    historyDays: 0,
    observationCount: 0,
    dailySampleCount: 0,
    minimumHistoryDays: requiredHistoryDays,
    minimumPercentileDays: requiredPercentileDays,
    method,
    ivRankReason: 'IV_HISTORY_UNAVAILABLE',
    ivPercentileReason: 'IV_DAILY_HISTORY_UNAVAILABLE'
  };
  if (current === null || !summary || typeof summary !== 'object') return unavailable;

  const oldestAt = Date.parse(summary.oldest_observed_at || '');
  const historyDays = Number.isFinite(oldestAt)
    ? Math.max(0, (now - oldestAt) / DAY_MS)
    : 0;
  const observationCount = Math.max(0, Number(summary.observation_count) || 0);
  const historyIvLow = normalizeStoredIvPercent(summary.iv_low);
  const historyIvHigh = normalizeStoredIvPercent(summary.iv_high);
  const ivLow = historyIvLow === null ? null : Math.min(historyIvLow, current);
  const ivHigh = historyIvHigh === null ? null : Math.max(historyIvHigh, current);

  let ivRank = null;
  let ivRankReason = null;
  if (observationCount < 1 || ivLow === null || ivHigh === null) {
    ivRankReason = 'INSUFFICIENT_IV_HISTORY';
  } else if (historyDays < requiredHistoryDays) {
    ivRankReason = requiredHistoryDays === 7
      ? 'LESS_THAN_7_DAYS_IV_HISTORY'
      : 'LESS_THAN_TESTNET_SHORT_IV_HISTORY';
  } else if (!(ivHigh > ivLow)) {
    ivRankReason = 'IV_RANGE_NOT_ESTABLISHED';
  } else {
    ivRank = Number(Math.max(0, Math.min(100, ((current - ivLow) / (ivHigh - ivLow)) * 100)).toFixed(4));
  }

  let dailySamples = summary.daily_samples ?? [];
  if (typeof dailySamples === 'string') {
    try { dailySamples = JSON.parse(dailySamples); } catch { dailySamples = []; }
  }
  const dailyByDate = new Map();
  for (const row of Array.isArray(dailySamples) ? dailySamples : []) {
    const day = String(row?.day || '').trim();
    const iv = normalizeStoredIvPercent(row?.iv);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || iv === null) continue;
    dailyByDate.set(day, iv);
  }
  const completedDailyValues = [...dailyByDate.values()];
  const dailySampleCount = completedDailyValues.length;
  let ivPercentile = null;
  let ivPercentileReason = null;
  if (dailySampleCount < requiredPercentileDays) {
    ivPercentileReason = 'LESS_THAN_' + requiredPercentileDays + '_COMPLETED_DAYS_IV_PERCENTILE';
  } else {
    const daysBelowCurrent = completedDailyValues.filter(value => value < current).length;
    ivPercentile = Number(((daysBelowCurrent / dailySampleCount) * 100).toFixed(4));
  }

  return {
    ivRank,
    ivPercentile,
    ivCurrent: current,
    ivLow,
    ivHigh,
    historyDays,
    observationCount,
    dailySampleCount,
    minimumHistoryDays: requiredHistoryDays,
    minimumPercentileDays: requiredPercentileDays,
    method,
    ivRankReason,
    ivPercentileReason
  };
}
