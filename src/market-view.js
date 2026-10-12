// The API returns the complete market universe sorted by 24-hour turnover.
// Limit only rendered lists; never pass this result into scanner/backend logic.
export const DEFAULT_VISIBLE_MARKET_LIMIT = 40;

const SIGNAL_STRATEGIES = Object.freeze(['MOMENTUM', 'SCALPING']);

export function selectVisibleMarketRows(market, limit = DEFAULT_VISIBLE_MARKET_LIMIT) {
  if (!Array.isArray(market)) return [];
  const requested = Number(limit);
  const safeLimit = Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : DEFAULT_VISIBLE_MARKET_LIMIT;
  return market.slice(0, safeLimit);
}

// Keep the stage panel in sync with the same turnover-ranked coin list shown above.
// Missing signal snapshots are represented as explicit WATCH / NO DATA placeholders,
// not as fabricated scores or trade-ready signals.
export function selectVisibleSignalRows(market, signals, limit = DEFAULT_VISIBLE_MARKET_LIMIT) {
  const visibleMarket = selectVisibleMarketRows(market, limit);
  const latestByKey = new Map();
  const capturedTime = signal => {
    const parsed = Date.parse(signal?.captured_at || signal?.cached_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };

  for (const signal of Array.isArray(signals) ? signals : []) {
    const symbol = String(signal?.symbol || '').trim().toUpperCase();
    const strategy = String(signal?.strategy || '').trim().toUpperCase();
    if (!symbol || !SIGNAL_STRATEGIES.includes(strategy)) continue;
    const key = symbol + ':' + strategy;
    const current = latestByKey.get(key);
    if (!current || capturedTime(signal) >= capturedTime(current)) {
      latestByKey.set(key, signal);
    }
  }

  return visibleMarket.flatMap(row => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    if (!symbol) return [];
    return SIGNAL_STRATEGIES.map(strategy => {
      const signal = latestByKey.get(symbol + ':' + strategy);
      if (signal) return signal;
      return {
        symbol: row.symbol,
        strategy,
        stage: 'WATCH',
        side: null,
        score: null,
        qty_contracts: null,
        notional: null,
        risk_usd: null,
        ready: false,
        blocked_reasons: 'No signal snapshot available',
        snapshot_missing: true
      };
    });
  });
}
