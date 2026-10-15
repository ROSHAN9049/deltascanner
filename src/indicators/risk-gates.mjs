/**
 * Pure, fail-closed risk-gate calculations for dashboard/strategy diagnostics.
 * These helpers do not perform I/O and do not call order or entry APIs.
 *
 * Missing, malformed or insufficient observations return BLOCK with an
 * explicit numeric limit and reason; this module never returns UNKNOWN.
 *
 * The BTC regime calculation intentionally reuses the existing worker EMA
 * and ATR helpers instead of duplicating those implementations here.
 */
import { atr as workerATR, ema as workerEMA } from '../../worker/strategy.mjs';

const DEFAULT_RANGE_LIMIT = 3;
const DEFAULT_EMA_DISTANCE_LIMIT = 2.5;
const DEFAULT_BTC_ATR_LIMIT = 4;
const DEFAULT_SPREAD_LIMIT = 0.35;
const DEFAULT_COST_LIMIT = 0.2;
const DEFAULT_ANTI_CHASE_LIMIT = 15;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function gateResult(status, observed, limit, reason, extra = {}) {
  return {
    status: status === 'PASS' ? 'PASS' : 'BLOCK',
    observed: finite(observed) ? observed : null,
    limit: finite(limit) ? limit : DEFAULT_RANGE_LIMIT,
    reason: String(reason || 'Gate blocked: observation unavailable'),
    ...extra
  };
}

function blocked(reason, limit, observed = null, extra = {}) {
  return gateResult('BLOCK', observed, limit, reason, extra);
}

function validCandle(candle) {
  return !!candle && typeof candle === 'object' &&
    finite(candle.high) && finite(candle.low) && finite(candle.close) &&
    candle.high >= candle.low && candle.close > 0;
}

function limitOrDefault(value, fallback, allowZero = true) {
  if (!finite(value) || (allowZero ? value < 0 : value <= 0)) return fallback;
  return value;
}

function withinLimit(observed, limit, label, unit = '') {
  // Treat harmless floating-point rounding at a stated boundary as equal.
  const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(limit));
  if (observed <= limit + tolerance) {
    return gateResult('PASS', observed, limit, `${label}: ${observed.toFixed(4)}${unit} is within limit ${limit}${unit}`);
  }
  return gateResult('BLOCK', observed, limit, `${label}: ${observed.toFixed(4)}${unit} exceeds limit ${limit}${unit}`);
}

/**
 * Is the latest 5m candle range no greater than limit × ATR?
 */
export function gateRangeATR(candles5m, atrValue, limit = DEFAULT_RANGE_LIMIT) {
  const effectiveLimit = limitOrDefault(limit, DEFAULT_RANGE_LIMIT);
  if (!Array.isArray(candles5m) || candles5m.length === 0) {
    return blocked('5m range gate blocked: candle data missing', effectiveLimit);
  }
  const last = candles5m[candles5m.length - 1];
  if (!validCandle(last)) {
    return blocked('5m range gate blocked: latest candle is invalid', effectiveLimit);
  }
  if (!finite(atrValue) || atrValue <= 0) {
    return blocked('5m range gate blocked: ATR is missing or non-positive', effectiveLimit);
  }
  const ratio = (last.high - last.low) / atrValue;
  if (!finite(ratio)) return blocked('5m range gate blocked: ratio is non-finite', effectiveLimit);
  return withinLimit(ratio, effectiveLimit, '5m candle range / ATR', ' ATR');
}

/**
 * Is current price within limit × ATR of EMA21?
 */
export function gateEMADistance(currentPrice, ema21Value, atrValue, limit = DEFAULT_EMA_DISTANCE_LIMIT) {
  const effectiveLimit = limitOrDefault(limit, DEFAULT_EMA_DISTANCE_LIMIT);
  if (!finite(currentPrice) || currentPrice <= 0) {
    return blocked('EMA21 distance gate blocked: current price missing or invalid', effectiveLimit);
  }
  if (!finite(ema21Value) || ema21Value <= 0) {
    return blocked('EMA21 distance gate blocked: EMA21 missing or invalid', effectiveLimit);
  }
  if (!finite(atrValue) || atrValue <= 0) {
    return blocked('EMA21 distance gate blocked: ATR missing or non-positive', effectiveLimit);
  }
  const ratio = Math.abs(currentPrice - ema21Value) / atrValue;
  if (!finite(ratio)) return blocked('EMA21 distance gate blocked: ratio is non-finite', effectiveLimit);
  return withinLimit(ratio, effectiveLimit, 'Price distance from EMA21 / ATR', ' ATR');
}

