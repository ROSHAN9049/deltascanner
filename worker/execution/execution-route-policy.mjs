export const DIRECT_DELTA_EXECUTION_MODE = 'testnet';

export function isDirectDeltaExecutionMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === DIRECT_DELTA_EXECUTION_MODE;
}

export function getExecutionRouteBlockReason(mode) {
  return isDirectDeltaExecutionMode(mode)
    ? ''
    : 'Direct Delta Testnet execution is not enabled; scanner is scan-only';
}

export function assertDirectDeltaExecutionMode(mode) {
  const reason = getExecutionRouteBlockReason(mode);
  if (reason) {
    const error = new Error(reason);
    error.code = 'direct_delta_testnet_only';
    error.executionLocked = true;
    throw error;
  }
  return true;
}
