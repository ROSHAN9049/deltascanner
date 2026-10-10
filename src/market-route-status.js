export function routeStatusForSymbol(symbol, bestSignal, routedSymbols = []) {
  const selected = String(symbol || '').trim().toUpperCase();
  const supported = new Set(
    (Array.isArray(routedSymbols) ? routedSymbols : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  );

  if (!selected || !supported.has(selected)) {
    return {
      label: 'SCAN ONLY',
      tone: 'down',
      title: 'Not in a worker-confirmed Tradetron futures basket. No entry can be routed for this symbol.'
    };
  }

  const hasReadySignal = Array.isArray(bestSignal)
    ? bestSignal.some(signal => signal?.ready === true)
    : bestSignal?.ready === true;

  if (hasReadySignal) {
    return {
      label: 'READY',
      tone: 'up',
      title: 'The selected signal currently passes readiness checks. This indicates a signal, not a confirmed fill.'
    };
  }

  return {
    label: 'ROUTED',
    tone: 'warn',
    title: 'A Tradetron futures route is configured for this symbol, but its current setup is not marked READY.'
  };
}
