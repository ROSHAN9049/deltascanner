const clean = value => String(value ?? '').trim();
const positive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function ltpOf(ticker) {
  return positive(ticker?.close ?? ticker?.last_price ?? ticker?.mark_price);
}

export async function recordPaperOptionEntry({
  database,
  ticker,
  signal,
  strategy = 'OPTIONS_BUY',
  now = () => Date.now(),
  dateKey = null
} = {}) {
  const symbol = clean(ticker?.symbol || signal?.symbol).toUpperCase();
  const normalizedStrategy = clean(strategy).toUpperCase();
  if (!database || typeof database.insert !== 'function' || typeof database.select !== 'function') {
    throw new Error('Paper Options ledger database is unavailable');
  }
  if (!symbol || !/^[CP]-[A-Z0-9]+-/.test(symbol) ||
      normalizedStrategy !== 'OPTIONS_BUY' ||
      clean(signal?.stage).toUpperCase() !== 'CONFIRMED' ||
      signal?.ready !== true) {
    return { recorded: false, reason: 'PAPER_ENTRY_QUALITY_GATE' };
  }
  const entryPrice = ltpOf(ticker);
  if (entryPrice === null) return { recorded: false, reason: 'LIVE_LTP_UNAVAILABLE' };
  const existingOpen = await database.select(
    'dd_paper_trades',
    'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&select=id&limit=1'
  );
  if (!Array.isArray(existingOpen)) throw new Error('Paper Options duplicate check is incomplete');
  if (existingOpen.length) return { recorded: false, duplicate: true, reason: 'OPEN_PAPER_TRADE_EXISTS' };
  const timestamp = new Date(now()).toISOString();
  const tradingDate = clean(dateKey) || timestamp.slice(0, 10);
  const tradeKey = [symbol, normalizedStrategy, tradingDate].join(':');
  const row = {
    trade_key: tradeKey,
    symbol,
    underlying: clean(ticker?.underlying).toUpperCase() || null,
    strategy: normalizedStrategy,
    side: 'BUY',
    option_type: symbol.startsWith('C-') ? 'CALL' : 'PUT',
    strike: positive(ticker?.strike_price ?? signal?.strike),
    expiry_at: Number.isFinite(Number(ticker?.expiry_ms))
      ? new Date(Number(ticker.expiry_ms)).toISOString() : null,
    qty: 1,
    entry_price: entryPrice,
    current_price: entryPrice,
    stop_price: positive(signal?.sl),
    take_profit_price: positive(signal?.tp),
    unrealized_pnl: 0,
    realized_pnl: null,
    status: 'OPEN',
    fill_type: 'SIMULATED_FILL',
    source: 'DELTA_INDIA_LIVE_PUBLIC',
    opened_at: timestamp,
    updated_at: timestamp,
    raw: {
      paper_only: true,
      testnet_product_verified: false,
      fill_reference: 'LIVE_TICKER_LTP',
      contract_value: null,
      pnl_unit: 'OPTION_PREMIUM_POINTS'
    }
  };
  try {
    await database.insert('dd_paper_trades', row);
    return { recorded: true, tradeKey, row };
  } catch (error) {
    if (String(error?.code || '').toUpperCase() === '23505' ||
        /duplicate key|unique constraint/i.test(String(error?.message || error))) {
      return { recorded: false, duplicate: true, tradeKey };
    }
    throw error;
  }
}

export async function refreshPaperOptionTrades({
  database,
  tickers,
  now = () => Date.now()
} = {}) {
  if (!database || typeof database.select !== 'function' ||
      typeof database.update !== 'function') {
    throw new Error('Paper Options ledger database is unavailable');
  }
  const openRows = await database.select(
    'dd_paper_trades',
    'status=eq.OPEN&select=id,symbol,qty,entry_price,current_price,stop_price,take_profit_price,expiry_at&limit=1000'
  );
  if (!Array.isArray(openRows)) throw new Error('Paper Options OPEN ledger read is incomplete');
  const tickerMap = tickers instanceof Map ? tickers : new Map();
  const timestampMs = now();
  const updatedAt = new Date(timestampMs).toISOString();
  let updated = 0;
  let closed = 0;
  for (const row of openRows) {
    const ticker = tickerMap.get(clean(row?.symbol).toUpperCase());
    const currentPrice = ltpOf(ticker);
    if (!row?.id || currentPrice === null) continue;
    const entryPrice = positive(row.entry_price);
    const qty = positive(row.qty);
    if (entryPrice === null || qty === null) continue;
    const expiryMs = row.expiry_at ? Date.parse(row.expiry_at) : null;
    const stop = positive(row.stop_price);
    const target = positive(row.take_profit_price);
    const exitReason = expiryMs !== null && Number.isFinite(expiryMs) && timestampMs >= expiryMs
      ? 'EXPIRY'
      : stop !== null && currentPrice <= stop ? 'STOP_LOSS'
        : target !== null && currentPrice >= target ? 'TAKE_PROFIT' : null;
    const patch = {
      current_price: currentPrice,
      unrealized_pnl: (currentPrice - entryPrice) * qty,
      updated_at: updatedAt
    };
    if (exitReason) {
      patch.status = 'CLOSED';
      patch.exit_price = currentPrice;
      patch.realized_pnl = (currentPrice - entryPrice) * qty;
      patch.unrealized_pnl = 0;
      patch.exit_reason = exitReason;
      patch.closed_at = updatedAt;
      closed += 1;
    }
    await database.update(
      'dd_paper_trades',
      'id=eq.' + encodeURIComponent(String(row.id)) + '&status=eq.OPEN',
      patch
    );
    updated += 1;
  }
  return { updated, closed };
}
