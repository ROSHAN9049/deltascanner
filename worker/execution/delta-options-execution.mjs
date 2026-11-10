import crypto from 'node:crypto';
import { parseDeltaOptionSymbol } from './delta-options-policy.mjs';
import { evaluateIvRank, evaluateOptionsExit } from '../options-regime-strategy.mjs';
import { executeDefinedRiskSellExit } from '../options-exit-sequence.mjs';
import {
  assertOptionsExecutionAllowed,
  getOptionsExecutionGate,
  assertOptionsManualTestOverrideAllowed,
  getOptionsDatabaseExecutionGate,
  OPTIONS_DATABASE_EXECUTION_LOCK_REASON
} from '../options-execution-lock.mjs';
import {
  calculateLongOptionMaxLoss,
  calculateDefinedRiskSpreadMaxLoss,
  enforceOptionsMaxLoss,
  executeHedgedOptionSpread
} from './delta-options-risk.mjs';

const clean = value => String(value ?? '').trim();
const number = value => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = value => {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};
const lower = value => clean(value).toLowerCase();
const isEnabled = value => lower(value) === 'true';
const terminalOrderStates = new Set(['filled','closed','cancelled','canceled','rejected','expired','failed']);

function assertTickAligned(price, tickSize, symbol) {
  const value = positive(price);
  const tick = positive(tickSize);
  if (!value || !tick) throw new Error('Options limit price or tick size is invalid for ' + symbol);
  const aligned = Math.round(value / tick) * tick;
  if (Math.abs(aligned - value) > Math.max(1e-10, tick * 1e-6)) {
    throw new Error('Options quote is not aligned to the Testnet product tick size for ' + symbol);
  }
}

function parseDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

