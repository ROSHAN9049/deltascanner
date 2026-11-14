// Options must use an independent snapshot of the underlying market signal.
// Capture this before Futures risk/route/capital checks mutate Futures execution state.
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const optionalNumber = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function selectOptionsUnderlyingSignal(signals = [], { scoreMin = 80 } = {}) {
  const minimum = Math.max(80, n(scoreMin) || 80);
  const assessed = (Array.isArray(signals) ? signals : [])
    .filter(signal => signal && typeof signal === 'object')
    .map(signal => {
      const sourceStage = String(signal.stage || '').trim().toUpperCase();
      const normalizedScore = optionalNumber(
        signal.normalizedScore ?? signal.details?.normalizedScore
      );
      const side = String(signal.side || '').trim().toUpperCase();
      const marketReady = signal.ready === true;
      const candlesFresh = signal.candlesFresh === true;
      const scoreReady = normalizedScore !== null && normalizedScore >= minimum;
      const confirmed =
        sourceStage === 'CONFIRMED' &&
        marketReady &&
        candlesFresh &&
        scoreReady &&
        (side === 'BUY' || side === 'SELL');

      // Preserve a non-confirmed market state, but never turn a stale or
      // sub-threshold underlying into a confirmed Options candidate.
      const stage = confirmed
        ? 'CONFIRMED'
        : sourceStage === 'WATCH' || !side
          ? 'WATCH'
          : 'SETUP';

      return {
        ...signal,
        stage,
        ready: confirmed,
        optionsUnderlyingConfirmed: confirmed,
        optionsUnderlyingSourceStage: sourceStage,
        optionsUnderlyingCandlesFresh: candlesFresh,
        optionsUnderlyingMarketReady: marketReady,
        optionsUnderlyingScore: normalizedScore
      };
    });

  // Preserve the existing raw-score tie-breaker, but prefer a market-confirmed
  // underlying whenever either Futures engine has one. No Futures route,
  // product ID, account sizing, or capital field participates in this choice.
  const confirmed = assessed.filter(signal => signal.optionsUnderlyingConfirmed === true);
  const candidates = confirmed.length ? confirmed : assessed;
  return candidates.sort((a, b) => n(b.score) - n(a.score))[0] || null;
}
