/**
 * Options execution is a separately gated, manual Testnet capability.
 * Missing or malformed configuration is always treated as disabled.
 */
export const OPTIONS_MAX_LOSS_EQUITY_PCT = 0.5;

export const OPTIONS_EXECUTION_LOCK_REASON =
  'Options execution remains locked unless DELTA_EXECUTION_MODE=testnet, DELTA_ENVIRONMENT=TESTNET and OPTIONS_EXECUTION_ALLOWED=true; maximum loss must also be verified.';

export function getOptionsExecutionGate(env = process.env) {
  const mode = String(env?.DELTA_EXECUTION_MODE ?? '').trim().toLowerCase();
  const environment = String(env?.DELTA_ENVIRONMENT ?? '').trim().toUpperCase();
  const flag = String(env?.OPTIONS_EXECUTION_ALLOWED ?? '').trim().toLowerCase();
  const allowed = mode === 'testnet' && environment === 'TESTNET' && flag === 'true';
  return Object.freeze({
    allowed,
    mode,
    environment,
    flagEnabled: flag === 'true',
    reason: allowed ? null : OPTIONS_EXECUTION_LOCK_REASON
  });
}

// Backward-compatible process-start snapshot. Runtime checks use the function.
export const OPTIONS_EXECUTION_ALLOWED = getOptionsExecutionGate().allowed;

export function isOptionsExecutionAllowed(env = process.env) {
  return getOptionsExecutionGate(env).allowed;
}

export function assertOptionsExecutionAllowed(env = process.env) {
  const gate = getOptionsExecutionGate(env);
  if (!gate.allowed) {
    const error = new Error(gate.reason);
    error.code = 'OPTIONS_EXECUTION_LOCKED';
    error.statusCode = 423;
    throw error;
  }
  return gate;
}
