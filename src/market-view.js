// The API returns the complete market universe sorted by 24-hour turnover.
// Limit only the rendered list; never pass this result into scanner/backend logic.
export const DEFAULT_VISIBLE_MARKET_LIMIT = 40;

export function selectVisibleMarketRows(market, limit = DEFAULT_VISIBLE_MARKET_LIMIT) {
  if (!Array.isArray(market)) return [];
  const requested = Number(limit);
  const safeLimit = Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : DEFAULT_VISIBLE_MARKET_LIMIT;
  return market.slice(0, safeLimit);
}
