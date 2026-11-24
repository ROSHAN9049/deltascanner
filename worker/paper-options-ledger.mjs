const clean = value => String(value ?? '').trim();
const positive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const ltpOf = ticker =>
  positive(ticker?.close) ?? positive(ticker?.last_price) ?? positive(ticker?.mark_price);

function optionIntrinsic(optionType, strike, spot) {
  if (optionType === 'CALL') return Math.max(0, spot - strike);
  if (optionType === 'PUT') return Math.max(0, strike - spot);
  return null;
}

export async function recordPaperOptionEntry({
  database,
  ticker,
  hedgeTicker = null,
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
      !['OPTIONS_BUY', 'OPTIONS_SELL'].includes(normalizedStrategy) ||
      clean(signal?.stage).toUpperCase() !== 'CONFIRMED' ||
      signal?.ready !== true) {
    return { recorded: false, reason: 'PAPER_ENTRY_QUALITY_GATE' };
  }

  const isSpread = normalizedStrategy === 'OPTIONS_SELL';
  const strike = positive(ticker?.strike_price ?? signal?.strike);
  const expiryMs = Number(ticker?.expiry_ms);
  const expiryAt = Number.isFinite(expiryMs) && expiryMs > 0 ? new Date(expiryMs).toISOString() : null;
  let entryPrice = null;
  let currentPrice = null;
  let hedgeSymbol = null;
  let hedgeEntryPrice = null;
  let spreadWidth = null;
  let side = 'BUY';

  if (isSpread) {
    hedgeSymbol = clean(hedgeTicker?.symbol).toUpperCase();
    const shortBid = positive(ticker?.bid);
    const shortAsk = positive(ticker?.ask);
    const hedgeBid = positive(hedgeTicker?.bid);
    hedgeEntryPrice = positive(hedgeTicker?.ask);
    spreadWidth = Math.abs((strike || 0) - Number(hedgeTicker?.strike_price || signal?.hedgeStrike || 0));
    const credit = positive(signal?.credit);
    const maxRisk = positive(signal?.maxRiskPerSpread);
    const shortType = symbol.startsWith('C-') ? 'CALL' : 'PUT';
    const hedgeType = hedgeSymbol.startsWith('C-') ? 'CALL' : 'PUT';
    const matchingLegs =
      !!hedgeSymbol && hedgeSymbol === clean(signal?.hedgeSymbol).toUpperCase() &&
      hedgeSymbol !== symbol && shortType === hedgeType &&
      shortType === clean(signal?.optionType).toUpperCase() &&
      Number(ticker?.expiry_ms) === Number(hedgeTicker?.expiry_ms);
    if (!matchingLegs || shortBid === null || shortAsk === null ||
        hedgeBid === null || hedgeEntryPrice === null ||
        !(spreadWidth > 0) || credit === null || maxRisk === null ||
        maxRisk > spreadWidth || Math.abs((shortBid - hedgeEntryPrice) - credit) > 1e-6) {
      return { recorded: false, reason: 'DEFINED_RISK_SPREAD_QUOTES_OR_METADATA_INVALID' };
    }
    entryPrice = credit;
    currentPrice = Math.max(0, shortAsk - hedgeBid);
    side = 'SELL';
  } else {
    entryPrice = ltpOf(ticker);
    currentPrice = entryPrice;
  }
  if (entryPrice === null || currentPrice === null || !(entryPrice > 0)) {
    return { recorded: false, reason: 'LIVE_OPTION_QUOTE_UNAVAILABLE' };
  }

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
    side,
    option_type: symbol.startsWith('C-') ? 'CALL' : 'PUT',
    strike,
    expiry_at: expiryAt,
    hedge_symbol: hedgeSymbol,
    hedge_entry_price: hedgeEntryPrice,
    spread_width: isSpread ? spreadWidth : null,
    qty: 1,
    entry_price: entryPrice,
    current_price: currentPrice,
    stop_price: isSpread ? null : positive(signal?.sl),
    take_profit_price: isSpread ? null : positive(signal?.tp),
    unrealized_pnl: isSpread ? (entryPrice - currentPrice) : (currentPrice - entryPrice),
    realized_pnl: null,
    status: 'OPEN',
    fill_type: 'SIMULATED_FILL',
    source: 'DELTA_INDIA_LIVE_PUBLIC',
    opened_at: timestamp,
    updated_at: timestamp,
    raw: {
      paper_only: true,
      testnet_product_verified: false,
      fill_reference: isSpread ? 'LIVE_BID_ASK_DEFINED_RISK_SPREAD' : 'LIVE_TICKER_LTP',
      contract_value: null,
      pnl_unit: 'OPTION_PREMIUM_POINTS',
      short_entry_price: isSpread ? positive(ticker?.bid) : null,
      hedge_entry_price: hedgeEntryPrice,
      max_risk_per_spread: isSpread ? positive(signal?.maxRiskPerSpread) : null
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
    'status=eq.OPEN&select=id,symbol,strategy,side,option_type,strike,hedge_symbol,qty,entry_price,current_price,stop_price,take_profit_price,expiry_at&limit=1000'
  );
  if (!Array.isArray(openRows)) throw new Error('Paper Options OPEN ledger read is incomplete');
  const tickerMap = tickers instanceof Map ? tickers : new Map();
  const timestampMs = now();
  const updatedAt = new Date(timestampMs).toISOString();
  let updated = 0;
  let closed = 0;
  for (const row of openRows) {
    const ticker = tickerMap.get(clean(row?.symbol).toUpperCase());
    if (!row?.id || !ticker) continue;
    const entryPrice = positive(row.entry_price);
    const qty = positive(row.qty);
    if (entryPrice === null || qty === null) continue;

    const strategy = clean(row.strategy).toUpperCase();
    const expiryMs = row.expiry_at ? Date.parse(row.expiry_at) : null;
    const expired = expiryMs !== null && Number.isFinite(expiryMs) && timestampMs >= expiryMs;
    let currentPrice = null;
    let pnl = null;
    let exitReason = null;

    if (strategy === 'OPTIONS_SELL') {
      const hedgeTicker = tickerMap.get(clean(row.hedge_symbol).toUpperCase());
      const shortAsk = positive(ticker.ask);
      const hedgeBid = positive(hedgeTicker?.bid);
      if (shortAsk === null || hedgeBid === null) continue;
      currentPrice = Math.max(0, shortAsk - hedgeBid);
      if (expired) {
        const spot = positive(ticker.underlying_price) ??
          positive(ticker.underlyingPrice) ?? positive(ticker.spot_price);
        const shortIntrinsic = spot === null ? null : optionIntrinsic(
          clean(row.option_type).toUpperCase(), Number(row.strike), spot
        );
        const hedgeStrike = positive(hedgeTicker?.strike_price);
        const hedgeIntrinsic = spot === null || hedgeStrike === null ? null : optionIntrinsic(
          clean(row.option_type).toUpperCase(), hedgeStrike, spot
        );
        if (shortIntrinsic !== null && hedgeIntrinsic !== null) {
          currentPrice = Math.max(0, shortIntrinsic - hedgeIntrinsic);
          exitReason = 'EXPIRY';
        }
      }
      pnl = (entryPrice - currentPrice) * qty;
    } else if (strategy === 'OPTIONS_BUY') {
      currentPrice = ltpOf(ticker);
      if (currentPrice === null) continue;
      if (expired) {
        const spot = positive(ticker.underlying_price) ??
          positive(ticker.underlyingPrice) ?? positive(ticker.spot_price);
        const intrinsic = spot === null ? null : optionIntrinsic(
          clean(row.option_type).toUpperCase(), Number(row.strike), spot
        );
        if (intrinsic !== null) currentPrice = intrinsic;
        exitReason = 'EXPIRY';
      } else {
        const stop = positive(row.stop_price);
        const target = positive(row.take_profit_price);
        if (stop !== null && currentPrice <= stop) exitReason = 'STOP_LOSS';
        else if (target !== null && currentPrice >= target) exitReason = 'TAKE_PROFIT';
      }
      pnl = (currentPrice - entryPrice) * qty;
    } else {
      continue;
    }

    if (currentPrice === null || pnl === null || !Number.isFinite(pnl)) continue;
    const patch = {
      current_price: currentPrice,
      unrealized_pnl: pnl,
      updated_at: updatedAt
    };
    if (exitReason) {
      patch.status = 'CLOSED';
      patch.exit_price = currentPrice;
      patch.realized_pnl = pnl;
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
