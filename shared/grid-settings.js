export const GRID_MAX_POSITION_CHOICES = Object.freeze([1, 3, 4]);
export const GRID_BRIDGE_MAX_POSITIONS = 1;
export const GRID_RISK_PER_TRADE_CHOICES = Object.freeze([0.3, 0.5, 0.75, 1]);
export const GRID_DAILY_LOSS_CHOICES = Object.freeze([2, 2.25, 2.5]);
export const GRID_MOMENTUM_PAUSE_CHOICES = Object.freeze([2.5, 2.75, 3]);

export function isAllowedGridRiskPerTradePct(value) {
  const number = Number(value);
  return Number.isFinite(number) && GRID_RISK_PER_TRADE_CHOICES.includes(number);
}

/** Map legacy values to the nearest supported UI setting instead of an empty select. */
export function normalizeGridRiskPerTradePct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return GRID_RISK_PER_TRADE_CHOICES[0];
  return GRID_RISK_PER_TRADE_CHOICES.reduce((nearest, candidate) =>
    Math.abs(candidate - number) < Math.abs(nearest - number) ? candidate : nearest
  , GRID_RISK_PER_TRADE_CHOICES[0]);
}
