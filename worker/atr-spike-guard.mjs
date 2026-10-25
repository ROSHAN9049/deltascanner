/**
 * Detect a sudden ATR expansion. Callers retain the last validated candle
 * series if this returns a jump, rather than replacing the cache with an outlier.
 */
/**
 * Ignore a suspect tail candle by copying the previous valid OHLCV values onto
 * its timestamp. This preserves a continuous candle timeline without letting
 * the spike contaminate subsequent ATR calculations.
 */
export function replaceOutlierCandleWithPrevious(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const previous = candles.at(-2);
  const outlier = candles.at(-1);
  if (!previous || !outlier || !Number.isFinite(Number(outlier.time))) return null;
  return [
    ...candles.slice(0, -2),
    { ...previous, time: outlier.time, res: outlier.res ?? previous.res }
  ];
}

export function detectAtrSpike(previousAtr, candidateAtr, multiplier = 3) {
  const previous = Number(previousAtr);
  const candidate = Number(candidateAtr);
  const threshold = Number(multiplier);
  if (!Number.isFinite(previous) || previous <= 0) return null;
  if (!Number.isFinite(candidate) || candidate <= 0) return null;
  if (!Number.isFinite(threshold) || threshold <= 1) return null;
  const ratio = candidate / previous;
  if (ratio < threshold) return null;
  return { previousAtr: previous, candidateAtr: candidate, ratio };
}
