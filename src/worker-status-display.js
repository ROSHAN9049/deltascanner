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
  const capLabel = hasCapData ? current + '/' + maximum : 'unavailable';

  const autoTradeSubtitle = emergencyStop
    ? '🚨 EMERGENCY STOP ACTIVE. All signal flow halted.'
    : !autoTrade
      ? 'Scanner master switch is disabled. No signals will be sent.'
      : capReached
        ? 'Scanner master switch is enabled, but all new signals are currently blocked by global position cap (' + capLabel + ').'
        : hasCapData
          ? 'Scanner master switch is enabled. Signals active; global cap ' + capLabel + '. Other routing and risk gates still apply.'
          : 'Scanner master switch is enabled. Global position-cap status unavailable; other routing and risk gates still apply.';

  const continuousSubtitle = !autoTrade
    ? 'Manual mode. No automatic routing.'
    : !continuousMode
      ? 'Continuous scanning is off. No continuous automatic routing.'
      : capReached
        ? 'Continuous scanning active, but all new signals blocked by global cap (' + capLabel + '). Existing signals continue to be managed.'
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
    continuousValue: !autoTrade ? 'OFF' : continuousMode ? 'ON · ' + (capReached ? 'BLOCKED' : 'ACTIVE') : 'OFF'
  };
}

export function formatHealthAge(milliseconds) {
  const value = Number(milliseconds);
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(value) || value < 0) return 'NO DATA';
  return Math.floor(value / 1000) + ' sec';
}

export function formatLeaseRemaining(milliseconds) {
  const value = Number(milliseconds);
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(value) || value <= 0) return '0 sec';
  return Math.ceil(value / 1000) + ' sec';
}
