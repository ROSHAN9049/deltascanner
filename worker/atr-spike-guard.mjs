/**
 * Detect a sudden ATR expansion. Callers retain the last validated candle
 * series if this returns a jump, rather than replacing the cache with an outlier.
 */
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
