export function getWorkerStatusDisplay({
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

  const autoTradeSubtitle = emergencyStop
    ? '🚨 EMERGENCY STOP ACTIVE. All signal flow halted.'
    : !autoTrade
      ? 'Scanner disabled. No signals will be sent.'
      : capReached
        ? 'Scanner enabled, but all new signals blocked by global cap (' + capLabel + ').'
        : hasCapData
          ? 'Scanner enabled. Signals active.'
          : 'Scanner enabled. Global cap status unavailable.';

  const continuousSubtitle = !autoTrade
    ? 'Manual mode. No automatic routing.'
    : emergencyStop
      ? '🚨 EMERGENCY STOP ACTIVE. All signal flow halted.'
    : !continuousMode
      ? 'Continuous scanning is off. No continuous automatic routing.'
      : capReached
        ? '⚠️ Global cap reached (' + capLabel + '). New signals blocked until positions close.'
        : hasCapData
          ? 'Continuous scanning active. Global cap: ' + capLabel + '.'
          : 'Continuous scanning active. Global cap status unavailable.';

  return {
    hasCapData,
    capReached,
    currentOpenPositions: hasCapData ? current : null,
    maxOpenPositions: hasCapData ? maximum : null,
    capLabel,
    autoTradeSubtitle,
    continuousSubtitle,
    continuousValue: !autoTrade ? 'OFF' : emergencyStop ? 'ON · HALTED' : continuousMode ? 'ON · ' + (capReached ? 'BLOCKED' : 'ACTIVE') : 'OFF'
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
