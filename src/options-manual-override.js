function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Read the server-authoritative manual-test and Options-execution gates.
 * The health contract historically returned an object with `allowed`;
 * accept the explicit boolean alias too for rolling deployments.
 */
export function isManualOverrideAllowed(apiHealth) {
  if (!apiHealth || typeof apiHealth !== 'object') return false;
  const overrideGate = apiHealth.optionsManualTestOverride;
  const executionGate = apiHealth.optionsExecutionGate;
  const overrideAllowed = overrideGate === true ||
    overrideGate?.allowed === true ||
    apiHealth.optionsManualTestOverrideAllowed === true;
  const executionAllowed = executionGate === true || executionGate?.allowed === true;
  return overrideAllowed && executionAllowed;
}

/**
 * UI eligibility intentionally ignores score, analysisReady, spread and OI.
 * The API revalidates the exact cached row, Testnet product, quote, account,
 * risk budget and order lifecycle before any order can be sent.
 */
export function isManualOverrideOptionCandidate({
  row,
  details,
  manualOverrideAllowed,
  deltaMin,
  deltaMax,
  dteMin,
  dteMax,
  requiresHedge = false
}) {
  if (manualOverrideAllowed !== true || !row || typeof row !== 'object' ||
      typeof row.symbol !== 'string' || !row.symbol.trim()) return false;

  let resolvedDetails = details ?? row.details ?? {};
  if (typeof resolvedDetails === 'string') {
    try {
      resolvedDetails = JSON.parse(resolvedDetails);
    } catch {
      resolvedDetails = {};
    }
  }

  const delta = finiteNumber(resolvedDetails?.delta ?? row.delta);
  const dte = finiteNumber(resolvedDetails?.dte ?? row.dte);
  const minDelta = finiteNumber(deltaMin);
  const maxDelta = finiteNumber(deltaMax);
  const minDte = finiteNumber(dteMin);
  const maxDte = finiteNumber(dteMax);

  if (delta === null || dte === null || minDelta === null || maxDelta === null ||
      minDte === null || maxDte === null) return false;
  if (Math.abs(delta) < minDelta || Math.abs(delta) > maxDelta ||
      dte < minDte || dte > maxDte) return false;

  if (requiresHedge) {
    const hedgeStrike = finiteNumber(resolvedDetails?.hedgeStrike);
    const hedgeDelta = finiteNumber(resolvedDetails?.hedgeDelta);
    if (typeof resolvedDetails?.hedgeSymbol !== 'string' ||
        !resolvedDetails.hedgeSymbol.trim() ||
        hedgeStrike === null ||
        hedgeDelta === null ||
        hedgeDelta === 0) return false;
  }

  return true;
}
