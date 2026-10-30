export const DELTA_TESTNET_MIN_SL_DISTANCE_PCT = 1.5;

/**
 * Shared minimum stop-distance policy for signal generation and Testnet order
 * submission. Higher configured floors are respected; settings can never
 * silently lower the executor's hard minimum.
 */
export function resolveMinimumStopDistancePct(configuredMinPct) {
  const configured = configuredMinPct === null || configuredMinPct === undefined || configuredMinPct === ''
    ? DELTA_TESTNET_MIN_SL_DISTANCE_PCT
    : Number(configuredMinPct);
  return Math.max(
    DELTA_TESTNET_MIN_SL_DISTANCE_PCT,
    Number.isFinite(configured) && configured > 0 ? configured : DELTA_TESTNET_MIN_SL_DISTANCE_PCT
  );
}
