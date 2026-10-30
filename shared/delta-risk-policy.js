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

/**
 * Round a stop price away from the entry so tick-size rounding can never
 * shrink the requested protective distance. BUY stops round down; SELL stops
 * round up. This keeps the executor's hard minimum intact after quantization.
 */
export function roundStopLossAwayFromEntry(stopPrice, tickSize, side) {
  const price = Number(stopPrice);
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || price <= 0) return price;
  if (!Number.isFinite(tick) || tick <= 0) return price;

  const units = price / tick;
  const direction = String(side || '').toUpperCase();
  const roundedUnits = direction === 'BUY'
    ? Math.floor(units)
    : direction === 'SELL'
      ? Math.ceil(units)
      : Math.round(units);
  return Number((roundedUnits * tick).toPrecision(15));
}
