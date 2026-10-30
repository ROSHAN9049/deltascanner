const DAY_MS = 24 * 60 * 60 * 1000;

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tickerBid(ticker) {
  return finitePositive(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
}

function tickerAsk(ticker) {
  return finitePositive(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
}

function tickerDelta(ticker) {
  const value = ticker?.greeks?.delta ?? ticker?.delta;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function contractQuality(row, now) {
  const parsed = parseDeltaOptionSymbol(row?.symbol, row?.underlying, now);
  const bid = tickerBid(row);
  const ask = tickerAsk(row);
  const mid = bid && ask ? (bid + ask) / 2 : 0;
  const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : 99;
  const delta = tickerDelta(row);
  const oi = Math.max(0, Number(row?.open_interest ?? row?.openInterest ?? row?.oi) || 0);
  const volume = Math.max(0, Number(row?.volume) || 0);
  return {
    parsed,
    spreadPct,
    deltaDistance: delta === null ? 1 : Math.abs(delta - 0.55),
    liquidityBonus: Math.log1p(oi) * 0.08 + Math.log1p(volume) * 0.04,
    expiryDistance: parsed ? Math.abs(parsed.dte - 7) : 99
  };
}

export function parseDeltaOptionSymbol(symbol, underlying, now = Date.now()) {
  const normalized = String(symbol || '').trim().toUpperCase();
  const match = normalized.match(/^([CP])-([A-Z0-9]+)-([0-9]+(?:\.[0-9]+)?)-(\d{6})$/);
  if (!match) return null;

  const asset = String(underlying || match[2]).trim().toUpperCase();
  if (match[2] !== asset) return null;

  const strike = Number(match[3]);
  const day = Number(match[4].slice(0, 2));
  const month = Number(match[4].slice(2, 4));
  const year = 2000 + Number(match[4].slice(4, 6));
  if (!(strike > 0) || day < 1 || day > 31 || month < 1 || month > 12) return null;

  // Delta India's BTC/ETH option settlement is 12:00 UTC; Gold (XAUT) is 16:00 UTC.
  const settlementHour = asset === 'XAUT' ? 16 : 12;
  const expiryMs = Date.UTC(year, month - 1, day, settlementHour);
  const expiry = new Date(expiryMs);
  if (expiry.getUTCFullYear() !== year ||
      expiry.getUTCMonth() !== month - 1 ||
      expiry.getUTCDate() !== day ||
      !Number.isFinite(now)) return null;

  const dte = (expiryMs - Number(now)) / DAY_MS;
  return {
    symbol: normalized,
    optionType: match[1] === 'C' ? 'CALL' : 'PUT',
    underlying: asset,
    strike,
    expiryMs,
    dte
  };
}

/**
 * Keep the worker's in-memory option chain bounded. The public ticker feed is
 * only used for quotes/Greeks; Testnet product metadata is joined separately
 * by exact symbol before any candidate is persisted.
 */
export function selectOptionContractsForScan({
  rows,
  underlying,
  spotPrice,
  now = Date.now(),
  minDays = 2,
  maxDays = 14,
  maxContracts = 24,
  maxMoneynessPct = 20
} = {}) {
  const asset = String(underlying || '').trim().toUpperCase();
  const spot = finitePositive(spotPrice);
  const limit = Math.max(2, Math.min(60, Math.floor(Number(maxContracts) || 24)));
  const minDte = Math.max(1, Number(minDays) || 2);
  const maxDte = Math.max(minDte, Number(maxDays) || 14);
  const moneynessLimit = Math.max(1, Number(maxMoneynessPct) || 20) / 100;
  if (!asset || !spot || !Array.isArray(rows)) return [];

  const byType = { CALL: [], PUT: [] };
  for (const row of rows) {
    const symbol = String(row?.symbol || '').toUpperCase();
    const parsed = parseDeltaOptionSymbol(symbol, asset, now);
    if (!parsed || parsed.dte < minDte || parsed.dte > maxDte) continue;

    const mark = finitePositive(row?.mark_price ?? row?.close);
    const bid = tickerBid(row);
    const ask = tickerAsk(row);
    if (!mark || !bid || !ask || ask < bid) continue;
    if (Math.abs(parsed.strike - spot) / spot > moneynessLimit) continue;

    const quality = contractQuality({ ...row, symbol, underlying: asset }, now);
    byType[parsed.optionType].push({
      ...row,
      symbol,
      underlying: asset,
      strike_price: parsed.strike,
      expiry_ms: parsed.expiryMs,
      dte: parsed.dte,
      spread_pct: quality.spreadPct,
      _quality: quality.spreadPct * 3 +
        quality.deltaDistance * 10 +
        quality.expiryDistance * 0.05 -
        quality.liquidityBonus
    });
  }

  const perType = Math.ceil(limit / 2);
  const selected = [];
  for (const type of ['CALL', 'PUT']) {
    const ranked = byType[type].sort((a, b) => a._quality - b._quality);
    selected.push(...ranked.slice(0, perType));
  }
  return selected
    .sort((a, b) => a._quality - b._quality)
    .slice(0, limit)
    .map(({ _quality, ...row }) => row);
}

/**
 * Long options are sized to the full premium-at-risk (plus two-sided fee
 * allowance), never to a stop-loss percentage of the premium. Missing product
 * metadata blocks sizing rather than substituting a guessed contract value.
 */
export function calculateLongOptionSizing({
  equity,
  available,
  ask,
  contractValue,
  takerFeeRate,
  riskPct = 0.30
} = {}) {
  const accountEquity = finitePositive(equity);
  const availableBalance = finitePositive(available);
  const premium = finitePositive(ask);
  const multiplier = finitePositive(contractValue);
  const feeRate = finiteNonNegative(takerFeeRate);
  const pct = Number(riskPct);

  const blocked = reason => ({
    qty: 0,
    riskBudget: accountEquity && Number.isFinite(pct) ? accountEquity * pct / 100 : 0,
    premiumPerContract: null,
    estimatedFeesPerContract: null,
    maxLossPerContract: null,
    premiumNotional: 0,
    totalRisk: 0,
    reason
  });

  if (!accountEquity || !availableBalance || !premium || !multiplier || feeRate === null ||
      !Number.isFinite(pct) || pct < 0.05 || pct > 0.30 || feeRate > 0.02) {
    return blocked('Trusted equity, available balance, ask, contract value, fee or risk metadata is missing/out of bounds');
  }

  const riskBudget = accountEquity * pct / 100;
  const premiumPerContract = premium * multiplier;
  const estimatedFeesPerContract = premiumPerContract * feeRate * 2;
  const maxLossPerContract = premiumPerContract + estimatedFeesPerContract;
  const entryCashPerContract = premiumPerContract * (1 + feeRate);
  if (!(riskBudget > 0 && maxLossPerContract > 0 && entryCashPerContract > 0)) {
    return blocked('Option premium risk could not be calculated');
  }

  const qtyByRisk = Math.floor(riskBudget / maxLossPerContract);
  const qtyByAvailable = Math.floor(availableBalance / entryCashPerContract);
  const qty = Math.max(0, Math.min(qtyByRisk, qtyByAvailable));
  const reason = qty < 1
    ? (qtyByAvailable < 1
      ? 'Available balance is below one option contract premium'
      : 'Full-premium risk budget is below one option contract')
    : null;

  return {
    qty,
    riskBudget,
    premiumPerContract,
    estimatedFeesPerContract,
    maxLossPerContract,
    premiumNotional: qty * premiumPerContract,
    totalRisk: qty * maxLossPerContract,
    reason
  };
}
