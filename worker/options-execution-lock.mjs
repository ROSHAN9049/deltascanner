/**
 * Options execution has an independent, explicit Demo-only mode.
 * Live is deliberately unsupported. Missing or malformed configuration
 * always resolves to disabled and cannot select a production endpoint.
 */
export const OPTIONS_MAX_LOSS_EQUITY_PCT = 0.5;
export const DELTA_INDIA_TESTNET_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';

export const OPTIONS_EXECUTION_LOCK_REASON =
  'Options execution is disabled by default and remains locked unless OPTIONS_EXECUTION_MODE=demo, Delta Testnet is explicit, demo credentials exist, and all execution interlocks pass.';
export const OPTIONS_LIVE_EXECUTION_LOCK_REASON =
  'Live Options execution is not implemented and is permanently blocked by this build.';
export const OPTIONS_DATABASE_EXECUTION_LOCK_REASON =
  'Options execution is disabled in public.dd_settings.options_execution_enabled.';

export function getOptionsExecutionMode(env = process.env) {
  const value = String(env?.OPTIONS_EXECUTION_MODE ?? 'disabled').trim().toLowerCase();
  return ['disabled', 'demo', 'live'].includes(value) ? value : 'disabled';
}

export function isOptionsDemoExecution(env = process.env) {
  return getOptionsExecutionMode(env) === 'demo';
}

export function getOptionsDemoCredentialsGate(env = process.env) {
  const hasApiKey = Boolean(String(env?.DELTA_DEMO_API_KEY ?? '').trim());
  const hasApiSecret = Boolean(String(env?.DELTA_DEMO_API_SECRET ?? '').trim());
  return Object.freeze({
    allowed: hasApiKey && hasApiSecret,
    hasApiKey,
    hasApiSecret,
    reason: hasApiKey && hasApiSecret ? null : 'DELTA_DEMO_API_KEY and DELTA_DEMO_API_SECRET are required in the Worker environment'
  });
}

export function getOptionsDatabaseExecutionGate(settings = {}) {
  const allowed = settings?.options_execution_enabled === true;
  return Object.freeze({
    allowed,
    reason: allowed ? null : OPTIONS_DATABASE_EXECUTION_LOCK_REASON
  });
}

export function getOptionsExecutionGate(env = process.env) {
  const optionsMode = getOptionsExecutionMode(env);
  const deltaMode = String(env?.DELTA_EXECUTION_MODE ?? '').trim().toLowerCase();
  const environment = String(env?.DELTA_ENVIRONMENT ?? '').trim().toUpperCase();
  const flag = String(env?.OPTIONS_EXECUTION_ALLOWED ?? '').trim().toLowerCase();
  const credentials = getOptionsDemoCredentialsGate(env);
  const base = String(env?.DELTA_TESTNET_REST_BASE ?? DELTA_INDIA_TESTNET_REST_BASE)
    .trim();
  const restBaseMatched = base === DELTA_INDIA_TESTNET_REST_BASE;
  const exitMonitorEnabled = String(env?.OPTIONS_EXIT_MONITOR_ENABLED ?? '').trim().toLowerCase() === 'true';
  const allowed = optionsMode === 'demo' &&
    deltaMode === 'testnet' &&
    environment === 'TESTNET' &&
    flag === 'true' &&
    credentials.allowed &&
    restBaseMatched &&
    exitMonitorEnabled;
  let reason = null;
  if (optionsMode === 'live') reason = OPTIONS_LIVE_EXECUTION_LOCK_REASON;
  else if (optionsMode !== 'demo') reason = OPTIONS_EXECUTION_LOCK_REASON;
  else if (deltaMode !== 'testnet' || environment !== 'TESTNET') reason = 'Options Demo mode requires DELTA_EXECUTION_MODE=testnet and DELTA_ENVIRONMENT=TESTNET';
  else if (!restBaseMatched) reason = 'Options Demo mode is pinned to the Delta India Testnet REST endpoint';
  else if (flag !== 'true') reason = 'OPTIONS_EXECUTION_ALLOWED=true is required for Demo Options execution';
  else if (!credentials.allowed) reason = credentials.reason;
  else if (!exitMonitorEnabled) reason = 'OPTIONS_EXIT_MONITOR_ENABLED=true is mandatory for Demo Options entries';
  return Object.freeze({
    allowed,
    mode: optionsMode,
    deltaMode,
    environment,
    flagEnabled: flag === 'true',
    credentialsConfigured: credentials.allowed,
    demoApiKeyConfigured: credentials.hasApiKey,
    demoApiSecretConfigured: credentials.hasApiSecret,
    restBaseMatched,
    exitMonitorEnabled,
    reason
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
    const error = new Error(gate.reason || OPTIONS_EXECUTION_LOCK_REASON);
    error.code = gate.mode === 'live' ? 'OPTIONS_LIVE_EXECUTION_BLOCKED' : 'OPTIONS_EXECUTION_LOCKED';
    error.statusCode = 423;
    throw error;
  }
  return gate;
}

/**
 * Demo-only log-only quality policy. The explicit flag relaxes only candidate
 * quality filters; execution, product, quote, exposure, E-STOP, risk, size,
 * expiry, spread, hedge, bracket and exchange-reconciliation gates remain hard.
 * The legacy ALLOW_MANUAL_OVERRIDE_FOR_TEST switch remains compatible.
 */
export const OPTIONS_MANUAL_TEST_OVERRIDE_LOCK_REASON =
  'Demo quality log-only mode requires OPTIONS_EXECUTION_MODE=demo, the explicit Delta Testnet profile, OPTIONS_DEMO_LOG_ONLY_QUALITY_FILTERS=true and Demo credentials.';

export function getOptionsManualTestOverrideGate(env = process.env) {
  const mode = getOptionsExecutionMode(env);
  const deltaMode = String(env?.DELTA_EXECUTION_MODE ?? '').trim().toLowerCase();
  const environment = String(env?.DELTA_ENVIRONMENT ?? '').trim().toUpperCase();
  const logOnlyFlag = String(env?.OPTIONS_DEMO_LOG_ONLY_QUALITY_FILTERS ?? '').trim().toLowerCase();
  const legacyFlag = String(env?.ALLOW_MANUAL_OVERRIDE_FOR_TEST ?? '').trim().toLowerCase();
  const flagEnabled = logOnlyFlag === 'true' || legacyFlag === 'true';
  const credentials = getOptionsDemoCredentialsGate(env);
  const allowed = mode === 'demo' && deltaMode === 'testnet' &&
    environment === 'TESTNET' && flagEnabled && credentials.allowed;
  return Object.freeze({
    allowed,
    mode,
    deltaMode,
    environment,
    flagEnabled,
    logOnlyFlagEnabled: logOnlyFlag === 'true',
    legacyFlagEnabled: legacyFlag === 'true',
    reason: allowed ? null : OPTIONS_MANUAL_TEST_OVERRIDE_LOCK_REASON
  });
}

export function assertOptionsManualTestOverrideAllowed(env = process.env) {
  const gate = getOptionsManualTestOverrideGate(env);
  if (!gate.allowed) {
    const error = new Error(gate.reason);
    error.code = 'OPTIONS_MANUAL_TEST_OVERRIDE_LOCKED';
    error.statusCode = 423;
    throw error;
  }
  return gate;
}
