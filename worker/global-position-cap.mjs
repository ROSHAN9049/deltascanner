const DEFAULT_MAX_OPEN_POSITIONS_CAP = 20;

function positiveInteger(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

/**
 * MAX_OPEN_POSITIONS_CAP, when set to a valid positive integer, overrides the
 * database setting. Otherwise use dd_settings.max_open_positions, then 20.
 */
export function resolveMaxOpenPositionsCap(settings = {}, envOverride = process.env.MAX_OPEN_POSITIONS_CAP) {
  return positiveInteger(envOverride) ??
    positiveInteger(settings?.max_open_positions) ??
    DEFAULT_MAX_OPEN_POSITIONS_CAP;
}

/**
 * Fail-closed pre-route gate based only on the worker's trusted Tradetron
 * snapshot. Pending routes accepted during the current scan reserve a slot
 * until the next API snapshot reflects them.
 */
export function evaluateGlobalPositionCap({
  snapshotSafety,
  settings = {},
  envOverride = process.env.MAX_OPEN_POSITIONS_CAP,
  baselineOpenCount = null,
  routedThisCycle = 0
} = {}) {
  const maxOpenPositions = resolveMaxOpenPositionsCap(settings, envOverride);
  const positionCount = snapshotSafety?.positionCount;
  const trustedCount = snapshotSafety?.trusted === true &&
    Number.isSafeInteger(positionCount) &&
    positionCount >= 0;

  if (!trustedCount) {
    return {
      blocked: true,
      reason: 'global_position_count_untrusted',
      openCount: null,
      maxOpenPositions,
      snapshotReason: snapshotSafety?.reason || 'POSITION_COUNT_UNTRUSTED',
      lastSuccessAt: snapshotSafety?.lastSuccessAt || null
    };
  }

  const baseline = Number.isSafeInteger(baselineOpenCount) && baselineOpenCount >= 0
    ? baselineOpenCount
    : positionCount;
  const routed = Number.isSafeInteger(routedThisCycle) && routedThisCycle > 0
    ? routedThisCycle : 0;
  const openCount = Math.max(positionCount, baseline + routed);
  const blocked = openCount >= maxOpenPositions;

  return {
    blocked,
    reason: blocked ? 'global_position_cap_reached' : null,
    openCount,
    maxOpenPositions,
    snapshotReason: null,
    lastSuccessAt: snapshotSafety?.lastSuccessAt || null
  };
}