export function createDeltaOptionsExecution({
  env = process.env,
  request,
  database,
  getAccountSnapshot,
  logExecutor = async () => {},
  buildClientOrderId,
  now = () => Date.now(),
  isMarketTickFresh = () => false
} = {}) {
  if (typeof request !== 'function' || typeof database?.select !== 'function' ||
      typeof getAccountSnapshot !== 'function' || typeof buildClientOrderId !== 'function') {
    throw new Error('Delta Options executor dependencies are incomplete');
  }

  let productsCache = [];
  let productsCachedAt = 0;
  const activeSymbols = new Set();

  function assertTestnetProfile() {
    const mode = lower(env.DELTA_EXECUTION_MODE || 'disabled');
    const environment = clean(env.DELTA_ENVIRONMENT).toUpperCase();
    if (mode !== 'testnet' || environment !== 'TESTNET') {
      throw new Error('Delta Options operations require DELTA_EXECUTION_MODE=testnet and DELTA_ENVIRONMENT=TESTNET');
    }
  }

  function requireManualTestOverride() {
    return assertOptionsManualTestOverrideAllowed(env);
  }

  async function getProducts() {
    assertTestnetProfile();
    if (productsCache.length && now() - productsCachedAt < 60_000) return productsCache;
    const rows = [];
    let after = '';
    for (let page = 0; page < 20; page += 1) {
      const response = await request('GET', '/v2/products', {
        contract_types: 'call_options,put_options',
        states: 'live',
        page_size: 100,
        after: after || undefined
      });
      if (!Array.isArray(response?.result)) {
        throw new Error('Delta Testnet Options product catalogue is malformed');
      }
      rows.push(...response.result);
      const next = clean(response?.meta?.after);
      if (!next) {
        productsCache = rows;
        productsCachedAt = now();
        return rows;
      }
      if (next === after) throw new Error('Delta Testnet Options product catalogue repeated a pagination cursor');
      after = next;
    }
    throw new Error('Delta Testnet Options product catalogue was not fully paginated');
  }

  async function resolveProduct(symbol) {
    const normalized = clean(symbol).toUpperCase();
    const parsed = parseDeltaOptionSymbol(normalized, undefined, now());
    if (!parsed || !['BTC','ETH'].includes(parsed.underlying)) {
      throw new Error('Options contract is invalid, expired or outside the verified BTC/ETH Testnet universe: ' + normalized);
    }
    const expectedType = parsed.optionType === 'CALL' ? 'call_options' : 'put_options';
    const matches = (await getProducts()).filter(row =>
      clean(row?.symbol).toUpperCase() === normalized &&
      lower(row?.contract_type) === expectedType &&
      lower(row?.state) === 'live'
    );
    if (matches.length !== 1) {
      throw new Error('Exact LIVE Delta Testnet Options product could not be uniquely resolved: ' + normalized);
    }
    const product = matches[0];
    const id = number(product.id ?? product.product_id);
    const contractValue = positive(product.contract_value);
    const tickSize = positive(product.tick_size);
    const feeRate = number(product.taker_commission_rate);
    if (!Number.isSafeInteger(id) || id <= 0 || !contractValue || !tickSize ||
        feeRate === null || feeRate < 0 || feeRate > 0.02) {
      throw new Error('Delta Testnet Options product metadata is incomplete or outside verified bounds: ' + normalized);
    }
    return { ...product, id, contractValue, tickSize, feeRate, parsed };
  }

  async function getQuote(symbol) {
    const response = await request('GET', '/v2/tickers/' + encodeURIComponent(symbol));
    const ticker = Array.isArray(response?.result)
      ? response.result.find(row => clean(row?.symbol).toUpperCase() === String(symbol).toUpperCase())
      : response?.result;
    if (!ticker || clean(ticker.symbol).toUpperCase() !== String(symbol).toUpperCase()) {
      throw new Error('Delta Testnet Options ticker does not match contract ' + symbol);
    }
    const bid = positive(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
    const ask = positive(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
    if (!bid || !ask || ask < bid) {
      throw new Error('Delta Testnet Options bid/ask is missing or invalid for ' + symbol);
    }
    return { bid, ask, mark: positive(ticker.mark_price ?? ticker.close) ?? (bid + ask) / 2 };
  }

  async function getCandidate(symbol, strategy, { manualTestOverride = false } = {}) {
    const rows = await database.select(
      'dd_option_cache',
      'symbol=eq.' + encodeURIComponent(symbol) +
        '&strategy=eq.' + encodeURIComponent(strategy) +
        '&select=symbol,strategy,score,stage,cached_at,details,market_regime,iv_rank&limit=2'
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error('A unique current Options candidate is not present in dd_option_cache');
    }
    const row = rows[0];
    const cachedAtMs = Date.parse(row.cached_at || '');
    if (!Number.isFinite(cachedAtMs) || cachedAtMs > now() + 5000 || now() - cachedAtMs > 5 * 60_000) {
      throw new Error('Options candidate snapshot is stale or its timestamp is untrusted');
    }
    const details = parseDetails(row.details);
    const ivRank = number(row.iv_rank ?? details.ivRank);
    const ivRankGate = evaluateIvRank(strategy, ivRank);
    if (!ivRankGate.allowed) throw new Error(ivRankGate.reason);
    const marketRegime = clean(row.market_regime || details.marketRegime).toUpperCase();
    if (isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED)) {
      const expectedRegime = strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS';
      if (marketRegime !== expectedRegime) throw new Error('Market regime does not permit this Options strategy');
      if (!isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
        throw new Error('60-second Options exit monitor must be enabled before regime-based entries');
      }
    }
    if (!manualTestOverride &&
        (clean(row.stage).toUpperCase() !== 'CONFIRMED' ||
         !(number(row.score) >= 80) || details.analysisReady !== true)) {
      throw new Error('Options candidate is not confirmed by the worker analysis gates');
    }
    return {
      ...row, details, ivRank, marketRegime, cachedAt: new Date(cachedAtMs).toISOString(),
      manualTestOverride: manualTestOverride === true
    };
  }

  function assertManualCandidateQualification(candidate, product, settings, strategyKey) {
    const parsed = product?.parsed;
    if (!parsed) throw new Error('Manual test override requires a verified parsed Testnet option contract');

    const optionType = clean(candidate.details.optionType).toUpperCase();
    const strike = number(candidate.details.strike);
    const underlying = clean(candidate.details.underlyingSymbol || parsed.underlying)
      .toUpperCase().replace(/USD$/, '');
    if (optionType !== parsed.optionType || strike !== parsed.strike || underlying !== parsed.underlying) {
      throw new Error('Manual test override blocked: cached option identity does not match the exact Testnet contract');
    }

    const delta = number(candidate.details.delta ?? candidate.delta);
    if (delta === null || Math.abs(delta) <= 0 || Math.abs(delta) > 1) {
      throw new Error('Manual test override blocked: a valid cached option Delta is required');
    }
    const isBuy = strategyKey === 'OPTIONS_BUY';
    const deltaMin = number(isBuy ? settings.options_buy_min_delta : settings.options_sell_min_delta);
    const deltaMax = number(isBuy ? settings.options_buy_max_delta : settings.options_sell_max_delta);
    if (deltaMin === null || deltaMax === null || deltaMin <= 0 || deltaMax < deltaMin ||
        Math.abs(delta) < deltaMin || Math.abs(delta) > deltaMax) {
      throw new Error('Manual test override blocked: option Delta is outside the configured ' +
        (isBuy ? 'BUY' : 'SELL') + ' band');
    }

    const regimeBased = isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED);
    const minDays = regimeBased ? (isBuy ? 3 : 1) : number(settings.options_min_days_to_expiry);
    const maxDays = regimeBased ? (isBuy ? 10 : 3) : number(settings.options_max_days_to_expiry);
    if (minDays === null || maxDays === null || minDays < 0.5 || maxDays < minDays ||
        parsed.dte < minDays || parsed.dte > maxDays) {
      throw new Error('Manual test override blocked: option expiry is outside the configured DTE range');
    }

    if (!isBuy) {
      const hedgeDelta = number(candidate.details.hedgeDelta);
      if (!candidate.details.hedgeSymbol || hedgeDelta === null ||
          Math.abs(hedgeDelta) < 0.05 || Math.abs(hedgeDelta) > 0.15) {
        throw new Error('Manual test override blocked: SELL requires a verified 0.05–0.15 Delta protective hedge');
      }
    }
  }

  function signQuoteToken(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const secret = clean(env.DELTA_TESTNET_API_SECRET);
    if (!secret) throw new Error('Delta Testnet signing secret is unavailable');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return encoded + '.' + signature;
  }

  function verifyQuoteToken(token) {
    const pieces = clean(token).split('.');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
      throw new Error('Options preview confirmation token is invalid');
    }
    const secret = clean(env.DELTA_TESTNET_API_SECRET);
    if (!secret) throw new Error('Delta Testnet signing secret is unavailable');
    const expected = crypto.createHmac('sha256', secret).update(pieces[0]).digest();
    let supplied;
    try { supplied = Buffer.from(pieces[1], 'base64url'); } catch { supplied = Buffer.alloc(0); }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw new Error('Options preview confirmation token signature is invalid');
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')); }
    catch { throw new Error('Options preview token payload is malformed'); }
    if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.issuedAt)) ||
        now() - Number(payload.issuedAt) > 60_000 || Number(payload.issuedAt) > now() + 5000) {
      throw new Error('Options preview expired; request a fresh preview before confirming');
    }
    return payload;
  }

  function verifiedAccountEquity(rawWallet) {
    const candidates = [
      rawWallet?.meta?.net_equity,
      rawWallet?.meta?.equity,
      rawWallet?.meta?.total_equity,
      rawWallet?.result?.net_equity,
      rawWallet?.result?.equity,
      rawWallet?.result?.total_equity
    ].map(number).filter(value => value !== null && value > 0);
    return candidates[0] ?? null;
  }

  function verifiedAvailableBalance(rawWallet) {
    const direct = [
      rawWallet?.meta?.available_balance,
      rawWallet?.meta?.available_margin,
      rawWallet?.result?.available_balance
    ].map(number).find(value => value !== null && value >= 0);
    if (direct !== undefined) return direct;
    const rows = Array.isArray(rawWallet?.result)
      ? rawWallet.result
      : Array.isArray(rawWallet?.result?.balances) ? rawWallet.result.balances : [];
    const stable = rows.filter(row =>
      ['USD','USDT','USDC'].includes(clean(row?.asset_symbol || row?.currency || row?.symbol).toUpperCase())
    );
    if (!stable.length) return null;
    const balances = stable.map(row => number(row?.available_balance));
    if (balances.some(value => value === null || value < 0)) return null;
    return balances.reduce((sum, value) => sum + value, 0);
  }

  async function previewOptionsOrder({ symbol, strategy, qty = 1, manualTestOverride = false } = {}) {
    assertTestnetProfile();
    const useManualTestOverride = manualTestOverride === true;
    if (useManualTestOverride) requireManualTestOverride();
    const contract = clean(symbol).toUpperCase();
    const strategyKey = clean(strategy).toUpperCase();
    const quantity = number(qty);
    if (!['OPTIONS_BUY','OPTIONS_SELL'].includes(strategyKey)) {
      throw new Error('Options strategy must be OPTIONS_BUY or OPTIONS_SELL');
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new Error('Options quantity must be a whole number from 1 to 20');
    }

    const [candidate, product, quote, account, settingsRows] = await Promise.all([
      getCandidate(contract, strategyKey, { manualTestOverride: useManualTestOverride }),
      resolveProduct(contract),
      getQuote(contract),
      getAccountSnapshot(),
      database.select('dd_settings', 'id=eq.1&select=options_max_risk_pct,max_options_positions,enabled,emergency_stop,last_tick_at,options_buy_min_delta,options_buy_max_delta,options_sell_min_delta,options_sell_max_delta,options_min_days_to_expiry,options_max_days_to_expiry')
    ]);
    const settings = Array.isArray(settingsRows) && settingsRows.length === 1 ? settingsRows[0] : null;
    if (!settings) throw new Error('Options risk settings are unavailable; preview blocked');
    if (product.parsed.dte < 0.5) throw new Error('Options contract has less than 0.5 days to expiry; gamma-risk entry blocked');
    if (useManualTestOverride) {
      assertManualCandidateQualification(candidate, product, settings, strategyKey);
    }
    const trustedEquity = verifiedAccountEquity(account?.raw);
    if (trustedEquity === null || Math.abs(trustedEquity - Number(account?.equity)) > 1e-8) {
      throw new Error('Verified Delta Testnet account equity is unavailable; Options preview blocked');
    }
    const verifiedAvailable = verifiedAvailableBalance(account?.raw);
    if (verifiedAvailable === null) {
      throw new Error('Verified Delta Testnet available balance is unavailable; Options preview blocked');
    }
    const optionsRiskPct = number(settings.options_max_risk_pct);
    if (optionsRiskPct === null || optionsRiskPct <= 0) {
      throw new Error('Existing Options risk percentage is missing or invalid; preview blocked');
    }
    let hedgeProduct = null;
    let hedgeQuote = null;
    let premium;
    let hedgePremium = null;
    let loss;

    if (strategyKey === 'OPTIONS_BUY') {
      premium = quote.ask;
      assertTickAligned(premium, product.tickSize, contract);
      loss = calculateLongOptionMaxLoss({
        premium, contractValue: product.contractValue, qty: quantity,
        takerFeeRate: product.feeRate
      });
    } else {
      const hedgeSymbol = clean(candidate.details.hedgeSymbol).toUpperCase();
      if (!hedgeSymbol) throw new Error('SELL candidate is blocked: protective hedge symbol is missing');
      [hedgeProduct, hedgeQuote] = await Promise.all([
        resolveProduct(hedgeSymbol), getQuote(hedgeSymbol)
      ]);
      if (hedgeProduct.parsed.optionType !== product.parsed.optionType ||
          hedgeProduct.parsed.underlying !== product.parsed.underlying ||
          hedgeProduct.parsed.expiryMs !== product.parsed.expiryMs ||
          hedgeProduct.contractValue !== product.contractValue) {
        throw new Error('Protective hedge must match underlying, option type, expiry and contract multiplier');
      }
      const expectedStrike = number(candidate.details.hedgeStrike);
      if (expectedStrike === null || expectedStrike !== hedgeProduct.parsed.strike) {
        throw new Error('Protective hedge strike does not match the cached worker candidate');
      }
      premium = quote.bid;
      hedgePremium = hedgeQuote.ask;
      assertTickAligned(premium, product.tickSize, contract);
      assertTickAligned(hedgePremium, hedgeProduct.tickSize, hedgeProduct.symbol);
      loss = calculateDefinedRiskSpreadMaxLoss({
        optionType: product.parsed.optionType,
        shortStrike: product.parsed.strike,
        hedgeStrike: hedgeProduct.parsed.strike,
        shortPremium: premium,
        hedgePremium,
        contractValue: product.contractValue,
        qty: quantity,
        takerFeeRate: Math.max(product.feeRate, hedgeProduct.feeRate)
      });
    }

    const riskGate = enforceOptionsMaxLoss({
      maxLossUsd: loss.maxLossUsd,
      equity: account?.equity,
      optionsRiskPct
    });
    if (!(verifiedAvailable > 0) || loss.maxLossUsd > verifiedAvailable) {
      throw new Error('Options order blocked: available Testnet balance is below the conservative maximum loss');
    }
    const gate = getOptionsExecutionGate(env);
    const issuedAt = now();
    const token = signQuoteToken({
      symbol: contract,
      strategy: strategyKey,
      qty: quantity,
      cachedAt: candidate.cachedAt,
      contractId: product.id,
      hedgeSymbol: hedgeProduct?.symbol || null,
      hedgeContractId: hedgeProduct?.id ?? null,
      premium,
      hedgePremium,
      maxLossUsd: loss.maxLossUsd,
      equity: account.equity,
      manualTestOverride: useManualTestOverride,
      issuedAt
    });
    const preview = {
      symbol: contract,
      strategy: strategyKey,
      qty: quantity,
      side: strategyKey === 'OPTIONS_BUY' ? 'BUY' : 'SELL',
      premium,
      hedgePremium,
      hedgeSymbol: hedgeProduct?.symbol || null,
      contractId: product.id,
      hedgeContractId: hedgeProduct?.id ?? null,
      contractValue: product.contractValue,
      tickSize: product.tickSize,
      maxLossUsd: loss.maxLossUsd,
      spreadMaxLossBeforeFees: loss.spreadLossBeforeFees ?? null,
      hedgeOnlyExposure: loss.hedgeOnlyExposure ?? null,
      estimatedFeesUsd: loss.estimatedFees,
      equity: account.equity,
      available: verifiedAvailable,
      maxAllowedLossUsd: riskGate.maxAllowedLossUsd,
      hardCapPctOfEquity: 0.5,
      cachedAt: candidate.cachedAt,
      manualTestOverride: useManualTestOverride,
      executionAllowed: false,
      executionLockReason: gate.reason,
      quoteToken: token
    };
    let entrySafetyReason = null;
    try {
      await assertEntrySafety(preview);
    } catch (error) {
      entrySafetyReason = String(error?.message || error);
    }
    preview.executionAllowed = gate.allowed && !entrySafetyReason;
    preview.executionLockReason = gate.reason || entrySafetyReason;
    return preview;
  }

  async function assertDailyOptionsLossLimit(equity, databaseLimitPct = null) {
    const accountEquity = positive(equity);
    const configuredPct = number(databaseLimitPct ?? env.OPTIONS_DAILY_LOSS_LIMIT_PCT ?? 2);
    if (!accountEquity || configuredPct === null || configuredPct <= 0 || configuredPct > 2) {
      throw new Error('Separate Options daily-loss limit is missing or exceeds the hard 2% cap; entry blocked');
    }
    const shifted = new Date(now() + 5.5 * 60 * 60 * 1000);
    const dayStartUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 5.5 * 60 * 60 * 1000;
    const rows = await database.select(
      'dd_option_positions',
      'status=eq.CLOSED&closed_at=gte.' + encodeURIComponent(new Date(dayStartUtc).toISOString()) +
        '&select=realized_pnl,realized_pnl_verified'
    );
    if (!Array.isArray(rows)) throw new Error('Options daily P&L ledger unavailable; entry blocked');
    let realized = 0;
    for (const row of rows) {
      const pnl = number(row?.realized_pnl);
      if (row?.realized_pnl_verified !== true || pnl === null) {
        throw new Error('Options daily P&L includes an unverified close; new entries blocked');
      }
      realized += pnl;
    }
    const maxDailyLoss = accountEquity * configuredPct / 100;
    if (realized <= -maxDailyLoss) {
      const error = new Error('Options daily loss limit reached (' + configuredPct + '% of equity); new entries blocked');
      error.code = 'OPTIONS_DAILY_LOSS_LIMIT';
      error.statusCode = 409;
      throw error;
    }
    return { realizedPnl: realized, maxDailyLoss, configuredPct };
  }

  async function assertEntrySafety(preview) {
    assertTestnetProfile();
    const settingsRows = await database.select(
      'dd_settings',
      'id=eq.1&select=id,enabled,auto_trade,emergency_stop,options_execution_enabled,last_tick_at,max_options_positions,options_daily_loss_limit_pct'
    );
    if (!Array.isArray(settingsRows) || settingsRows.length !== 1) {
      throw new Error('Options entry settings are unavailable; order blocked');
    }
    const settings = settingsRows[0];
    if (settings.enabled !== true) throw new Error('Trading engine is disabled; Options entry blocked');
    if (settings.auto_trade !== true) throw new Error('Auto Trade is off or unknown; Options entry blocked');
    if (settings.emergency_stop !== false) throw new Error('Emergency Stop is active or unknown; Options entry blocked');
    if (!getOptionsDatabaseExecutionGate(settings).allowed) {
      throw new Error(OPTIONS_DATABASE_EXECUTION_LOCK_REASON + ' Options entry blocked');
    }
    if (isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) && !isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      throw new Error('Options regime entries require OPTIONS_EXIT_MONITOR_ENABLED=true');
    }
    await assertDailyOptionsLossLimit(preview.equity, settings.options_daily_loss_limit_pct);
    if (!isMarketTickFresh(settings.last_tick_at, now())) {
      throw new Error('Persisted market tick is stale or unavailable; Options entry blocked');
    }
    const keys = [preview.symbol, preview.hedgeSymbol].filter(Boolean);
    const recentFilledAfter = encodeURIComponent(new Date(now() - 120_000).toISOString());
    const [activeOrders, recentFilledOrders, positions, optionPositions, exchangePositionsResponse] = await Promise.all([
      database.select(
        'dd_orders',
        'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&state=in.(PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED)&select=symbol,state&limit=500'
      ),
      database.select(
        'dd_orders',
        'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&state=eq.FILLED&created_at=gte.' +
          recentFilledAfter + '&select=symbol,state&limit=500'
      ),
      database.select(
        'dd_delta_positions',
        'strategy=in.(OPTIONS_BUY,OPTIONS_SELL,OPTIONS)&status=eq.OPEN&select=symbol&limit=500'
      ),
      database.select(
        'dd_option_positions',
        'status=in.(ENTRY_PENDING,OPEN,HEDGE_CLOSE_PENDING,RECONCILIATION_REQUIRED)&select=symbol,status&limit=500'
      ),
      request('GET', '/v2/positions/margined', { contract_types: 'call_options,put_options' })
    ]);
    if (!Array.isArray(activeOrders) || !Array.isArray(recentFilledOrders) ||
        !Array.isArray(positions) || !Array.isArray(optionPositions) || !Array.isArray(exchangePositionsResponse?.result)) {
      throw new Error('Options exchange/database position and reservation snapshot is incomplete; order blocked');
    }
    const exchangeOptionSymbols = [];
    for (const row of exchangePositionsResponse.result) {
      const type = lower(row?.contract_type);
      if (type && !['call_options','put_options'].includes(type)) continue;
      const positionSymbol = clean(row?.product_symbol || row?.symbol).toUpperCase();
      const size = number(row?.size ?? row?.quantity ?? row?.position_size);
      if (!positionSymbol || size === null) {
        throw new Error('Options exchange position row is incomplete; order blocked');
      }
      if (Math.abs(size) > 0) exchangeOptionSymbols.push(positionSymbol);
    }
    if ([...activeOrders, ...positions, ...optionPositions, ...recentFilledOrders].some(row =>
      keys.includes(clean(row.symbol).toUpperCase())
    ) || exchangeOptionSymbols.some(symbol => keys.includes(symbol))) {
      throw new Error('An Options order, reservation or exchange position already exists for this contract');
    }
    const maxOptionsPositions = Number(settings.max_options_positions);
    if (!Number.isSafeInteger(maxOptionsPositions) || maxOptionsPositions < 1) {
      throw new Error('Configured max_options_positions is unavailable or invalid; Options entry blocked');
    }
    const occupied = new Set([
      ...positions.map(row => clean(row.symbol).toUpperCase()),
      ...optionPositions.map(row => clean(row.symbol).toUpperCase()),
      ...exchangeOptionSymbols,
      ...activeOrders.map(row => clean(row.symbol).toUpperCase()),
      ...recentFilledOrders.map(row => clean(row.symbol).toUpperCase())
    ].filter(Boolean));
    if (occupied.size >= maxOptionsPositions) {
      throw new Error('Configured Options position cap reached (' + occupied.size + '/' + maxOptionsPositions + ')');
    }
  }

  async function submitLeg(product, side, qty, price, {
    strategy, role, maxLossUsd, hedgeOrderId = null, reduceOnly = false, executionKey = null,
    manualTestOverride = false
  } = {}) {
    const roleSuffix = role === 'PROTECTIVE_HEDGE' ? 'H' :
      role === 'UNWIND' ? 'U' : role === 'SHORT' ? 'S' :
        role === 'EXIT' ? 'X' : role === 'HEDGE_EXIT' ? 'HX' : 'B';
    const clientOrderId = buildClientOrderId(
      executionKey ? 'DOP-' + executionKey + '-' + roleSuffix : null,
      'DDO',
      product.symbol
    );
    if (typeof database.insertIgnore !== 'function' || typeof database.update !== 'function') {
      throw new Error('Atomic Options reservation and update support is unavailable; order blocked');
    }
    const prior = await database.select(
      'dd_orders',
      'client_order_id=eq.' + encodeURIComponent(clientOrderId) + '&select=id,client_order_id&limit=1'
    );
    if (!Array.isArray(prior)) throw new Error('Options idempotency reservation lookup failed; order blocked');
    if (prior.length) {
      const replay = new Error('This Options confirmation token has already been used; request a new preview after reconciliation');
      replay.code = 'OPTIONS_CONFIRMATION_REPLAY';
      replay.statusCode = 409;
      throw replay;
    }
    const body = {
      product_id: product.id,
      size: qty,
      side: String(side).toLowerCase(),
      order_type: price === null ? 'market_order' : 'limit_order',
      client_order_id: clientOrderId,
      ...(price !== null ? { limit_price: String(price) } : {}),
      ...(reduceOnly ? { reduce_only: true } : {})
    };
    const reservation = {
      id: clientOrderId,
      symbol: product.symbol,
      product_id: product.id,
      side: String(side).toUpperCase(),
      order_type: 'delta_testnet_order',
      size: qty,
      state: 'PENDING',
      client_order_id: clientOrderId,
      role,
      strategy,
      execution_id: clientOrderId,
      raw: {
        source: 'delta_testnet_options',
        environment: 'testnet',
        reservation: true,
        max_loss: maxLossUsd,
        hedge_order_id: hedgeOrderId,
        options_execution_key: executionKey,
        manual_test_override: manualTestOverride === true,
        contract_id: product.id,
        reduce_only: reduceOnly
      }
    };
    if (typeof database.insertIgnore !== 'function') {
      throw new Error('Atomic Options reservation support is unavailable; order blocked');
    }
    const inserted = await database.insertIgnore('dd_orders', reservation, 'client_order_id');
    if (!Array.isArray(inserted) || inserted.length !== 1) {
      const replay = new Error('Options confirmation reservation already exists or could not be acquired; reconcile before retrying');
      replay.code = 'OPTIONS_CONFIRMATION_REPLAY';
      replay.statusCode = 409;
      throw replay;
    }
    try {
      const response = await request('POST', '/v2/orders', {}, body);
      const order = response?.result ?? response;
      if (!order || typeof order !== 'object' || Array.isArray(order) ||
          !(order.id || order.client_order_id || order.state)) {
        const error = new Error('Delta Testnet Options order acknowledgement is malformed');
        error.ambiguous = true;
        throw error;
      }
      const state = clean(order.state || 'UNKNOWN').toUpperCase();
      const accepted = !['REJECTED','FAILED','ERROR'].includes(state);
      await database.update(
        'dd_orders',
        'client_order_id=eq.' + encodeURIComponent(clientOrderId),
        {
          state: accepted ? state : 'FAILED',
          updated_at: new Date(now()).toISOString(),
          raw: {
            ...reservation.raw,
            reservation: !terminalOrderStates.has(lower(state)),
            accepted,
            exchange_order_id: order.id ?? null,
            exchange_state: state,
            unfilled_size: number(order.unfilled_size),
            average_fill_price: number(order.average_fill_price)
          }
        }
      ).catch(() => {});
      await logExecutor('INFO', '[OptionsExecutor] Delta Testnet option leg acknowledged', {
        environment: 'testnet',
        symbol: product.symbol,
        productId: product.id,
        contract_id: product.id,
        side: String(side).toUpperCase(),
        qty,
        orderId: order.id ?? null,
        orderState: state,
        role,
        max_loss: maxLossUsd,
        hedge_order_id: hedgeOrderId,
        options_execution_key: executionKey
      });
      if (!accepted) {
        const error = new Error('Delta Testnet rejected Options order: ' + state);
        error.status = 400;
        throw error;
      }
      return { ...order, client_order_id: clientOrderId, product_id: product.id, product_symbol: product.symbol };
    } catch (error) {
      const status = Number(error?.status);
      error.ambiguous = error.ambiguous === true ||
        !Number.isInteger(status) || status === 408 || status === 429 || status >= 500;
      await database.update(
        'dd_orders',
        'client_order_id=eq.' + encodeURIComponent(clientOrderId),
        {
          state: error.ambiguous ? 'UNKNOWN' : 'FAILED',
          updated_at: new Date(now()).toISOString(),
          raw: {
            ...reservation.raw,
            reservation: error.ambiguous,
            accepted: false,
            outcome: error.ambiguous ? 'unknown' : 'rejected',
            error_code: String(error.code || 'delta_testnet_options_order_failed'),
            http_status: Number.isInteger(status) ? status : null
          }
        }
      ).catch(() => {});
      await logExecutor('ERROR', '[OptionsExecutor] Delta Testnet Options order failed', {
        symbol: product.symbol,
        productId: product.id,
        contract_id: product.id,
        role,
        max_loss: maxLossUsd,
        hedge_order_id: hedgeOrderId,
        options_execution_key: executionKey,
        ambiguous: error.ambiguous,
        httpStatus: Number.isInteger(status) ? status : null,
        reason: String(error?.message || error).slice(0, 240),
        doNotBlindlyRetry: error.ambiguous
      });
      throw error;
    }
  }

  async function getOrderDetail(order) {
    const id = number(order?.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      const error = new Error('Options order acknowledgement has no exchange order ID');
      error.ambiguous = true;
      throw error;
    }
    const response = await request('GET', '/v2/orders/' + encodeURIComponent(String(id)));
    const detail = response?.result ?? response;
    if (!detail || Number(detail.id) !== id) {
      const error = new Error('Options order detail did not match requested exchange order ID');
      error.ambiguous = true;
      throw error;
    }
    return detail;
  }

  function fillStatus(order) {
    const state = lower(order?.state);
    const size = number(order?.size);
    const unfilled = number(order?.unfilled_size);
    const reportedFilled = number(order?.filled_size ?? order?.filledSize);
    const filledQty = unfilled !== null && size !== null
      ? Math.max(0, size - unfilled)
      : reportedFilled !== null && reportedFilled >= 0 ? reportedFilled : null;
    const fullyFilled = ['filled','closed'].includes(state) && unfilled === 0 &&
      positive(order?.average_fill_price ?? order?.avg_fill_price) !== null;
    return { state, filledQty, fullyFilled, averageFillPrice: positive(order?.average_fill_price ?? order?.avg_fill_price) };
  }

  async function waitForProtectiveFill(order, qty) {
    let latest = order;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      latest = await getOrderDetail(order);
      const status = fillStatus(latest);
      const fullyFilledForRequestedQty = status.fullyFilled &&
        Number.isSafeInteger(Number(qty)) && status.filledQty === Number(qty);
      if (fullyFilledForRequestedQty ||
          ['rejected','failed','cancelled','canceled','expired'].includes(status.state)) {
        return { ...status, fullyFilled: fullyFilledForRequestedQty };
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 350));
    }
    const finalStatus = fillStatus(latest);
    return {
      ...finalStatus,
      fullyFilled: finalStatus.fullyFilled &&
        Number.isSafeInteger(Number(qty)) && finalStatus.filledQty === Number(qty)
    };
  }

  async function cancelProtective(order) {
    const id = number(order?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return { confirmed: false, filledQty: 0 };
    await request('DELETE', '/v2/orders', {}, { id });
    let latest = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      latest = await getOrderDetail(order);
      const status = fillStatus(latest);
      if (['cancelled','canceled','rejected','expired','filled','closed'].includes(status.state)) {
        return { confirmed: true, filledQty: status.filledQty, order: latest };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { confirmed: false, filledQty: fillStatus(latest).filledQty, order: latest };
  }

  async function submitAndConfirmReduceOnlyUnwind(product, originalHedgeOrder, filledQty, preview, executionKey) {
    const unwindOrder = await submitLeg(product, 'SELL', filledQty, null, {
      strategy: 'OPTIONS_SELL',
      role: 'UNWIND',
      maxLossUsd: preview.maxLossUsd,
      hedgeOrderId: originalHedgeOrder?.id ?? null,
      reduceOnly: true,
      executionKey,
      manualTestOverride: preview.manualTestOverride === true
    });
    const unwindFill = await waitForProtectiveFill(unwindOrder, filledQty);
    if (unwindFill?.fullyFilled !== true || Number(unwindFill.filledQty) !== filledQty) {
      const error = new Error('Reduce-only protective-leg unwind was submitted but its full fill is not confirmed; exposure remains for reconciliation.');
      error.ambiguous = true;
      throw error;
    }
    return { ...unwindOrder, confirmedFilledQty: unwindFill.filledQty };
  }

  async function reserveOptionPosition({ executionKey, preview, candidate, product, hedgeProduct = null } = {}) {
    if (typeof database.insert !== 'function') throw new Error('Options position ledger insert is unavailable; entry blocked');
    const row = {
      position_key: executionKey, symbol: preview.symbol, strategy: preview.strategy,
      market_regime: candidate.marketRegime, side: preview.strategy === 'OPTIONS_BUY' ? 'BUY' : 'SELL',
      qty: preview.qty, contract_size: product.contractValue, entry_premium: preview.premium,
      hedge_symbol: hedgeProduct?.symbol || null, hedge_contract_size: hedgeProduct?.contractValue ?? null,
      hedge_entry_premium: preview.hedgePremium ?? null,
      expiry_ms: product.parsed.expiryMs, dte: product.parsed.dte,
      peak_premium: preview.premium, current_premium: preview.premium, status: 'ENTRY_PENDING',
      realized_pnl_verified: false, opened_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
      raw: { environment: 'testnet', iv_rank: candidate.ivRank, regime: candidate.marketRegime, entry_pending: true }
    };
    const inserted = await database.insert('dd_option_positions', row);
    if (Array.isArray(inserted) && inserted.length === 0) throw new Error('Options position reservation was not confirmed; entry blocked');
    return row;
  }

  async function recordOptionPosition({
    executionKey, preview, candidate, product, hedgeProduct = null,
    order, fill, hedgeOrder = null, hedgeFill = null
  } = {}) {
    if (typeof database.update !== 'function') {
      throw new Error('Options position ledger update is unavailable after entry fill; reconcile the exchange position');
    }
    const actualQty = Number(fill?.filledQty);
    const entryPremium = positive(fill?.averageFillPrice);
    const hedgePremium = hedgeProduct ? positive(hedgeFill?.averageFillPrice) : null;
    if (!Number.isSafeInteger(actualQty) || actualQty < 1 || !entryPremium ||
        (hedgeProduct && (!hedgePremium || Number(hedgeFill?.filledQty) !== actualQty))) {
      throw new Error('Filled Option entry/hedge quantities or average prices are not fully verified');
    }
    const row = {
      position_key: executionKey, symbol: preview.symbol, strategy: preview.strategy,
      market_regime: candidate.marketRegime, side: preview.strategy === 'OPTIONS_BUY' ? 'BUY' : 'SELL',
      qty: actualQty, contract_size: product.contractValue, entry_premium: entryPremium,
      hedge_symbol: hedgeProduct?.symbol || null, hedge_contract_size: hedgeProduct?.contractValue ?? null,
      hedge_entry_premium: hedgePremium, entry_order_id: order?.id ? String(order.id) : null,
      hedge_entry_order_id: hedgeOrder?.id ? String(hedgeOrder.id) : null,
      expiry_ms: product.parsed.expiryMs, dte: product.parsed.dte,
      peak_premium: entryPremium, current_premium: entryPremium, status: 'OPEN',
      realized_pnl_verified: false, opened_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
      raw: { environment: 'testnet', iv_rank: candidate.ivRank, regime: candidate.marketRegime,
        entry_order_state: order?.state ?? null, hedge_entry_order_state: hedgeOrder?.state ?? null,
        exit_policy: preview.strategy === 'OPTIONS_BUY' ? 'TP_50_SL_30_BREAKEVEN_AFTER_1R' : 'TP_50_DECAY_SL_2X_DTE_0_5' }
    };
    const openedAt = new Date(now()).toISOString();
    const updated = await database.update('dd_option_positions',
      'position_key=eq.' + encodeURIComponent(executionKey) + '&status=eq.ENTRY_PENDING', {
        ...row, status: 'OPEN', opened_at: openedAt, updated_at: openedAt,
        raw: { ...row.raw, entry_pending: false }
      });
    if (Array.isArray(updated) && updated.length === 0) throw new Error('Entry fill confirmed but the Options position reservation could not be finalized');

    // Materialize an Options lifecycle row in the dashboard's canonical
    // dd_delta_positions ledger. This creates a stable ID for verified close
    // P&L/exit-price mirroring; it is not used to authorize order routing.
    if (typeof database.insert !== 'function') {
      throw new Error('Canonical Delta position ledger insert is unavailable after Options fill; reconciliation required');
    }
    await database.insert('dd_delta_positions', {
      order_id: order?.id ? String(order.id) : null,
      client_order_id: order?.client_order_id || null,
      product_id: product.id,
      symbol: preview.symbol,
      side: preview.strategy === 'OPTIONS_BUY' ? 'BUY' : 'SELL',
      qty: actualQty,
      entry_price: entryPremium,
      current_price: entryPremium,
      unrealized_pnl: 0,
      realized_pnl: null,
      status: 'OPEN',
      strategy: preview.strategy,
      opened_at: openedAt,
      updated_at: openedAt
    });
    const canonicalRows = await database.select('dd_delta_positions',
      'symbol=eq.' + encodeURIComponent(preview.symbol) +
      '&strategy=eq.' + encodeURIComponent(preview.strategy) +
      '&status=eq.OPEN&opened_at=gte.' + encodeURIComponent(openedAt) +
      '&select=id&order=opened_at.desc&limit=2');
    if (!Array.isArray(canonicalRows) || canonicalRows.length !== 1 ||
        !Number.isSafeInteger(Number(canonicalRows[0].id))) {
      throw new Error('Canonical Delta Options position could not be uniquely verified after entry; reconciliation required');
    }
    const canonicalId = Number(canonicalRows[0].id);
    await database.update('dd_option_positions',
      'position_key=eq.' + encodeURIComponent(executionKey) + '&status=eq.OPEN',
      { delta_position_id: canonicalId, updated_at: new Date(now()).toISOString() });
    return { ...row, delta_position_id: canonicalId };
  }

  async function placeOptionsOrder({ symbol, strategy, qty = 1, quoteToken, manualTestOverride = false } = {}) {
    assertOptionsExecutionAllowed(env);
    const useManualTestOverride = manualTestOverride === true;
    if (useManualTestOverride) requireManualTestOverride();
    const requestedSymbol = clean(symbol).toUpperCase();
    const requestedStrategy = clean(strategy).toUpperCase();
    const quantity = Number(qty);
    if (!['OPTIONS_BUY','OPTIONS_SELL'].includes(requestedStrategy) ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new Error('Invalid Options execution request');
    }
    const lockKey = requestedSymbol + ':' + requestedStrategy;
    if (activeSymbols.has(lockKey)) throw new Error('Options execution for this candidate is already in progress');
    activeSymbols.add(lockKey);
    try {
      const expected = verifyQuoteToken(quoteToken);
      const executionKey = crypto.createHash('sha256').update(String(quoteToken)).digest('hex').slice(0, 18);
      if (expected.symbol !== requestedSymbol || expected.strategy !== requestedStrategy ||
          Number(expected.qty) !== quantity ||
          Boolean(expected.manualTestOverride) !== useManualTestOverride) {
        throw new Error('Options confirmation does not match the reviewed candidate or manual-test mode');
      }
      const preview = await previewOptionsOrder({
        symbol: requestedSymbol, strategy: requestedStrategy, qty: quantity,
        manualTestOverride: useManualTestOverride
      });
      const tolerance = Math.max(1e-10, Number(preview.tickSize) / 2);
      if (expected.contractId !== preview.contractId ||
          expected.hedgeContractId !== preview.hedgeContractId ||
          expected.cachedAt !== preview.cachedAt ||
          Math.abs(Number(expected.premium) - preview.premium) > tolerance ||
          (preview.hedgePremium !== null &&
            Math.abs(Number(expected.hedgePremium) - preview.hedgePremium) > tolerance) ||
          Math.abs(Number(expected.maxLossUsd) - preview.maxLossUsd) > 1e-8 ||
          Number(expected.equity) > preview.equity + 1e-8) {
        throw new Error('Options quote, product ID, equity or candidate changed since preview; refresh before execution');
      }
      await assertEntrySafety(preview);
      const product = await resolveProduct(preview.symbol);
      const regimeBased = isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED);
      const hedgeProduct = preview.strategy === 'OPTIONS_SELL' ? await resolveProduct(preview.hedgeSymbol) : null;
      if (regimeBased) {
        const minimumDte = preview.strategy === 'OPTIONS_BUY' ? 3 : 1;
        const maximumDte = preview.strategy === 'OPTIONS_BUY' ? 10 : 3;
        if (product.parsed.dte < 0.5 || product.parsed.dte < minimumDte || product.parsed.dte > maximumDte) {
          throw new Error('Options contract DTE is outside the regime-based expiry window');
        }
      }
      if (regimeBased) await reserveOptionPosition({ executionKey, preview, candidate, product, hedgeProduct });
      if (preview.strategy === 'OPTIONS_BUY') {
        const order = await submitLeg(product, 'BUY', preview.qty, preview.premium, {
          strategy: 'OPTIONS_BUY', role: 'ENTRY', maxLossUsd: preview.maxLossUsd, executionKey,
          manualTestOverride: preview.manualTestOverride === true
        });
        if (isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED)) {
          const fill = await waitForProtectiveFill(order, preview.qty);
          if (fill?.fullyFilled !== true || Number(fill.filledQty) !== preview.qty || !positive(fill.averageFillPrice)) {
            const error = new Error('Long option fill is not fully confirmed; position requires exchange reconciliation');
            error.ambiguous = true; throw error;
          }
          await recordOptionPosition({ executionKey, preview, candidate, product, order, fill });
        }
        await logExecutor('INFO', '[OptionsExecutor] Long Options Testnet order submitted', {
          symbol: preview.symbol, contract_id: product.id,
          hedge_order_id: null, max_loss: preview.maxLossUsd,
          manual_test_override: preview.manualTestOverride === true,
          order_id: order.id ?? null
        });
        return {
          success: true, state: clean(order.state || 'UNKNOWN').toUpperCase(),
          order, contract_id: product.id, hedge_order_id: null,
          max_loss: preview.maxLossUsd
        };
      }

      const lifecycle = await executeHedgedOptionSpread({
        qty: preview.qty,
        placeProtectiveBuy: () => submitLeg(
          hedgeProduct, 'BUY', preview.qty, preview.hedgePremium, {
            strategy: 'OPTIONS_SELL', role: 'PROTECTIVE_HEDGE',
            maxLossUsd: preview.maxLossUsd, executionKey,
            manualTestOverride: preview.manualTestOverride === true
          }
        ),
        waitForProtectiveFill,
        cancelProtectiveOrder: cancelProtective,
        unwindProtectiveFill: (order, filledQty) =>
          submitAndConfirmReduceOnlyUnwind(hedgeProduct, order, filledQty, preview, executionKey),
        placeShortSell: async (hedgeOrder, hedgeFill) => {
          const shortOrder = await submitLeg(product, 'SELL', preview.qty, preview.premium, {
            strategy: 'OPTIONS_SELL', role: 'SHORT', maxLossUsd: preview.maxLossUsd,
            hedgeOrderId: hedgeOrder?.id ?? null, executionKey,
            manualTestOverride: preview.manualTestOverride === true
          });
          if (!isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED)) return shortOrder;
          const shortFill = await waitForProtectiveFill(shortOrder, preview.qty);
          if (shortFill?.fullyFilled !== true || Number(shortFill.filledQty) !== preview.qty || !positive(shortFill.averageFillPrice)) {
            const error = new Error('Short option fill is not fully confirmed; protective BUY remains until reconciliation');
            error.ambiguous = true; throw error;
          }
          return { ...shortOrder, _shortFill: shortFill, _hedgeFill: hedgeFill };
        }
      });
      const hedgeOrderId = lifecycle.hedgeOrder?.id ?? null;
      if (regimeBased) {
        if (lifecycle.success) {
          await recordOptionPosition({ executionKey, preview, candidate, product, hedgeProduct,
            order: lifecycle.shortOrder, fill: lifecycle.shortOrder?._shortFill,
            hedgeOrder: lifecycle.hedgeOrder, hedgeFill: lifecycle.shortOrder?._hedgeFill });
        } else {
          const hasUnresolvedExposure = lifecycle.hedgeExposureRemains === true || lifecycle.shortSubmitted === true;
          await database.update('dd_option_positions',
            'position_key=eq.' + encodeURIComponent(executionKey) + '&status=eq.ENTRY_PENDING', {
              status: hasUnresolvedExposure ? 'RECONCILIATION_REQUIRED' : 'CLOSED',
              realized_pnl: hasUnresolvedExposure ? null : 0,
              realized_pnl_verified: !hasUnresolvedExposure,
              closed_at: hasUnresolvedExposure ? null : new Date(now()).toISOString(),
              exit_reason: hasUnresolvedExposure ? null : 'ENTRY_ABORTED',
              updated_at: new Date(now()).toISOString(),
              raw: { state: lifecycle.state, reason: lifecycle.reason || null, hedge_exposure_remains: hasUnresolvedExposure }
            });
        }
      }
      await logExecutor(lifecycle.success ? 'INFO' : 'ERROR',
        '[OptionsExecutor] Defined-risk Testnet spread lifecycle result', {
          symbol: preview.symbol,
          hedge_symbol: preview.hedgeSymbol,
          contract_id: product.id,
          hedge_contract_id: hedgeProduct.id,
          hedge_order_id: hedgeOrderId,
          short_order_id: lifecycle.shortOrder?.id ?? null,
          max_loss: preview.maxLossUsd,
          manual_test_override: preview.manualTestOverride === true,
          state: lifecycle.state,
          short_submitted: lifecycle.shortSubmitted === true,
          hedge_exposure_remains: lifecycle.hedgeExposureRemains === true,
          reason: lifecycle.reason || null
        });
      return {
        ...lifecycle,
        contract_id: product.id,
        hedge_contract_id: hedgeProduct.id,
        hedge_order_id: hedgeOrderId,
        max_loss: preview.maxLossUsd
      };
    } finally {
      activeSymbols.delete(lockKey);
    }
  }

  function normalizeOptionsCloseReason(reason) {
    const value = clean(reason).toUpperCase();
    if (value.startsWith('TAKE_PROFIT')) return 'TP';
    if (value.includes('STOP_LOSS') || value.includes('BREAKEVEN')) return 'SL';
    return 'TIME_EXIT';
  }

  async function mirrorCanonicalOptionsClose(position, { exitPrice, realizedPnl, reason } = {}) {
    const id = Number(position?.delta_position_id);
    const price = positive(exitPrice);
    const pnl = number(realizedPnl);
    if (!Number.isSafeInteger(id) || id <= 0 || !price || pnl === null) {
      throw new Error('Canonical Options P&L link, verified exit price or realized P&L is unavailable');
    }
    const closedAt = new Date(now()).toISOString();
    const patch = {
      status: 'CLOSED',
      current_price: price,
      exit_price: price,
      realized_pnl: pnl,
      close_reason: normalizeOptionsCloseReason(reason),
      closed_at: closedAt,
      updated_at: closedAt
    };
    await database.update('dd_delta_positions', 'id=eq.' + id + '&status=eq.OPEN', patch);
    // PostgREST updates are configured with return=minimal in production, so
    // verify the canonical row with a read-after-write rather than trusting a
    // successful HTTP status or a mock's update response.
    const rows = await database.select('dd_delta_positions',
      'id=eq.' + id + '&select=id,status,exit_price,realized_pnl,close_reason&limit=1');
    const confirmed = Array.isArray(rows) ? rows[0] : null;
    if (!confirmed || confirmed.status !== 'CLOSED' ||
        Math.abs(Number(confirmed.exit_price) - price) > 1e-8 ||
        Math.abs(Number(confirmed.realized_pnl) - pnl) > 1e-8 ||
        confirmed.close_reason !== patch.close_reason) {
      throw new Error('Canonical Options P&L mirror was not confirmed; close remains reconciliation-required');
    }
    return patch;
  }

  async function closeBuyOptionPosition(position, reason) {
    const product = await resolveProduct(position.symbol);
    const executionKey = crypto.createHash('sha256').update(String(position.position_key) + ':BUY_EXIT:' + String(now())).digest('hex').slice(0, 18);
    const order = await submitLeg(product, 'SELL', Number(position.qty), null, {
      strategy: 'OPTIONS_BUY', role: 'EXIT', maxLossUsd: 0, reduceOnly: true, executionKey
    });
    const fill = await waitForProtectiveFill(order, Number(position.qty));
    if (fill?.fullyFilled !== true || Number(fill.filledQty) !== Number(position.qty) || !positive(fill.averageFillPrice)) {
      const error = new Error('Long Options reduce-only exit is not fully confirmed; reconciliation required'); error.ambiguous = true; throw error;
    }
    const realized = (Number(fill.averageFillPrice) - Number(position.entry_premium)) * Number(position.qty) * Number(position.contract_size);
    await mirrorCanonicalOptionsClose(position, { exitPrice: fill.averageFillPrice, realizedPnl: realized, reason });
    await database.update('dd_option_positions', 'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.OPEN', {
      status: 'CLOSED', current_premium: fill.averageFillPrice, short_exit_premium: fill.averageFillPrice,
      exit_reason: reason, realized_pnl: realized, realized_pnl_verified: true,
      closed_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
      raw: { ...(position.raw || {}), exit_order_id: order.id ?? null, exit_fill_price: fill.averageFillPrice }
    });
    return { closed: true, realizedPnl: realized };
  }

  async function closeSellHedge(position, reason) {
    const hedgeProduct = await resolveProduct(position.hedge_symbol);
    const executionKey = crypto.createHash('sha256').update(String(position.position_key) + ':HEDGE_EXIT:' + String(now())).digest('hex').slice(0, 18);
    const order = await submitLeg(hedgeProduct, 'SELL', Number(position.qty), null, {
      strategy: 'OPTIONS_SELL', role: 'HEDGE_EXIT', maxLossUsd: 0,
      hedgeOrderId: position.hedge_entry_order_id || null, reduceOnly: true, executionKey
    });
    const fill = await waitForProtectiveFill(order, Number(position.qty));
    if (fill?.fullyFilled !== true || Number(fill.filledQty) !== Number(position.qty) || !positive(fill.averageFillPrice)) {
      const error = new Error('Protective hedge exit is not fully confirmed; hedge exposure remains for reconciliation'); error.ambiguous = true; throw error;
    }
    const shortPnl = (Number(position.entry_premium) - Number(position.short_exit_premium)) * Number(position.qty) * Number(position.contract_size);
    const hedgePnl = (Number(fill.averageFillPrice) - Number(position.hedge_entry_premium)) * Number(position.qty) * Number(position.hedge_contract_size);
    const realized = shortPnl + hedgePnl;
    await mirrorCanonicalOptionsClose(position, {
      exitPrice: position.short_exit_premium,
      realizedPnl: realized,
      reason: reason || position.exit_reason
    });
    await database.update('dd_option_positions', 'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.HEDGE_CLOSE_PENDING', {
      status: 'CLOSED', hedge_exit_premium: fill.averageFillPrice,
      exit_reason: reason || position.exit_reason || 'OPTIONS_SELL_EXIT',
      realized_pnl: realized, realized_pnl_verified: true,
      closed_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
      raw: { ...(position.raw || {}), hedge_exit_order_id: order.id ?? null, hedge_exit_fill_price: fill.averageFillPrice }
    });
    return { closed: true, realizedPnl: realized };
  }

  async function closeSellOptionPosition(position, reason) {
    let shortOrder = null;
    try {
      return await executeDefinedRiskSellExit({
        quantity: Number(position.qty),
        closeShort: async () => {
          const shortProduct = await resolveProduct(position.symbol);
          const executionKey = crypto.createHash('sha256').update(String(position.position_key) + ':SHORT_EXIT:' + String(now())).digest('hex').slice(0, 18);
          shortOrder = await submitLeg(shortProduct, 'BUY', Number(position.qty), null, {
            strategy: 'OPTIONS_SELL', role: 'EXIT', maxLossUsd: 0,
            hedgeOrderId: position.hedge_entry_order_id || null, reduceOnly: true, executionKey
          });
          const fill = await waitForProtectiveFill(shortOrder, Number(position.qty));
          return { order: shortOrder, fill };
        },
        closeHedge: async ({ shortFill }) => {
          const updated = { ...position, short_exit_premium: shortFill.averageFillPrice,
            status: 'HEDGE_CLOSE_PENDING', exit_reason: reason };
          const persisted = await database.update('dd_option_positions',
            'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.OPEN', {
              status: 'HEDGE_CLOSE_PENDING', short_exit_premium: shortFill.averageFillPrice,
              current_premium: shortFill.averageFillPrice, exit_reason: reason,
              updated_at: new Date(now()).toISOString(),
              raw: { ...(position.raw || {}), close_short_order_id: shortOrder?.id ?? null,
                close_short_fill_price: shortFill.averageFillPrice, close_short_fully_filled: true }
            });
          if (Array.isArray(persisted) && persisted.length === 0) {
            throw new Error('Confirmed short buyback could not be persisted before hedge close; hedge remains open');
          }
          return closeSellHedge(updated, reason);
        }
      });
    } catch (error) {
      if (error?.code === 'OPTIONS_SHORT_EXIT_UNCONFIRMED') {
        await database.update('dd_option_positions', 'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.OPEN', {
          status: 'RECONCILIATION_REQUIRED', exit_reason: reason, updated_at: new Date(now()).toISOString(),
          raw: { ...(position.raw || {}), close_short_order_id: shortOrder?.id ?? null, close_state: 'SHORT_EXIT_UNCONFIRMED' }
        }).catch(() => {});
      }
      throw error;
    }
  }

  async function monitorOptionsExits() {
    if (!isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) || !isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      return { status: 'DISABLED', monitored: 0, exits: 0 };
    }
    assertTestnetProfile();
    const rows = await database.select('dd_option_positions', 'status=in.(OPEN,HEDGE_CLOSE_PENDING)&select=*&order=opened_at.asc&limit=100');
    if (!Array.isArray(rows)) throw new Error('Options exit monitor position snapshot is malformed');
    let exits = 0;
    for (const position of rows) {
      try {
        if (upper(position.status) === 'HEDGE_CLOSE_PENDING') {
          const result = await closeSellHedge(position, position.exit_reason || 'OPTIONS_SELL_EXIT');
          if (result.closed) exits += 1;
          continue;
        }
        const quoteResponse = await request('GET', '/v2/tickers/' + encodeURIComponent(position.symbol));
        const ticker = quoteResponse?.result ?? quoteResponse;
        if (!ticker || clean(ticker.symbol).toUpperCase() !== clean(position.symbol).toUpperCase()) throw new Error('Options exit quote did not match the open contract');
        const bid = positive(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
        const ask = positive(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
        if (!bid || !ask || ask < bid) throw new Error('Options exit bid/ask is unavailable');
        const isBuy = upper(position.strategy) === 'OPTIONS_BUY';
        const currentPremium = isBuy ? bid : ask;
        const dte = (Number(position.expiry_ms) - now()) / 86_400_000;
        const decision = evaluateOptionsExit({
          strategy: position.strategy, entryPremium: position.entry_premium,
          currentPremium, peakPremium: position.peak_premium, dte,
          openedAt: position.opened_at, now: now()
        });
        await database.update('dd_option_positions', 'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.OPEN', {
          current_premium: currentPremium,
          peak_premium: Math.max(Number(position.peak_premium) || 0, currentPremium),
          dte, updated_at: new Date(now()).toISOString()
        });
        if (!decision.exit) continue;
        const result = isBuy
          ? await closeBuyOptionPosition(position, decision.reason)
          : await closeSellOptionPosition(position, decision.reason);
        if (result.closed) exits += 1;
      } catch (error) {
        await logExecutor('ERROR', '[OptionsExitMonitor] Position exit check failed; position remains tracked', {
          positionKey: position.position_key, symbol: position.symbol,
          strategy: position.strategy, status: position.status,
          reason: String(error?.message || error).slice(0, 240)
        }).catch(() => {});
      }
    }
    return { status: 'OK', monitored: rows.length, exits };
  }

  return Object.freeze({ previewOptionsOrder, placeOptionsOrder, monitorOptionsExits });
}