/**
 * Classify BTC using 1h candles and the existing worker EMA/ATR utilities.
 * At least 201 raw candles are required so EMA200 sees 200 closed candles
 * after the worker's current-candle exclusion. Missing data is BLOCKED.
 */
export function gateBTCRegime(btcCandles1h, btcPrice) {
  const limit = DEFAULT_BTC_ATR_LIMIT;
  if (!Array.isArray(btcCandles1h) || btcCandles1h.length < 201) {
    return blocked('BTC regime unavailable: need at least 201 1h candles; fail-closed', limit, null, {
      regime: 'UNAVAILABLE'
    });
  }
  if (!btcCandles1h.every(validCandle)) {
    return blocked('BTC regime unavailable: one or more 1h candles are invalid; fail-closed', limit, null, {
      regime: 'UNAVAILABLE'
    });
  }
  if (!finite(btcPrice) || btcPrice <= 0) {
    return blocked('BTC regime unavailable: current BTC price is missing or invalid; fail-closed', limit, null, {
      regime: 'UNAVAILABLE'
    });
  }

  const ema50 = workerEMA(btcCandles1h, 50);
  const ema200 = workerEMA(btcCandles1h, 200);
  const atr14 = workerATR(btcCandles1h, 14);
  if (![ema50, ema200, atr14].every(finite) || ema50 <= 0 || ema200 <= 0 || atr14 <= 0) {
    return blocked('BTC regime unavailable: EMA50, EMA200 or ATR14 could not be computed; fail-closed', limit, null, {
      regime: 'UNAVAILABLE'
    });
  }

  const atrPct = (atr14 / btcPrice) * 100;
  if (!finite(atrPct)) {
    return blocked('BTC regime unavailable: ATR percentage is non-finite; fail-closed', limit, null, {
      regime: 'UNAVAILABLE'
    });
  }

  // CHOPPY must be checked first; otherwise ATR > 4% is swallowed by the
  // broader high-volatility bull/bear cases and can never be classified.
  let regime;
  const emaDifference = ema50 - ema200;
  const flatTolerance = Math.max(1, Math.abs(ema50), Math.abs(ema200)) * 1e-12;
  if (atrPct > 4) {
    regime = 'CHOPPY';
  } else if (Math.abs(emaDifference) <= flatTolerance) {
    regime = 'NEUTRAL';
  } else if (emaDifference > 0) {
    regime = atrPct < 2 ? 'BULL_LOW_VOL' : 'BULL_HIGH_VOL';
  } else {
    regime = atrPct < 2 ? 'BEAR_LOW_VOL' : 'BEAR_HIGH_VOL';
  }

  const allowedRegimes = new Set(['BULL_LOW_VOL', 'BULL_HIGH_VOL', 'BEAR_LOW_VOL', 'BEAR_HIGH_VOL']);
  const isAllowed = allowedRegimes.has(regime);
  return gateResult(
    isAllowed ? 'PASS' : 'BLOCK',
    atrPct,
    limit,
    `BTC regime: ${regime} (ATR ${atrPct.toFixed(2)}%)`,
    { regime }
  );
}

/**
 * Check bid/ask spread as a percentage of the mid price.
 */
export function gateSpread(bid, ask, limit = DEFAULT_SPREAD_LIMIT) {
  const effectiveLimit = limitOrDefault(limit, DEFAULT_SPREAD_LIMIT);
  if (!finite(bid) || !finite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return blocked('Spread gate blocked: bid/ask data is missing or invalid', effectiveLimit);
  }
  const mid = (bid + ask) / 2;
  if (!finite(mid) || mid <= 0) return blocked('Spread gate blocked: mid price is invalid', effectiveLimit);
  const spreadPct = ((ask - bid) / mid) * 100;
  if (!finite(spreadPct)) return blocked('Spread gate blocked: spread percentage is non-finite', effectiveLimit);
  return withinLimit(spreadPct, effectiveLimit, 'Spread', '%');
}

