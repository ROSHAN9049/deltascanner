export const DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT = 70;
export const MIN_CANDLE_CACHE_SYMBOL_LIMIT = 50;
export const MAX_CANDLE_CACHE_SYMBOL_LIMIT = 80;

const CANDLE_RESOLUTIONS = new Set(['1m', '5m', '15m']);

export function resolveCandleCacheSymbolLimit(value, fallback = DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) ||
      parsed < MIN_CANDLE_CACHE_SYMBOL_LIMIT ||
      parsed > MAX_CANDLE_CACHE_SYMBOL_LIMIT) {
    return fallback;
  }
  return parsed;
}

export function selectTopCandleSymbols(tickers, limit = DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT) {
  const maxSymbols = resolveCandleCacheSymbolLimit(limit);
  const ranked = Array.isArray(tickers) ? [...tickers] : [];
  ranked.sort((a, b) => {
    const turnoverA = Number(a?.turnover_usd ?? a?.turnover ?? 0) || 0;
    const turnoverB = Number(b?.turnover_usd ?? b?.turnover ?? 0) || 0;
    return turnoverB - turnoverA;
  });

  const selected = new Set();
  for (const ticker of ranked) {
    const symbol = String(ticker?.symbol || '').trim().toUpperCase();
    if (!symbol || selected.has(symbol)) continue;
    selected.add(symbol);
    if (selected.size >= maxSymbols) break;
  }
  return selected;
}

export function shouldRetainCandleCacheKey(key, eligibleSymbols) {
  const selected = eligibleSymbols instanceof Set ? eligibleSymbols : new Set();
  const normalized = String(key || '');
  if (normalized === '1h:BTCUSD') return true;

  const separator = normalized.indexOf(':');
  if (separator < 1) return false;
  const resolution = normalized.slice(0, separator);
  const symbol = normalized.slice(separator + 1).toUpperCase();
  return CANDLE_RESOLUTIONS.has(resolution) && selected.has(symbol);
}

export function pruneCandleCacheState({
  candles,
  eligibleSymbols,
  metadataMaps = [],
  healingInFlight = null
} = {}) {
  const retain = key => shouldRetainCandleCacheKey(key, eligibleSymbols);
  let removedSeries = 0;
  let removedMetadataEntries = 0;
  let removedHealingKeys = 0;

  if (candles instanceof Map) {
    for (const key of candles.keys()) {
      if (retain(key)) continue;
      candles.delete(key);
      removedSeries += 1;
    }
  }

  for (const map of Array.isArray(metadataMaps) ? metadataMaps : []) {
    if (!(map instanceof Map)) continue;
    for (const key of map.keys()) {
      if (retain(key)) continue;
      map.delete(key);
      removedMetadataEntries += 1;
    }
  }

  if (healingInFlight instanceof Set) {
    for (const key of healingInFlight) {
      if (retain(key)) continue;
      healingInFlight.delete(key);
      removedHealingKeys += 1;
    }
  }

  return { removedSeries, removedMetadataEntries, removedHealingKeys };
}
