import crypto from 'node:crypto';
import { parseDeltaOptionSymbol } from './delta-options-policy.mjs';
import { evaluateIvMetrics, evaluateOptionsExit } from '../options-regime-strategy.mjs';
import { executeDefinedRiskSellExit } from '../options-exit-sequence.mjs';
import {
  assertOptionsExecutionAllowed,
  getOptionsExecutionGate,
  getOptionsExecutionMode,
  isOptionsDemoExecution,
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
export const normalizeOptionsExitStatus = value => clean(value).toUpperCase();
export function resolveOptionsMaxSpreadPct(settings) {
  const configured = number(settings?.options_max_spread_pct);
  if (configured === null) return 1.5;
  if (configured < 0) throw new Error('Options max spread setting is invalid; preview blocked');
  return configured;
}
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

function snapPriceToTick(value, tickSize, direction) {
  const price = positive(value);
  const tick = positive(tickSize);
  if (!price || !tick) throw new Error('Options bracket price or tick size is invalid');
  const units = price / tick;
  const snappedUnits = direction === 'up'
    ? Math.ceil(units - 1e-10)
    : Math.floor(units + 1e-10);
  const snapped = Number((snappedUnits * tick).toPrecision(12));
  if (!(snapped > 0)) throw new Error('Options bracket price rounded to a non-positive value');
  return snapped;
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
  isMarketTickFresh = () => false,
  getRecentCloseDetails = null
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
      throw new Error('Delta Options market-data and preview operations require the explicit Delta India Testnet profile');
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
    // Delta documents integer contract size. Honour product-specific size
    // fields when the catalogue supplies them; otherwise the verified API
    // contract is one whole option contract per size unit.
    const minSize = positive(product.minimum_order_size ?? product.min_order_size ??
      product.product_specs?.minimum_order_size) ?? 1;
    const sizeStep = positive(product.order_size_increment ?? product.size_increment ??
      product.product_specs?.order_size_increment) ?? 1;
    if (!Number.isSafeInteger(id) || id <= 0 || !contractValue || !tickSize ||
        feeRate === null || feeRate < 0 || feeRate > 0.02 ||
        !Number.isSafeInteger(minSize) || !Number.isSafeInteger(sizeStep)) {
      throw new Error('Delta India Demo Options product metadata is incomplete or outside verified bounds: ' + normalized);
    }
    return {
      ...product, id, contractValue, tickSize, feeRate, minSize, sizeStep, parsed,
      contractType: expectedType
    };
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
        '&select=symbol,strategy,score,stage,cached_at,details,market_regime,iv_rank,iv_percentile,oi,volume,delta,spread_pct&limit=2'
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
    const ivPercentile = number(row.iv_percentile ?? details.ivPercentile);
    const marketRegime = clean(row.market_regime || details.marketRegime).toUpperCase();
    const demoQualityOverride = isOptionsDemoExecution(env) && manualTestOverride === true;
    const normalizedScore = number(row.score);
    if (normalizedScore === null || normalizedScore < 80) {
      throw new Error('Options candidate normalized score is below the mandatory 80 minimum');
    }
    if (!demoQualityOverride) {
      const ivMetricsGate = evaluateIvMetrics(strategy, ivRank, ivPercentile);
      if (!ivMetricsGate.allowed) throw new Error(ivMetricsGate.reason);
      if (isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED)) {
        const expectedRegime = strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS';
        if (marketRegime !== expectedRegime) throw new Error('Market regime does not permit this Options strategy');
        if (!isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
          throw new Error('60-second Options exit monitor must be enabled before regime-based entries');
        }
      }
    }
    if (!manualTestOverride &&
        (clean(row.stage).toUpperCase() !== 'CONFIRMED' ||
         details.analysisReady !== true)) {
      throw new Error('Options candidate is not confirmed by the worker analysis gates');
    }
    if (demoQualityOverride) {
      const delta = number(details.delta ?? row.delta);
      const stage = clean(row.stage).toUpperCase();
      const openInterest = number(row.oi ?? details.openInterest);
      const volume = number(row.volume ?? details.volume);
      const ivHistoryDays = number(details.ivHistoryDays ?? details.ivPercentileDays);
      const ivPercentileDays = number(details.ivPercentileDays);
      const qualitySettingsRows = await database.select(
        'dd_settings',
        'id=eq.1&select=options_min_oi,options_min_volume'
      );
      if (!Array.isArray(qualitySettingsRows) || qualitySettingsRows.length !== 1) {
        throw new Error('Demo Options quality-filter audit settings are unavailable');
      }
      const qualitySettings = qualitySettingsRows[0];
      const minimumOi = number(qualitySettings.options_min_oi);
      const minimumVolume = number(qualitySettings.options_min_volume);
      const ivRankOk = ivRank !== null && ivRank >= 0 && ivRank <= 100 &&
        (strategy === 'OPTIONS_BUY' ? ivRank < 40 : ivRank > 50);
      const ivPercentileOk = ivPercentile !== null && ivPercentile >= 0 && ivPercentile <= 100 &&
        (strategy === 'OPTIONS_BUY' ? ivPercentile < 20 : ivPercentile > 80);
      const expectedRegime = strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS';
      const observations = [];
      if (openInterest === null || (minimumOi !== null && openInterest < minimumOi)) observations.push({
        code: 'OI_BELOW_MIN_DEMO_LOG_ONLY', actual: openInterest, expected: minimumOi === null ? 'configured minimum unavailable' : '>=' + minimumOi
      });
      if (stage !== 'CONFIRMED') observations.push({
        code: 'STAGE_NOT_CONFIRMED_DEMO_LOG_ONLY', actual: stage || null, expected: 'CONFIRMED'
      });
      if (ivPercentile === null) observations.push({
        code: 'IV_PCTL_UNAVAILABLE_DEMO_LOG_ONLY', actual: null, expected: 'strategy-qualified IV percentile'
      });
      if (ivHistoryDays === null || ivHistoryDays < 20) observations.push({
        code: 'IV_HISTORY_SHORT_DEMO_LOG_ONLY', actual: ivHistoryDays, expected: '>=20 completed days',
        ivPercentileDays
      });
      if (marketRegime === 'UNKNOWN' || !marketRegime) observations.push({
        code: 'REGIME_UNKNOWN_DEMO_LOG_ONLY', actual: marketRegime || null, expected: expectedRegime
      });
      else if (marketRegime !== expectedRegime) observations.push({
        code: 'REGIME_STRATEGY_MISMATCH_DEMO_LOG_ONLY', actual: marketRegime, expected: expectedRegime
      });
      if (details.analysisReady !== true) observations.push({
        code: 'ANALYSIS_NOT_READY_DEMO_LOG_ONLY', actual: details.analysisReady ?? false, expected: true
      });
      if (!ivRankOk) observations.push({
        code: 'IV_RANK_QUALITY_FILTER_DEMO_LOG_ONLY', actual: ivRank,
        expected: strategy === 'OPTIONS_BUY' ? '<40' : '>50'
      });
      if (ivPercentile !== null && !ivPercentileOk) observations.push({
        code: 'IV_PERCENTILE_STRATEGY_FILTER_DEMO_LOG_ONLY', actual: ivPercentile,
        expected: strategy === 'OPTIONS_BUY' ? '<20' : '>80'
      });
      if (volume === null || (minimumVolume !== null && volume < minimumVolume)) observations.push({
        code: 'VOLUME_BELOW_MIN_DEMO_LOG_ONLY', actual: volume,
        expected: minimumVolume === null ? 'configured minimum unavailable' : '>=' + minimumVolume
      });
      if (delta === null) observations.push({
        code: 'DELTA_UNAVAILABLE_DEMO_LOG_ONLY', actual: null, expected: 'finite non-zero Delta within hard validity range'
      });
      await logExecutor('WARN', '[OptionsExecutor] Demo-only quality filters are LOG-ONLY; hard score/risk/size/expiry/spread/product/E-STOP/hedge checks remain blocking', {
        environment: 'DELTA_DEMO',
        symbol: clean(row.symbol).toUpperCase(),
        strategy,
        score: normalizedScore,
        stage,
        openInterest,
        minimumOi,
        volume,
        minimumVolume,
        ivRank,
        ivPercentile,
        ivHistoryDays,
        ivPercentileDays,
        delta,
        marketRegime,
        analysisReady: details.analysisReady === true,
        qualityFiltersObserved: observations
      });
    }
    return {
      ...row, details, ivRank, ivPercentile, marketRegime, cachedAt: new Date(cachedAtMs).toISOString(),
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
    const demoQualityOverride = isOptionsDemoExecution(env);
    if (deltaMin === null || deltaMax === null || deltaMin <= 0 || deltaMax < deltaMin ||
        Math.abs(delta) < deltaMin || Math.abs(delta) > deltaMax) {
      throw new Error('Manual test override blocked: option Delta is outside the configured ' +
        (isBuy ? 'BUY' : 'SELL') + ' band');
    }
    if (demoQualityOverride && (Math.abs(delta) < 0.05 || Math.abs(delta) > 0.95)) {
      throw new Error('Demo candidate Delta must remain within the hard 0.05–0.95 validity band');
    }

    // Demo mode bypasses only regime-based expiry tightening; configured
    // minimum/maximum DTE from dd_settings remain mandatory.
    const regimeBased = isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) && !demoQualityOverride;
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
    const secret = clean(env.DELTA_DEMO_API_SECRET);
    if (!secret) throw new Error('Delta Demo Options signing secret is unavailable');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return encoded + '.' + signature;
  }

  function verifyQuoteToken(token) {
    const pieces = clean(token).split('.');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
      throw new Error('Options preview confirmation token is invalid');
    }
    const secret = clean(env.DELTA_DEMO_API_SECRET);
    if (!secret) throw new Error('Delta Demo Options signing secret is unavailable');
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
      database.select('dd_settings', 'id=eq.1&select=options_max_risk_pct,max_options_positions,enabled,emergency_stop,last_tick_at,options_buy_min_delta,options_buy_max_delta,options_sell_min_delta,options_sell_max_delta,options_min_days_to_expiry,options_max_days_to_expiry,options_min_oi,options_min_volume,options_max_spread_pct')
    ]);
    const settings = Array.isArray(settingsRows) && settingsRows.length === 1 ? settingsRows[0] : null;
    if (!settings) throw new Error('Options risk settings are unavailable; preview blocked');
    if (quantity < product.minSize || (quantity - product.minSize) % product.sizeStep !== 0) {
      throw new Error('Options quantity violates the exact Demo product minimum size or contract-size increment');
    }
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
    const spreadPct = ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100;
    const configuredMaxSpreadPct = resolveOptionsMaxSpreadPct(settings);
    if (!Number.isFinite(spreadPct) || spreadPct < 0 || spreadPct > configuredMaxSpreadPct) {
      throw new Error('Options order blocked: live Demo quote spread ' + spreadPct.toFixed(4) +
        '% exceeds configured ' + configuredMaxSpreadPct.toFixed(2) + '% maximum');
    }
    const optionsRiskPct = number(settings.options_max_risk_pct);
    if (optionsRiskPct === null || optionsRiskPct <= 0) {
      throw new Error('Existing Options risk percentage is missing or invalid; preview blocked');
    }
    let hedgeProduct = null;
    let hedgeQuote = null;
    let premium;
    let hedgePremium = null;
    let hedgeSpreadPct = null;
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
      hedgeSpreadPct = ((hedgeQuote.ask - hedgeQuote.bid) / ((hedgeQuote.ask + hedgeQuote.bid) / 2)) * 100;
      if (!Number.isFinite(hedgeSpreadPct) || hedgeSpreadPct < 0 || hedgeSpreadPct > configuredMaxSpreadPct) {
        throw new Error('Protective hedge quote spread exceeds the unchanged ' +
          configuredMaxSpreadPct.toFixed(2) + '% maximum');
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
    const isBuy = strategyKey === 'OPTIONS_BUY';
    const stopPremium = snapPriceToTick(
      premium * (isBuy ? 0.70 : 2.0),
      product.tickSize,
      isBuy ? 'down' : 'up'
    );
    const takeProfitPremium = snapPriceToTick(
      premium * (isBuy ? 1.50 : 0.50),
      product.tickSize,
      isBuy ? 'up' : 'down'
    );
    if (!(stopPremium > 0) || !(takeProfitPremium > 0) ||
        (isBuy && !(stopPremium < premium && takeProfitPremium > premium)) ||
        (!isBuy && !(takeProfitPremium < premium && stopPremium > premium))) {
      throw new Error('Options SL/TP bracket levels are invalid for the verified product tick size');
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
      hedgeSpreadPct,
      stopPremium,
      takeProfitPremium,
      minSize: product.minSize,
      sizeStep: product.sizeStep,
      spreadPct,
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
      hedgeSpreadPct,
      hedgeSymbol: hedgeProduct?.symbol || null,
      contractId: product.id,
      hedgeContractId: hedgeProduct?.id ?? null,
      contractValue: product.contractValue,
      tickSize: product.tickSize,
      minSize: product.minSize,
      sizeStep: product.sizeStep,
      spreadPct,
      stopPremium,
      takeProfitPremium,
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
      environment: 'DELTA_DEMO',
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
    // Preview-only scanning may run with execution disabled; actual entry
    // always requires the complete Demo-only env gate.
    assertOptionsExecutionAllowed(env);
    const settingsRows = await database.select(
      'dd_settings',
      'id=eq.1&select=id,enabled,auto_trade,emergency_stop,options_enabled,options_buy_enabled,options_sell_enabled,options_execution_enabled,last_tick_at,max_options_positions,options_max_open_positions,options_daily_loss_limit_pct'
    );
    if (!Array.isArray(settingsRows) || settingsRows.length !== 1) {
      throw new Error('Options entry settings are unavailable; order blocked');
    }
    const settings = settingsRows[0];
    if (settings.enabled !== true) throw new Error('Trading engine is disabled; Options entry blocked');
    if (settings.auto_trade !== true) throw new Error('Auto Trade is off or unknown; Options entry blocked');
    if (settings.emergency_stop !== false) throw new Error('Emergency Stop is active or unknown; Options entry blocked');
    if (settings.options_enabled !== true) throw new Error('Options strategy is disabled in dd_settings');
    if (preview.strategy === 'OPTIONS_BUY' && settings.options_buy_enabled !== true) {
      throw new Error('Options BUY is disabled in dd_settings');
    }
    if (preview.strategy === 'OPTIONS_SELL' && settings.options_sell_enabled !== true) {
      throw new Error('Options SELL is disabled in dd_settings');
    }
    if (!getOptionsDatabaseExecutionGate(settings).allowed) {
      throw new Error(OPTIONS_DATABASE_EXECUTION_LOCK_REASON + ' Options entry blocked');
    }
    if ((isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) || isOptionsDemoExecution(env)) &&
        !isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      throw new Error('Options entries require OPTIONS_EXIT_MONITOR_ENABLED=true');
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
    const configuredMaxOptionsPositions = Number(settings.max_options_positions);
    const strategyMaxPositions = Number(settings.options_max_open_positions);
    if (!Number.isSafeInteger(configuredMaxOptionsPositions) || configuredMaxOptionsPositions < 1 ||
        !Number.isSafeInteger(strategyMaxPositions) || strategyMaxPositions < 1) {
      throw new Error('Configured Options position caps are unavailable or invalid; entry blocked');
    }
    const maxOptionsPositions = Math.min(configuredMaxOptionsPositions, strategyMaxPositions);
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
    manualTestOverride = false, bracketStopLossPrice = null, bracketTakeProfitPrice = null
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
    const hasBracket = bracketStopLossPrice !== null || bracketTakeProfitPrice !== null;
    if (hasBracket && (!positive(bracketStopLossPrice) || !positive(bracketTakeProfitPrice) ||
        reduceOnly || !['ENTRY','SHORT'].includes(role))) {
      throw new Error('Demo Options entry bracket requires two positive prices on a non-reduce-only entry leg');
    }
    const body = {
      product_id: product.id,
      size: qty,
      side: String(side).toLowerCase(),
      order_type: price === null ? 'market_order' : 'limit_order',
      client_order_id: clientOrderId,
      ...(price !== null ? { limit_price: String(price) } : {}),
      ...(hasBracket ? {
        bracket_stop_loss_price: String(bracketStopLossPrice),
        bracket_take_profit_price: String(bracketTakeProfitPrice),
        bracket_stop_trigger_method: 'mark_price'
      } : {}),
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
        reduce_only: reduceOnly,
        bracket_stop_loss_price: bracketStopLossPrice,
        bracket_take_profit_price: bracketTakeProfitPrice,
        bracket_stop_trigger_method: hasBracket ? 'mark_price' : null
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
      await logExecutor('INFO', '[OptionsExecutor] Delta India Demo option leg acknowledged', {
        environment: 'DELTA_DEMO',
        symbol: product.symbol,
        productId: product.id,
        contract_id: product.id,
        side: String(side).toUpperCase(),
        qty,
        orderId: order.id ?? null,
        orderState: state,
        role,
        entry_price: price,
        stop_loss_price: bracketStopLossPrice,
        take_profit_price: bracketTakeProfitPrice,
        bracketAttachedToEntry: hasBracket,
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
      await logExecutor('ERROR', '[OptionsExecutor] Delta India Demo Options order failed', {
        environment: 'DELTA_DEMO',
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

  async function verifyExchangeSideBracket(order, product, side, qty, {
    stop, takeProfit, strategy, maxLossUsd, executionKey, manualTestOverride = false,
    afterUnwind = null
  } = {}) {
    // Delta accepts bracket fields on CreateOrderRequest, but those fields
    // are not guaranteed to be echoed by the parent order response. Prefer
    // an explicit parent echo when present; otherwise verify both live
    // reduce-only stop child orders returned by the exchange.
    const detail = await getOrderDetail(order);
    const tolerance = Math.max(1e-8, Number(product.tickSize) / 2);
    const matchesPrice = (actual, expected) =>
      actual !== null && Math.abs(actual - Number(expected)) <= tolerance;
    const reportedStop = number(detail?.bracket_stop_loss_price ??
      detail?.bracketStopLossPrice ?? detail?.bracket_stop?.stop_price);
    const reportedTakeProfit = number(detail?.bracket_take_profit_price ??
      detail?.bracketTakeProfitPrice ?? detail?.bracket_take_profit?.limit_price);
    let verification = {
      // The parent-order schema does not promise bracket fields. Even if
      // undocumented fields happen to echo the request, only live child
      // orders prove that exchange-side protection is active.
      verified: false,
      method: 'exchange_reduce_only_child_orders',
      stopOrderId: null,
      takeProfitOrderId: null,
      reportedParentStop: reportedStop,
      reportedParentTakeProfit: reportedTakeProfit
    };

    for (let attempt = 0; !verification.verified && attempt < 5; attempt += 1) {
      const active = await request('GET', '/v2/orders', {
        product_ids: product.id,
        states: 'open,pending',
        contract_types: product.contractType,
        page_size: 100
      });
      if (!Array.isArray(active?.result)) {
        throw new Error('Delta Demo active Options order snapshot is malformed; SL/TP verification blocked');
      }
      const closeSide = side === 'BUY' ? 'sell' : 'buy';
      const children = active.result.filter(row =>
        Number(row?.product_id ?? row?.productId) === Number(product.id) &&
        lower(row?.side) === closeSide &&
        (row?.reduce_only === true || lower(row?.reduce_only) === 'true') &&
        Number(row?.size) === Number(qty) &&
        !['cancelled','canceled','rejected','expired','filled','closed'].includes(lower(row?.state))
      );
      const stopChild = children.find(row =>
        lower(row?.stop_order_type) === 'stop_loss_order' &&
        matchesPrice(number(row?.stop_price ?? row?.trigger_price), stop)
      );
      const takeProfitChild = children.find(row =>
        lower(row?.stop_order_type) === 'take_profit_order' &&
        matchesPrice(number(row?.stop_price ?? row?.trigger_price), takeProfit)
      );
      if (stopChild && takeProfitChild) {
        verification = {
          verified: true,
          method: 'exchange_reduce_only_child_orders',
          stopOrderId: stopChild.id ?? null,
          takeProfitOrderId: takeProfitChild.id ?? null,
          stop: number(stopChild.stop_price ?? stopChild.trigger_price),
          takeProfit: number(takeProfitChild.stop_price ?? takeProfitChild.trigger_price)
        };
        break;
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 350));
    }

    if (verification.verified) {
      await logExecutor('INFO', '[OptionsExecutor] Delta India Demo exchange-side SL/TP protection verified', {
        environment: 'DELTA_DEMO',
        symbol: product.symbol,
        parentOrderId: order?.id ?? null,
        side,
        size: qty,
        stopLossPrice: stop,
        takeProfitPrice: takeProfit,
        verification
      });
      return verification;
    }

    await logExecutor('ERROR', '[OptionsExecutor] Delta India Demo exchange-side SL/TP protection not found; reduce-only unwind required', {
      environment: 'DELTA_DEMO',
      symbol: product.symbol,
      parentOrderId: order?.id ?? null,
      side,
      size: qty,
      expectedStop: stop,
      expectedTakeProfit: takeProfit,
      verification,
      action: 'CANCEL_OR_REDUCE_ONLY_UNWIND'
    });

    const cancellation = await cancelProtective(order);
    if (!cancellation.confirmed) {
      const error = new Error('Exchange-side Options bracket could not be verified and entry cancellation is unconfirmed; manual reconciliation required');
      error.ambiguous = true;
      throw error;
    }
    if (cancellation.filledQty === null || !Number.isSafeInteger(Number(cancellation.filledQty)) ||
        Number(cancellation.filledQty) < 0) {
      const error = new Error('Exchange returned no reliable fill quantity while removing an unprotected Options entry; manual reconciliation required');
      error.ambiguous = true;
      throw error;
    }
    if (cancellation.filledQty > 0) {
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const closeOrder = await submitLeg(product, closeSide, cancellation.filledQty, null, {
        strategy,
        role: 'UNWIND',
        maxLossUsd,
        reduceOnly: true,
        executionKey,
        manualTestOverride
      });
      const closeFill = await waitForProtectiveFill(closeOrder, cancellation.filledQty);
      if (closeFill?.fullyFilled !== true || Number(closeFill.filledQty) !== cancellation.filledQty) {
        const error = new Error('Options bracket was not verified and reduce-only exposure unwind is not fully confirmed');
        error.ambiguous = true;
        throw error;
      }
    }
    if (typeof afterUnwind === 'function') {
      try {
        await afterUnwind();
      } catch (cause) {
        const error = new Error('Unprotected Options entry unwind completed but the protective hedge leg could not be closed: ' +
          String(cause?.message || cause).slice(0, 180));
        error.ambiguous = true;
        throw error;
      }
    }
    const error = new Error('Delta Demo API did not confirm exchange-side SL/TP child orders; the entry was canceled or fully unwound');
    error.code = 'OPTIONS_EXCHANGE_BRACKET_UNVERIFIED';
    error.status = 409;
    throw error;
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
    if (!Number.isSafeInteger(id) || id <= 0) return { confirmed: false, filledQty: null };
    let latest = await getOrderDetail(order);
    let status = fillStatus(latest);
    if (['cancelled','canceled','rejected','expired','filled','closed'].includes(status.state)) {
      return { confirmed: true, filledQty: status.filledQty, order: latest };
    }
    await request('DELETE', '/v2/orders', {}, { id });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      latest = await getOrderDetail(order);
      status = fillStatus(latest);
      if (['cancelled','canceled','rejected','expired','filled','closed'].includes(status.state)) {
        return { confirmed: true, filledQty: status.filledQty, order: latest };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { confirmed: false, filledQty: fillStatus(latest).filledQty, order: latest };
  }

  async function confirmBuyEntryFillOrCancelAndUnwind(order, product, qty, preview, executionKey) {
    let fill = await waitForProtectiveFill(order, qty);
    if (fill?.fullyFilled === true && Number(fill.filledQty) === Number(qty) && positive(fill.averageFillPrice)) {
      return fill;
    }
    const cancellation = await cancelProtective(order);
    if (cancellation.confirmed !== true) {
      const error = new Error('Demo Options BUY did not fill in time and exchange cancellation is unconfirmed');
      error.ambiguous = true;
      throw error;
    }
    const finalStatus = cancellation.order ? fillStatus(cancellation.order) : null;
    if (finalStatus?.fullyFilled === true &&
        Number(finalStatus.filledQty) === Number(qty) &&
        positive(finalStatus.averageFillPrice)) {
      return finalStatus;
    }
    const cancelledFilledQty = cancellation.filledQty;
    if (!Number.isSafeInteger(Number(cancelledFilledQty)) || Number(cancelledFilledQty) < 0) {
      const error = new Error('Demo Options BUY cancellation returned an unknown filled quantity; reconcile before retry');
      error.ambiguous = true;
      throw error;
    }
    if (Number(cancelledFilledQty) > 0) {
      await submitAndConfirmReduceOnlyUnwind(
        product, order, Number(cancelledFilledQty), preview, executionKey
      );
    }
    const error = new Error(
      Number(cancelledFilledQty) > 0
        ? 'Demo Options BUY was partially filled, then canceled and fully unwound; no position was opened'
        : 'Demo Options BUY was not filled and the resting order was canceled; no position was opened'
    );
    error.code = 'OPTIONS_ENTRY_NOT_FILLED';
    error.status = 409;
    throw error;
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
      raw: {
        environment: 'DELTA_DEMO',
        iv_rank: candidate.ivRank,
        iv_percentile: candidate.ivPercentile,
        regime: candidate.marketRegime,
        stop_premium: preview.stopPremium,
        take_profit_premium: preview.takeProfitPremium,
        exchange_bracket_required: true,
        entry_pending: true
      }
    };
    const inserted = await database.insert('dd_option_positions', row);
    if (Array.isArray(inserted) && inserted.length === 0) throw new Error('Options position reservation was not confirmed; entry blocked');
    return row;
  }

  async function verifyDemoOptionPositions(expectedLegs = []) {
    if (!Array.isArray(expectedLegs) || !expectedLegs.length) {
      throw new Error('Demo Options position verification requires expected filled legs');
    }
    let lastChecks = [];
    let lastRowCount = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request('GET', '/v2/positions/margined', {
        contract_types: 'call_options,put_options'
      });
      if (!Array.isArray(response?.result)) {
        throw new Error('Delta Demo Options positions endpoint returned a malformed snapshot');
      }
      const rows = response.result;
      lastRowCount = rows.length;
      lastChecks = expectedLegs.map(expected => {
        const matching = rows.filter(row =>
          clean(row?.product_symbol || row?.symbol).toUpperCase() === clean(expected.product.symbol).toUpperCase() &&
          Number(row?.product_id ?? row?.productId) === Number(expected.product.id)
        );
        const signedSize = matching.reduce((sum, row) =>
          sum + (number(row?.size ?? row?.signed_size ?? row?.qty) ?? 0), 0);
        const sideSign = expected.side === 'SELL' ? -1 : 1;
        return {
          symbol: expected.product.symbol,
          productId: expected.product.id,
          expectedSide: expected.side,
          expectedSize: expected.qty,
          observedSignedSize: signedSize,
          verified: matching.length > 0 &&
            Math.sign(signedSize) === sideSign &&
            Math.abs(signedSize) >= expected.qty
        };
      });
      if (lastChecks.every(row => row.verified)) {
        await logExecutor('INFO', '[OptionsExecutor] Delta India Demo exchange positions verified after fills', {
          environment: 'DELTA_DEMO',
          positions: lastChecks,
          snapshotRows: lastRowCount
        });
        return { verified: true, positions: lastChecks, snapshotRows: lastRowCount };
      }
      if (attempt < 10) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { verified: false, positions: lastChecks, snapshotRows: lastRowCount };
  }

  async function requireDemoPositionVerification(executionKey, expectedLegs) {
    const verification = await verifyDemoOptionPositions(expectedLegs);
    if (verification.verified) return verification;
    await database.update('dd_option_positions',
      'position_key=eq.' + encodeURIComponent(executionKey) + '&status=eq.OPEN', {
        status: 'RECONCILIATION_REQUIRED',
        updated_at: new Date(now()).toISOString(),
        raw: { exchange_position_verification: verification, reconciliation_required: true }
      }).catch(() => {});
    await logExecutor('ERROR', '[OptionsExecutor] Demo order fill lacks exchange position confirmation; locked for reconciliation', {
      environment: 'DELTA_DEMO',
      executionKey,
      positions: verification.positions,
      snapshotRows: verification.snapshotRows
    });
    return verification;
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
      raw: {
        environment: 'DELTA_DEMO',
        iv_rank: candidate.ivRank,
        iv_percentile: candidate.ivPercentile,
        regime: candidate.marketRegime,
        entry_order_state: order?.state ?? null,
        hedge_entry_order_state: hedgeOrder?.state ?? null,
        stop_premium: preview.stopPremium,
        take_profit_premium: preview.takeProfitPremium,
        bracket_attached_to_entry: true,
        bracket_trigger: 'mark_price',
        exit_policy: preview.strategy === 'OPTIONS_BUY' ? 'TP_50_SL_30_BREAKEVEN_AFTER_1R' : 'TP_50_DECAY_SL_2X_DTE_0_5'
      }
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
      sl_price: preview.stopPremium,
      tp_price: preview.takeProfitPremium,
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
    let reservedExecutionKey = null;
    let reservationPersisted = false;
    let positionRecorded = false;
    try {
      const expected = verifyQuoteToken(quoteToken);
      const executionKey = crypto.createHash('sha256').update(String(quoteToken)).digest('hex').slice(0, 18);
      reservedExecutionKey = executionKey;
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
          Math.abs(Number(expected.stopPremium) - preview.stopPremium) > tolerance ||
          Math.abs(Number(expected.takeProfitPremium) - preview.takeProfitPremium) > tolerance ||
          Math.abs(Number(expected.spreadPct) - preview.spreadPct) > 0.01 ||
          (preview.hedgeSpreadPct !== null &&
            Math.abs(Number(expected.hedgeSpreadPct) - preview.hedgeSpreadPct) > 0.01) ||
          Number(expected.equity) > preview.equity + 1e-8) {
        throw new Error('Options quote, product ID, equity or candidate changed since preview; refresh before execution');
      }
      await assertEntrySafety(preview);
      const product = await resolveProduct(preview.symbol);
      const candidate = await getCandidate(requestedSymbol, requestedStrategy, {
        manualTestOverride: useManualTestOverride
      });
      if (candidate.cachedAt !== preview.cachedAt) {
        throw new Error('Options candidate changed after preview; refresh the Demo preview before execution');
      }
      const demoMode = isOptionsDemoExecution(env);
      const regimeBased = demoMode || isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED);
      const regimeConstrainedExpiry = isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) && !demoMode;
      const hedgeProduct = preview.strategy === 'OPTIONS_SELL' ? await resolveProduct(preview.hedgeSymbol) : null;
      if (regimeConstrainedExpiry) {
        const minimumDte = preview.strategy === 'OPTIONS_BUY' ? 3 : 1;
        const maximumDte = preview.strategy === 'OPTIONS_BUY' ? 10 : 3;
        if (product.parsed.dte < 0.5 || product.parsed.dte < minimumDte || product.parsed.dte > maximumDte) {
          throw new Error('Options contract DTE is outside the regime-based expiry window');
        }
      }
      if (regimeBased) {
        reservationPersisted = true;
        await reserveOptionPosition({ executionKey, preview, candidate, product, hedgeProduct });
      }
      if (preview.strategy === 'OPTIONS_BUY') {
        const order = await submitLeg(product, 'BUY', preview.qty, preview.premium, {
          strategy: 'OPTIONS_BUY', role: 'ENTRY', maxLossUsd: preview.maxLossUsd, executionKey,
          manualTestOverride: preview.manualTestOverride === true,
          bracketStopLossPrice: preview.stopPremium,
          bracketTakeProfitPrice: preview.takeProfitPremium
        });
        let fill = null;
        let positionVerification = null;
        if (regimeBased) {
          fill = await confirmBuyEntryFillOrCancelAndUnwind(
            order, product, preview.qty, preview, executionKey
          );
          await verifyExchangeSideBracket(order, product, 'BUY', preview.qty, {
            stop: preview.stopPremium,
            takeProfit: preview.takeProfitPremium,
            strategy: preview.strategy,
            maxLossUsd: preview.maxLossUsd,
            executionKey,
            manualTestOverride: preview.manualTestOverride === true
          });
          positionRecorded = true;
          await recordOptionPosition({ executionKey, preview, candidate, product, order, fill });
          positionVerification = await requireDemoPositionVerification(executionKey, [
            { product, side: 'BUY', qty: preview.qty }
          ]);
        }
        const entryPrice = positive(fill?.averageFillPrice);
        await logExecutor('INFO', '[OptionsExecutor] Delta India Demo long Options order result', {
          environment: 'DELTA_DEMO',
          symbol: preview.symbol,
          side: 'BUY',
          size: preview.qty,
          entry: entryPrice,
          sl: preview.stopPremium,
          tp: preview.takeProfitPremium,
          order_id: order.id ?? null,
          status: fill?.state || clean(order.state || 'UNKNOWN').toUpperCase(),
          contract_id: product.id,
          max_loss: preview.maxLossUsd,
          manual_test_override: preview.manualTestOverride === true
        });
        return {
          success: positionVerification?.verified !== false,
          state: positionVerification?.verified === false ? 'RECONCILIATION_REQUIRED' : (fill?.state || clean(order.state || 'UNKNOWN').toUpperCase()),
          order, fill,
          positionVerification,
          contract_id: product.id, hedge_order_id: null,
          side: 'BUY',
          size: preview.qty,
          entry: entryPrice, sl: preview.stopPremium, tp: preview.takeProfitPremium,
          order_id: order.id ?? null,
          status: fill?.state || clean(order.state || 'UNKNOWN').toUpperCase(),
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
            manualTestOverride: preview.manualTestOverride === true,
            bracketStopLossPrice: preview.stopPremium,
            bracketTakeProfitPrice: preview.takeProfitPremium
          });
          if (!regimeBased) return shortOrder;
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
          await verifyExchangeSideBracket(lifecycle.shortOrder, product, 'SELL', preview.qty, {
            stop: preview.stopPremium,
            takeProfit: preview.takeProfitPremium,
            strategy: preview.strategy,
            maxLossUsd: preview.maxLossUsd,
            executionKey,
            manualTestOverride: preview.manualTestOverride === true,
            afterUnwind: async () => {
              const hedgeClose = await submitLeg(hedgeProduct, 'SELL', preview.qty, null, {
                strategy: 'OPTIONS_SELL',
                role: 'HEDGE_UNWIND',
                maxLossUsd: 0,
                hedgeOrderId: lifecycle.hedgeOrder?.id ?? null,
                reduceOnly: true,
                executionKey,
                manualTestOverride: preview.manualTestOverride === true
              });
              const hedgeCloseFill = await waitForProtectiveFill(hedgeClose, preview.qty);
              if (hedgeCloseFill?.fullyFilled !== true ||
                  Number(hedgeCloseFill.filledQty) !== preview.qty ||
                  !positive(hedgeCloseFill.averageFillPrice)) {
                const error = new Error('Protective BUY hedge reduce-only close is not fully confirmed');
                error.ambiguous = true;
                throw error;
              }
              await logExecutor('WARN', '[OptionsExecutor] Delta India Demo protective hedge closed after unverified short-entry bracket', {
                environment: 'DELTA_DEMO',
                symbol: hedgeProduct.symbol,
                side: 'SELL',
                size: preview.qty,
                entry: hedgeCloseFill.averageFillPrice,
                hedgeEntryOrderId: lifecycle.hedgeOrder?.id ?? null,
                hedgeCloseOrderId: hedgeClose.id ?? null,
                status: hedgeCloseFill.state
              });
            }
          });
          positionRecorded = true;
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
      const positionVerification = lifecycle.success
        ? await requireDemoPositionVerification(executionKey, [
            { product: hedgeProduct, side: 'BUY', qty: preview.qty },
            { product, side: 'SELL', qty: preview.qty }
          ])
        : null;
      await logExecutor(lifecycle.success && positionVerification?.verified !== false ? 'INFO' : 'ERROR',
        '[OptionsExecutor] Defined-risk Delta India Demo spread lifecycle result', {
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
          entry: positive(lifecycle.shortOrder?._shortFill?.averageFillPrice),
          sl: preview.stopPremium,
          tp: preview.takeProfitPremium,
          order_id: lifecycle.shortOrder?.id ?? null,
          status: lifecycle.shortOrder?._shortFill?.state || lifecycle.state,
          position_verification: positionVerification,
          reason: lifecycle.reason || null
        });
      return {
        ...lifecycle,
        success: lifecycle.success && positionVerification?.verified !== false,
        state: positionVerification?.verified === false ? 'RECONCILIATION_REQUIRED' : lifecycle.state,
        positionVerification,
        contract_id: product.id,
        hedge_contract_id: hedgeProduct.id,
        hedge_order_id: hedgeOrderId,
        side: 'SELL',
        size: preview.qty,
        entry: positive(lifecycle.shortOrder?._shortFill?.averageFillPrice),
        sl: preview.stopPremium,
        tp: preview.takeProfitPremium,
        order_id: lifecycle.shortOrder?.id ?? null,
        status: lifecycle.shortOrder?._shortFill?.state || lifecycle.state,
        fill: lifecycle.shortOrder?._shortFill || null,
        max_loss: preview.maxLossUsd
      };
    } catch (error) {
      if (reservationPersisted && reservedExecutionKey) {
        const reconciliationRequired = error?.ambiguous === true || positionRecorded;
        const at = new Date(now()).toISOString();
        await database.update('dd_option_positions',
          'position_key=eq.' + encodeURIComponent(reservedExecutionKey) +
          '&status=in.(ENTRY_PENDING,OPEN,HEDGE_CLOSE_PENDING)', {
            status: reconciliationRequired ? 'RECONCILIATION_REQUIRED' : 'CLOSED',
            realized_pnl: reconciliationRequired ? null : 0,
            realized_pnl_verified: !reconciliationRequired,
            closed_at: reconciliationRequired ? null : at,
            exit_reason: reconciliationRequired ? null : 'ENTRY_ABORTED',
            updated_at: at,
            raw: {
              environment: 'DELTA_DEMO',
              entry_error: String(error?.code || error?.message || 'unknown').slice(0, 240),
              ambiguous: error?.ambiguous === true,
              reconciliation_required: reconciliationRequired,
              doNotBlindlyRetry: true
            }
          }).catch(() => {});
        await logExecutor(reconciliationRequired ? 'ERROR' : 'WARN',
          '[OptionsExecutor] Demo entry reservation finalized after failure', {
            environment: 'DELTA_DEMO',
            executionKey: reservedExecutionKey,
            status: reconciliationRequired ? 'RECONCILIATION_REQUIRED' : 'CLOSED',
            reason: String(error?.message || error).slice(0, 240),
            doNotBlindlyRetry: true
          }).catch(() => {});
      }
      throw error;
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

  async function reconcileClosedOptionFills() {
    if (typeof getRecentCloseDetails !== 'function') {
      return { scanned: 0, reconciled: 0, unavailable: true };
    }
    const rows = await database.select(
      'dd_option_positions',
      'status=eq.CLOSED&realized_pnl_verified=eq.false&select=*&order=closed_at.asc&limit=25'
    );
    if (!Array.isArray(rows)) {
      throw new Error('Closed Options fill reconciliation snapshot is malformed');
    }
    let reconciled = 0;
    for (const position of rows) {
      if (!position?.position_key || !position?.entry_order_id ||
          !positive(position?.entry_premium) || !positive(position?.qty) ||
          !positive(position?.contract_size)) continue;
      try {
        const entryFillRows = await database.select(
          'dd_fills',
          'order_id=eq.' + encodeURIComponent(String(position.entry_order_id)) +
            '&select=product_id,symbol&limit=5'
        );
        const entryProductIds = Array.isArray(entryFillRows)
          ? [...new Set(entryFillRows
              .filter(fill => !fill?.symbol || clean(fill.symbol).toUpperCase() === clean(position.symbol).toUpperCase())
              .map(fill => Number(fill?.product_id))
              .filter(id => Number.isSafeInteger(id) && id > 0))]
          : [];
        const productId = entryProductIds.length === 1
          ? entryProductIds[0]
          : (await resolveProduct(position.symbol)).id;
        const details = await getRecentCloseDetails(position.symbol, position.opened_at, {
          ...position,
          product_id: productId,
          raw: { ...(position.raw || {}), product_id: productId }
        });
        const exitPrice = positive(details?.exit_price);
        const closeOrderId = clean(details?.close_order_id);
        if (!exitPrice || !closeOrderId || details?.close_fill_history_complete !== true) {
          continue;
        }
        const realizedPnl = number(details?.realized_pnl);
        const verified = realizedPnl !== null;
        const updatedAt = new Date(now()).toISOString();
        const raw = {
          ...(position.raw || {}),
          exit_fill_price: exitPrice,
          exit_order_id: closeOrderId,
          exit_client_order_id: details?.client_order_id || null,
          exit_fees: number(details?.fees),
          exit_fee_currency: details?.fee_currency || null,
          exit_fill_type: details?.fill_type || null,
          exit_order_type: details?.order_type || null,
          exit_fill_history_complete: true,
          exit_fill_verified: verified,
          exit_fill_reconciled_at: updatedAt,
          realized_pnl_note: verified
            ? 'Realized PnL sourced from the authenticated Delta Testnet close fill'
            : 'Exact exit fill price verified; exchange realized PnL was not present, so PnL remains unverified'
        };
        await database.update(
          'dd_option_positions',
          'position_key=eq.' + encodeURIComponent(position.position_key) +
            '&status=eq.CLOSED&realized_pnl_verified=eq.false',
          {
            short_exit_premium: exitPrice,
            realized_pnl: verified ? realizedPnl : null,
            realized_pnl_verified: verified,
            updated_at: updatedAt,
            raw
          }
        );
        const confirmed = await database.select(
          'dd_option_positions',
          'position_key=eq.' + encodeURIComponent(position.position_key) +
            '&select=position_key,status,short_exit_premium,realized_pnl,realized_pnl_verified,raw&limit=1'
        );
        const row = Array.isArray(confirmed) ? confirmed[0] : null;
        if (!row || row.status !== 'CLOSED' ||
            Math.abs(Number(row.short_exit_premium) - exitPrice) > 1e-8 ||
            (verified && (row.realized_pnl_verified !== true ||
              Math.abs(Number(row.realized_pnl) - realizedPnl) > 1e-8))) {
          throw new Error('Options close-fill reconciliation read-after-write verification failed');
        }
        reconciled += 1;
        await logExecutor('INFO', '[OptionsExecutor] Externally closed Option fill reconciled from authenticated Demo history', {
          positionKey: position.position_key,
          symbol: position.symbol,
          closeOrderId,
          exitPrice,
          realizedPnl: verified ? realizedPnl : null,
          realizedPnlVerified: verified
        });
      } catch (error) {
        await logExecutor('WARN', '[OptionsExecutor] Closed Option fill remains unverified', {
          positionKey: position.position_key,
          symbol: position.symbol,
          error: String(error?.message || error).slice(0, 220)
        }).catch(() => {});
      }
    }
    return { scanned: rows.length, reconciled, unavailable: false };
  }

  async function monitorOptionsExits() {
    if (!isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      return { status: 'DISABLED', monitored: 0, exits: 0 };
    }
    assertTestnetProfile();
    const closeFillReconciliation = await reconcileClosedOptionFills();
    const rows = await database.select('dd_option_positions', 'status=in.(OPEN,HEDGE_CLOSE_PENDING)&select=*&order=opened_at.asc&limit=100');
    if (!Array.isArray(rows)) throw new Error('Options exit monitor position snapshot is malformed');
    let exits = 0;
    for (const position of rows) {
      try {
        if (normalizeOptionsExitStatus(position.status) === 'HEDGE_CLOSE_PENDING') {
          const result = await closeSellHedge(position, position.exit_reason || 'OPTIONS_SELL_EXIT');
          if (result.closed) exits += 1;
          continue;
        }
        const quoteResponse = await request('GET', '/v2/tickers/' + encodeURIComponent(position.symbol));
        const ticker = Array.isArray(quoteResponse?.result)
          ? quoteResponse.result.find(row => clean(row?.symbol).toUpperCase() === clean(position.symbol).toUpperCase())
          : quoteResponse?.result ?? quoteResponse;
        if (!ticker || clean(ticker.symbol).toUpperCase() !== clean(position.symbol).toUpperCase()) throw new Error('Options exit quote did not match the open contract');
        const bid = positive(ticker?.quotes?.best_bid ?? ticker?.best_bid ?? ticker?.bid);
        const ask = positive(ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask);
        if (!bid || !ask || ask < bid) throw new Error('Options exit bid/ask is unavailable');
        const isBuy = normalizeOptionsExitStatus(position.strategy) === 'OPTIONS_BUY';
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
        const errorCode = clean(error?.code || error?.error_code).toLowerCase();
        const errorMessage = String(error?.message || error);
        const exchangeAlreadyFlat = errorCode === 'no_position_for_reduce_only' ||
          /\bno_position_for_reduce_only\b/i.test(errorMessage);
        if (exchangeAlreadyFlat && normalizeOptionsExitStatus(position.strategy) === 'OPTIONS_BUY' &&
            normalizeOptionsExitStatus(position.status) === 'OPEN') {
          const closedAt = new Date(now()).toISOString();
          await database.update(
            'dd_option_positions',
            'position_key=eq.' + encodeURIComponent(position.position_key) + '&status=eq.OPEN',
            {
              status: 'CLOSED',
              exit_reason: 'EXTERNAL_CLOSE_UNVERIFIED',
              closed_at: closedAt,
              updated_at: closedAt,
              realized_pnl: null,
              realized_pnl_verified: false,
              raw: {
                ...(position.raw || {}),
                external_close_confirmed_by_reduce_only_rejection: true,
                exit_fill_reconciliation_pending: true,
                exit_fill_verified: false,
                external_close_error_code: 'no_position_for_reduce_only',
                external_close_observed_at: closedAt
              }
            }
          );
          await logExecutor('WARN', '[OptionsExitMonitor] Exchange reports no open long Option position; stopped repeat exit attempts and queued fill reconciliation', {
            positionKey: position.position_key,
            symbol: position.symbol,
            strategy: position.strategy,
            status: 'CLOSED',
            realizedPnlVerified: false
          }).catch(() => {});
          continue;
        }
        if (exchangeAlreadyFlat) {
          const updatedAt = new Date(now()).toISOString();
          await database.update(
            'dd_option_positions',
            'position_key=eq.' + encodeURIComponent(position.position_key) +
              '&status=eq.' + encodeURIComponent(position.status),
            {
              status: 'RECONCILIATION_REQUIRED',
              exit_reason: 'NO_POSITION_FOR_REDUCE_ONLY_RECONCILIATION_REQUIRED',
              updated_at: updatedAt,
              raw: {
                ...(position.raw || {}),
                reduce_only_rejected_no_position: true,
                exit_fill_reconciliation_pending: true,
                external_close_error_code: 'no_position_for_reduce_only',
                external_close_observed_at: updatedAt
              }
            }
          );
          await logExecutor('WARN', '[OptionsExitMonitor] No-position rejection parked the Options spread for reconciliation; no further blind exit retries', {
            positionKey: position.position_key,
            symbol: position.symbol,
            strategy: position.strategy,
            priorStatus: position.status,
            status: 'RECONCILIATION_REQUIRED'
          }).catch(() => {});
          continue;
        }
        await logExecutor('ERROR', '[OptionsExitMonitor] Position exit check failed; position remains tracked', {
          positionKey: position.position_key, symbol: position.symbol,
          strategy: position.strategy, status: position.status,
          reason: errorMessage.slice(0, 240)
        }).catch(() => {});
      }
    }
    return { status: 'OK', monitored: rows.length, exits, closeFillReconciliation };
  }

  return Object.freeze({ previewOptionsOrder, placeOptionsOrder, monitorOptionsExits });
}
