const scoreValue = value => Number.isFinite(+value) ? +value : 0;

const isConfirmedAndReady = candidate =>
  candidate?.stage === 'CONFIRMED' && candidate?.analysisReady === true;

/**
 * Keep one option per underlying and strategy. Fully confirmed, analysis-ready
 * contracts outrank every other stage; score breaks ties within the same tier.
 */
export function selectBestOptionCandidates(optionSignals = []) {
  const selected = new Map();

  for (const candidate of optionSignals) {
    const underlying = String(candidate.underlyingSymbol || '')
      .toUpperCase()
      .replace(/USD$/, '');
    const key = underlying + ':' + candidate.strategy;
    const previous = selected.get(key);

    if (!previous) {
      selected.set(key, candidate);
      continue;
    }

    const candidateReady = isConfirmedAndReady(candidate);
    const previousReady = isConfirmedAndReady(previous);

    if (
      (candidateReady && !previousReady)
      || (candidateReady === previousReady && scoreValue(candidate.score) > scoreValue(previous.score))
    ) {
      selected.set(key, candidate);
    }
  }

  return selected;
}
