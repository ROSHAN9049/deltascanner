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

function contractQuality(row, now, targetDelta = 0.55) {
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
    deltaDistance: delta === null ? 1 : Math.abs(delta - targetDelta),
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

  // Delta India's current Options guide lists BTC and ETH European contracts.
  // Reject other underlyings until an India-specific settlement rule is verified.
  const settlementHour = ['BTC', 'ETH'].includes(asset) ? 12 : null;
  if (settlementHour === null) return null;
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
  const requestedLimit = Math.max(2, Math.min(60, Math.floor(Number(maxContracts) || 24)));
  const limit = requestedLimit - (requestedLimit % 2);
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

  const perType = limit / 2;
  const weights = [0.50, 0.33, 0.17]; // long delta, short-leg delta, protective-wing delta
  const rawQuotas = weights.map(weight => perType * weight);
  const quotas = rawQuotas.map(Math.floor);
  let remaining = perType - quotas.reduce((sum, value) => sum + value, 0);
  const remainderOrder = rawQuotas
    .map((value, index) => ({ index, remainder: value - quotas[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < remaining; index++) quotas[remainderOrder[index].index] += 1;

  const deltaBuckets = [
    { target: 0.55, quota: quotas[0] },
    { target: 0.27, quota: quotas[1] },
    { target: 0.10, quota: quotas[2] }
  ];
  const selected = [];
  for (const type of ['CALL', 'PUT']) {
    const sourceRows = byType[type];
    const chosen = new Map();
    for (const bucket of deltaBuckets) {
      if (bucket.quota < 1) continue;
      const ranked = sourceRows
        .map(row => ({
          row,
          quality: contractQuality({ ...row, underlying: asset }, now, bucket.target)
        }))
        .sort((a, b) => {
          const scoreA = a.quality.spreadPct * 3 + a.quality.deltaDistance * 10 +
            a.quality.expiryDistance * 0.05 - a.quality.liquidityBonus;
          const scoreB = b.quality.spreadPct * 3 + b.quality.deltaDistance * 10 +
            b.quality.expiryDistance * 0.05 - b.quality.liquidityBonus;
          return scoreA - scoreB;
        });
      let addedForBucket = 0;
      for (const candidate of ranked) {
        if (chosen.has(candidate.row.symbol)) continue;
        chosen.set(candidate.row.symbol, candidate.row);
        addedForBucket += 1;
        if (addedForBucket >= bucket.quota) break;
      }
    }

    // Fill any unallocated slots with the best remaining liquid contracts.
    if (chosen.size < perType) {
      const ranked = sourceRows
        .map(row => ({ row, quality: contractQuality({ ...row, underlying: asset }, now, 0.55) }))
        .sort((a, b) => {
          const scoreA = a.quality.spreadPct * 3 + a.quality.deltaDistance * 10 +
            a.quality.expiryDistance * 0.05 - a.quality.liquidityBonus;
          const scoreB = b.quality.spreadPct * 3 + b.quality.deltaDistance * 10 +
            b.quality.expiryDistance * 0.05 - b.quality.liquidityBonus;
          return scoreA - scoreB;
        });
      for (const candidate of ranked) {
        if (chosen.size >= perType) break;
        if (!chosen.has(candidate.row.symbol)) chosen.set(candidate.row.symbol, candidate.row);
      }
    }
    selected.push(...chosen.values());
  }
  return selected
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


/**
 * Size a vertical credit spread as a defined-risk pair only. The short and
 * protective option must use the same verified contract multiplier. Unknown
 * commission or multiplier data blocks sizing; no naked-short fallback exists.
 *
 * Margin reserve intentionally uses the full strike width (before credit) plus
 * a fee cushion. It is a conservative local reserve, not a substitute for a
 * fresh exchange margin check before any order is sent.
 */
export function calculateCreditSpreadSizing({
  equity,
  available,
  shortBid,
  hedgeAsk,
  shortStrike,
  hedgeStrike,
  shortContractValue,
  hedgeContractValue,
  shortTakerFeeRate,
  hedgeTakerFeeRate,
  riskPct = 0.30
} = {}) {
  const accountEquity = finitePositive(equity);
  const availableBalance = finitePositive(available);
  const shortPremium = finitePositive(shortBid);
  const hedgePremium = finitePositive(hedgeAsk);
  const shortStrikeValue = finitePositive(shortStrike);
  const hedgeStrikeValue = finitePositive(hedgeStrike);
  const shortMultiplier = finitePositive(shortContractValue);
  const hedgeMultiplier = finitePositive(hedgeContractValue);
  const shortFee = finiteNonNegative(shortTakerFeeRate);
  const hedgeFee = finiteNonNegative(hedgeTakerFeeRate);
  const pct = Number(riskPct);

  const blocked = reason => ({
    qty: 0,
    riskBudget: accountEquity && Number.isFinite(pct) ? accountEquity * pct / 100 : 0,
    netCreditPerContract: 0,
    spreadWidthPerContract: 0,
    maxIntrinsicLossPerContract: 0,
    entryFeesPerContract: 0,
    exitFeeReservePerContract: 0,
    maxLossPerContract: 0,
    marginReservePerContract: 0,
    totalRisk: 0,
    totalMarginReserve: 0,
    reason
  });

  if (!accountEquity || !availableBalance || !shortPremium || !hedgePremium ||
      !shortStrikeValue || !hedgeStrikeValue || !shortMultiplier || !hedgeMultiplier ||
      shortFee === null || hedgeFee === null || shortFee > 0.02 || hedgeFee > 0.02 ||
      !Number.isFinite(pct) || pct < 0.05 || pct > 0.30) {
    return blocked('Trusted equity, available balance, both premiums, strikes, multipliers, fees or risk cap are missing/out of bounds');
  }

  const multiplierTolerance = Math.max(shortMultiplier, hedgeMultiplier) * 1e-9;
  if (Math.abs(shortMultiplier - hedgeMultiplier) > multiplierTolerance) {
    return blocked('Short and hedge contract multipliers do not match');
  }
  if (!(shortPremium > hedgePremium)) {
    return blocked('Net credit is not positive after buying the protective option');
  }

  const strikeWidth = Math.abs(shortStrikeValue - hedgeStrikeValue);
  if (!(strikeWidth > 0)) return blocked('Credit spread strike width must be positive');

  const contractValue = shortMultiplier;
  const netCreditPerContract = (shortPremium - hedgePremium) * contractValue;
  const spreadWidthPerContract = strikeWidth * contractValue;
  const maxIntrinsicLossPerContract = Math.max(0, spreadWidthPerContract - netCreditPerContract);
  const entryFeesPerContract =
    (shortPremium * contractValue * shortFee) +
    (hedgePremium * contractValue * hedgeFee);
  const maxFeeRate = Math.max(shortFee, hedgeFee);
  const exitFeeReservePerContract =
    2 * Math.max(spreadWidthPerContract, (shortPremium + hedgePremium) * contractValue) * maxFeeRate;
  const maxLossPerContract =
    maxIntrinsicLossPerContract + entryFeesPerContract + exitFeeReservePerContract;
  const marginReservePerContract =
    spreadWidthPerContract + entryFeesPerContract + exitFeeReservePerContract;

  if (![netCreditPerContract, spreadWidthPerContract, maxIntrinsicLossPerContract,
    entryFeesPerContract, exitFeeReservePerContract, maxLossPerContract,
    marginReservePerContract].every(value => Number.isFinite(value) && value >= 0) ||
      !(maxLossPerContract > 0 && marginReservePerContract > 0)) {
    return blocked('Credit spread maximum loss or reserve could not be calculated');
  }

  const riskBudget = accountEquity * pct / 100;
  const qtyByRisk = Math.floor(riskBudget / maxLossPerContract);
  const qtyByAvailable = Math.floor(availableBalance / marginReservePerContract);
  const qty = Math.max(0, Math.min(qtyByRisk, qtyByAvailable));
  const reason = qty < 1
    ? (qtyByAvailable < 1
      ? 'Available balance is below one full-width credit-spread reserve'
      : 'Defined-risk spread loss exceeds the per-trade risk budget')
    : null;

  return {
    qty,
    riskBudget,
    netCreditPerContract,
    spreadWidthPerContract,
    maxIntrinsicLossPerContract,
    entryFeesPerContract,
    exitFeeReservePerContract,
    maxLossPerContract,
    marginReservePerContract,
    totalRisk: qty * maxLossPerContract,
    totalMarginReserve: qty * marginReservePerContract,
    reason
  };
}
