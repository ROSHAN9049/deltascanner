const text = value => String(value ?? '').trim();
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function classifyGridSymbolOwnership({
  symbol,
  exchangePositions = [],
  databasePositions = []
} = {}) {
  const normalized = text(symbol).toUpperCase();
  const exchange = (Array.isArray(exchangePositions) ? exchangePositions : [])
    .find(row => text(row?.symbol || row?.product_symbol).toUpperCase() === normalized &&
      Math.abs(n(row?.qty ?? row?.size)) > 0) || null;
  const rows = (Array.isArray(databasePositions) ? databasePositions : [])
    .filter(row => text(row?.symbol).toUpperCase() === normalized && Math.abs(n(row?.qty)) > 0);
  const gridRows = rows.filter(row => text(row?.strategy).toUpperCase() === 'GRID');
  const futuresRows = rows.filter(row => ['MOMENTUM', 'SCALPING', 'SCALP'].includes(text(row?.strategy).toUpperCase()));
  const otherRows = rows.filter(row => !['GRID', 'MOMENTUM', 'SCALPING', 'SCALP'].includes(text(row?.strategy).toUpperCase()));

  if (futuresRows.length || (exchange && gridRows.length === 0)) {
    const blocker = futuresRows[0] || {};
    return {
      owner: 'FUTURES',
      blocked: true,
      position: {
        id: blocker.id ?? exchange?.id ?? null,
        orderId: blocker.entry_order_id ?? blocker.order_id ?? blocker.client_order_id ??
          exchange?.entry_order_id ?? exchange?.order_id ?? null,
        strategy: text(blocker.strategy || 'FUTURES').toUpperCase(),
        side: blocker.side ?? exchange?.side ?? null,
        qty: n(blocker.qty ?? exchange?.qty ?? exchange?.size),
        entryPrice: n(blocker.entry_price ?? exchange?.entry_price)
      }
    };
  }
  if (exchange && gridRows.length) {
    const grid = gridRows[0];
    const exchangeClient = text(exchange.client_order_id);
    const dbClient = text(grid.client_order_id);
    const identityMatches = !exchangeClient || !dbClient || exchangeClient === dbClient ||
      exchangeClient.toUpperCase().startsWith('DDG-');
    const quantityMatches = Math.abs(n(grid.qty) - Math.abs(n(exchange.qty ?? exchange.size))) <= 1e-8;
    if (!identityMatches || !quantityMatches || gridRows.length > 1) {
      return { owner: 'UNKNOWN', blocked: true, reconciliationRequired: true, position: grid };
    }
    return { owner: 'GRID', blocked: false, position: grid };
  }
  if (gridRows.length) {
    return { owner: 'GRID', blocked: false, position: gridRows[0], reconciliationRequired: true };
  }
  if (otherRows.length || exchange) {
    const blocker = otherRows[0] || {};
    return {
      owner: 'UNKNOWN',
      blocked: true,
      reconciliationRequired: true,
      position: {
        id: blocker.id ?? exchange?.id ?? null,
        orderId: blocker.entry_order_id ?? blocker.order_id ?? exchange?.order_id ?? null,
        strategy: text(blocker.strategy || 'UNKNOWN').toUpperCase(),
        side: blocker.side ?? exchange?.side ?? null,
        qty: n(blocker.qty ?? exchange?.qty ?? exchange?.size),
        entryPrice: n(blocker.entry_price ?? exchange?.entry_price)
      }
    };
  }
  return { owner: 'NONE', blocked: false, position: null };
}

export function gridSymbolMarketMetrics(symbol, { ticker = {}, config = {} } = {}) {
  const bid = n(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
  const ask = n(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const explicitSpread = n(ticker?.spread_pct);
  const spreadPct = explicitSpread > 0 ? explicitSpread
    : mid > 0 && ask >= bid ? (ask - bid) / mid * 100 : null;
  return {
    symbol: text(symbol).toUpperCase(),
    atrReady: (config?.atr_snapshot_status ?? config?.atrSnapshotStatus) === 'READY' &&
      n(config?.atr_14d ?? config?.atr) > 0 &&
      n(config?.atr_pct ?? config?.atrPct) > 0,
    turnover24hUsd: n(ticker?.turnover_usd ?? ticker?.turnover),
    spreadPct
  };
}

export function rankGridSymbolCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({
      ...candidate,
      symbol: text(candidate?.symbol).toUpperCase(),
      atrReady: candidate?.atrReady === true,
      turnover24hUsd: n(candidate?.turnover24hUsd),
      spreadPct: Number.isFinite(Number(candidate?.spreadPct)) ? Number(candidate.spreadPct) : Number.POSITIVE_INFINITY
    }))
    .sort((a, b) =>
      Number(b.atrReady) - Number(a.atrReady) ||
      b.turnover24hUsd - a.turnover24hUsd ||
      a.spreadPct - b.spreadPct ||
      a.symbol.localeCompare(b.symbol)
    );
}

export function selectGridSymbolsByPriority(candidates = [], limit = 2) {
  const count = Number.isInteger(Number(limit)) ? Math.max(0, Math.min(6, Number(limit))) : 2;
  return rankGridSymbolCandidates(candidates).slice(0, count).map(candidate => candidate.symbol);
}