/**
 * Check total round-trip fees and spread cost against the expected 1R move.
 */
export function gateFeeSpreadVs1R(expectedMove, roundTripFees, spreadCost, limit = DEFAULT_COST_LIMIT) {
  const effectiveLimit = limitOrDefault(limit, DEFAULT_COST_LIMIT);
  if (!finite(expectedMove) || expectedMove <= 0) {
    return blocked('Fee/spread gate blocked: expected 1R move is missing or non-positive', effectiveLimit);
  }
  if (!finite(roundTripFees) || roundTripFees < 0 || !finite(spreadCost) || spreadCost < 0) {
    return blocked('Fee/spread gate blocked: fee or spread-cost input is missing or invalid', effectiveLimit);
  }
  const costR = (roundTripFees + spreadCost) / expectedMove;
  if (!finite(costR)) return blocked('Fee/spread gate blocked: cost ratio is non-finite', effectiveLimit);
  return withinLimit(costR, effectiveLimit, 'Total fees + spread / 1R', ' R');
}

/**
 * Block entries after any one of the defined extended-move thresholds.
 * observed is the largest absolute percentage move. On a failure, limit
 * identifies the breached rule with the largest threshold-relative excess.
 */
export function gateAntiChase(change24h, change1h, change15m) {
  const rules = [
    { name: '24h', value: change24h, limit: 15 },
    { name: '1h', value: change1h, limit: 8 },
    { name: '15m', value: change15m, limit: 5 }
  ];
  if (!rules.every(rule => finite(rule.value))) {
    return blocked('Anti-chase gate blocked: one or more price-change observations are missing or invalid', 15);
  }

  const observed = Math.max(...rules.map(rule => Math.abs(rule.value)));
  const breached = rules
    .filter(rule => Math.abs(rule.value) > rule.limit)
    .sort((a, b) => (Math.abs(b.value) / b.limit) - (Math.abs(a.value) / a.limit));

  if (breached.length) {
    const worst = breached[0];
    return blocked(
      `Anti-chase gate blocked: absolute ${worst.name} move ${Math.abs(worst.value).toFixed(2)}% exceeds ${worst.limit}%`,
      worst.limit,
      observed
    );
  }
  return gateResult('PASS', observed, 15, `Anti-chase: all changes are within 24h 15%, 1h 8% and 15m 5% limits`);
}

/**
 * Convenience wrapper returning each independent gate. Expected-move and
 * cost inputs are explicit ticker fields; absent data fails closed.
 */
export function computeAllGates({ candles5m, candles1h, ticker = {}, atr5m, ema21 } = {}) {
  const safeTicker = ticker && typeof ticker === 'object' ? ticker : {};
  const strategy = String(safeTicker.strategy || safeTicker.engine || '').toUpperCase();
  const rangeLimit = strategy === 'MOMENTUM' ? 4 : 3;
  const emaLimit = strategy === 'MOMENTUM' ? 3.5 : 2.5;
  const bid = safeTicker.quotes?.best_bid ?? safeTicker.best_bid ?? safeTicker.bid;
  const ask = safeTicker.quotes?.best_ask ?? safeTicker.best_ask ?? safeTicker.ask;
  const currentPrice = safeTicker.mark_price ?? safeTicker.markPrice ?? safeTicker.close ?? safeTicker.price;
  const btcPrice = safeTicker.btcPrice ?? safeTicker.btc_price;
  const change24h = safeTicker.change24h ?? safeTicker.change_24h ?? safeTicker.ltp_change_24h;
  const change1h = safeTicker.change1h ?? safeTicker.change_1h;
  const change15m = safeTicker.change15m ?? safeTicker.change_15m;

  return {
    rangeATR: gateRangeATR(candles5m, atr5m, rangeLimit),
    emaDistance: gateEMADistance(currentPrice, ema21, atr5m, emaLimit),
    btcRegime: gateBTCRegime(candles1h, btcPrice),
    spread: gateSpread(bid, ask),
    feeSpreadVs1R: gateFeeSpreadVs1R(
      safeTicker.expectedMove,
      safeTicker.roundTripFees,
      safeTicker.spreadCost
    ),
    antiChase: gateAntiChase(change24h, change1h, change15m)
  };
}
