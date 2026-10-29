export function getWorkerStatusDisplay({
  scannerEnabled = true,
  autoTrade = false,
  continuousMode = false,
  emergencyStop = false,
  currentOpenPositions = null,
  maxOpenPositions = null
} = {}) {
  const current = Number(currentOpenPositions);
  const maximum = Number(maxOpenPositions);
  const hasCapData = currentOpenPositions !== null && currentOpenPositions !== undefined &&
    maxOpenPositions !== null && maxOpenPositions !== undefined &&
    Number.isFinite(current) && current >= 0 &&
    Number.isFinite(maximum) && maximum >= 1;
  const capReached = hasCapData && current >= maximum;
  const capLabel = hasCapData ? current + '/' + maximum : 'NO DATA';

  const autoTradeSubtitle = !scannerEnabled
    ? 'Scanner disabled. Market scans and signal refreshes are paused.'
    : emergencyStop
      ? '🚨 EMERGENCY STOP ACTIVE. New entries and automatic routing are halted; market scanning may continue.'
      : !autoTrade
        ? 'Scanner remains active. Auto Trade is OFF, so no automatic entries are routed.'
        : capReached
          ? 'Scanner active, but new entries are blocked by the global position cap (' + capLabel + ').'
          : hasCapData
            ? 'Scanner active. Signals and entry checks are running.'
            : 'Scanner active. Global position-cap status is unavailable; entries fail closed.';

  const continuousSubtitle = !scannerEnabled
    ? 'Scanner is disabled; no market scan or signal refresh occurs.'
    : emergencyStop
      ? 'Emergency Stop is active; new entries are halted while public-market scanning may continue.'
      : !autoTrade
        ? 'Auto Trade is OFF; the scanner continues to scan, but automatic entries are not routed.'
        : !continuousMode
          ? 'Continuous automatic routing is OFF; the worker continues market scanning.'
          : capReached
            ? '⚠️ Global cap reached (' + capLabel + '). New entries blocked until positions close.'
            : hasCapData
              ? 'Continuous scanning active. Global cap: ' + capLabel + '.'
              : 'Continuous scanning active. Global cap status unavailable; entries fail closed.';

  return {
    hasCapData,
    capReached,
    currentOpenPositions: hasCapData ? current : null,
    maxOpenPositions: hasCapData ? maximum : null,
    capLabel,
    autoTradeSubtitle,
    continuousSubtitle,
    continuousValue: !scannerEnabled ? 'OFF' : emergencyStop ? 'ON · HALTED' : !autoTrade ? 'OFF · AUTO TRADE' : continuousMode ? 'ON · ' + (capReached ? 'BLOCKED' : 'ACTIVE') : 'OFF · MANUAL'
  };
}

export function formatHealthAge(milliseconds) {
  const value = Number(milliseconds);
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(value) || value < 0) return 'NO DATA';
  return Math.floor(value / 1000) + ' sec';
}

export function formatLeaseRemaining(milliseconds) {
  const value = Number(milliseconds);
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(value) || value < 0) return 'NO DATA';
  if (value === 0) return '0 sec';
  return Math.ceil(value / 1000) + ' sec';
}

export function getEmergencyStopTooltip(active = false) {
  return active
    ? 'Emergency Stop active; new entries and automatic routing are halted. Public-market scanning may continue.'
    : 'No emergency halt active.';
}

export function getGlobalPositionCapDisplay({
  maxOpenPositions = null,
  currentOpenPositions = null,
  trusted = false
} = {}) {
  const maximum = maxOpenPositions === null || maxOpenPositions === undefined ||
    String(maxOpenPositions).trim() === '' ? NaN : Number(maxOpenPositions);
  const current = currentOpenPositions === null || currentOpenPositions === undefined ||
    String(currentOpenPositions).trim() === '' ? NaN : Number(currentOpenPositions);
  const hasValidLimit = Number.isSafeInteger(maximum) && maximum >= 1;
  const hasTrustedCount = trusted === true && Number.isSafeInteger(current) && current >= 0;

  if (!hasValidLimit || !hasTrustedCount) {
    return {
      state: 'UNKNOWN',
      className: 'cap-unknown',
      currentOpenPositions: null,
      maxOpenPositions: hasValidLimit ? maximum : null,
      capReached: false
    };
  }

  const capReached = current >= maximum;
  return {
    state: capReached ? 'REACHED' : 'ACTIVE',
    className: capReached ? 'cap-reached' : 'cap-active',
    currentOpenPositions: current,
    maxOpenPositions: maximum,
    capReached
  };
}

export function formatRetentionLastRun(timestamp, now = Date.now()) {
  const lastRunMs = timestamp ? Date.parse(timestamp) : NaN;
  const nowMs = Number(now);
  if (!Number.isFinite(lastRunMs) || !Number.isFinite(nowMs)) return 'NO DATA';
  const minutesAgo = Math.max(0, Math.floor((nowMs - lastRunMs) / 60000));
  return minutesAgo + ' min ago';
}
