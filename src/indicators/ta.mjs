/**
 * Additional pure technical-analysis utilities for the Delta scanner.
 *
 * WHY THIS MODULE EXISTS: MACD, Bollinger Bands, z-scores and descriptive
 * statistics are not provided by the existing worker/strategy.mjs utilities.
 *
 * WHY THIS MODULE DOES NOT REIMPLEMENT EMA, ATR, RSI, VWAP OR VOLUME RATIO:
 * those functions already live in worker/strategy.mjs and remain the
 * existing strategy implementation. Keep this module focused on the new
 * calculations; the private EMA-series helper below exists only because
 * MACD needs a time-aligned EMA series rather than the worker's candle API.
 *
 * All exported functions are pure: no network calls, database access,
 * mutation, logging or other side effects. Input price arrays and candle
 * arrays must be ordered oldest to newest. Inputs are validated; invalid
 * values throw rather than silently producing NaN.
 */

/**
 * Return the EMA series for a MACD calculation, seeded by an SMA.
 * The first result is aligned to the original series at index period - 1.
 * This private helper does not replace the worker's existing public EMA.
 */
function macdEmaSeries(prices, period, label) {
  if (!Array.isArray(prices)) throw new TypeError(`${label}: prices must be an array`);
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${label}: period must be a positive integer`);
  }
  if (prices.length < period) {
    throw new Error(`${label}: insufficient prices for EMA`);
  }
  for (let i = 0; i < prices.length; i++) {
    if (typeof prices[i] !== 'number' || !Number.isFinite(prices[i])) {
      throw new TypeError(`${label}: price at index ${i} must be a finite number`);
    }
  }

  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  const result = Array(period - 1).fill(null);
  result.push(ema);

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    if (!Number.isFinite(ema)) throw new Error(`${label}: EMA calculation became non-finite`);
    result.push(ema);
  }
  return result;
}

function validatePriceSeries(prices, period, label) {
  if (!Array.isArray(prices)) throw new TypeError(`${label}: prices must be an array`);
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${label}: period must be a positive integer`);
  }
  if (prices.length < period) {
    throw new Error(`${label}: insufficient prices`);
  }
  for (let i = 0; i < prices.length; i++) {
    if (typeof prices[i] !== 'number' || !Number.isFinite(prices[i])) {
      throw new TypeError(`${label}: price at index ${i} must be a finite number`);
    }
  }
}

/**
 * Calculate the latest MACD, signal line and histogram.
 * EMA lines use an SMA seed; the signal EMA is calculated from the available
 * MACD line beginning at the first slow-EMA observation.
 */
export function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(prices)) throw new TypeError('MACD: prices must be an array');
  for (const [name, value] of [['fast', fast], ['slow', slow], ['signal', signal]]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`MACD: ${name} period must be a positive integer`);
    }
  }
  if (fast >= slow) throw new RangeError('MACD: fast period must be less than slow period');
  const minimum = slow + signal - 1;
  if (prices.length < minimum) {
    throw new Error(`Insufficient prices for MACD (need at least ${minimum})`);
  }
  for (let i = 0; i < prices.length; i++) {
    if (typeof prices[i] !== 'number' || !Number.isFinite(prices[i])) {
      throw new TypeError(`MACD: price at index ${i} must be a finite number`);
    }
  }

  const fastEma = macdEmaSeries(prices, fast, 'MACD fast EMA');
  const slowEma = macdEmaSeries(prices, slow, 'MACD slow EMA');
  const macdLine = [];
  for (let i = slow - 1; i < prices.length; i++) {
    const value = fastEma[i] - slowEma[i];
    if (!Number.isFinite(value)) throw new Error('MACD: line calculation became non-finite');
    macdLine.push(value);
  }
  const signalLine = macdEmaSeries(macdLine, signal, 'MACD signal EMA');
  const macd = macdLine.at(-1);
  const signalValue = signalLine.at(-1);
  const histogram = macd - signalValue;
  if (![macd, signalValue, histogram].every(Number.isFinite)) {
    throw new Error('MACD: result is non-finite');
  }
  return { macd, signal: signalValue, histogram };
}

/**
 * Calculate population-standard-deviation Bollinger Bands from the final
 * period prices. Returns { upper, middle, lower }.
 */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  validatePriceSeries(prices, period, 'Bollinger Bands');
  if (typeof stdDev !== 'number' || !Number.isFinite(stdDev) || stdDev < 0) {
    throw new RangeError('Bollinger Bands: stdDev must be a finite non-negative number');
  }

  const window = prices.slice(-period);
  const middle = window.reduce((sum, value) => sum + value, 0) / period;
  const variance = window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  const result = {
    upper: middle + stdDev * deviation,
    middle,
    lower: middle - stdDev * deviation
  };
  if (!Object.values(result).every(Number.isFinite)) {
    throw new Error('Bollinger Bands: result is non-finite');
  }
  return result;
}

/**
 * Return the z-score for a finite observation. A zero standard deviation
 * returns 0 because there is no meaningful distance from a constant sample.
 */
export function calculateZScore(value, mean, stddev) {
  for (const [name, number] of [['value', value], ['mean', mean], ['stddev', stddev]]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new TypeError(`Z-score: ${name} must be a finite number`);
    }
  }
  if (stddev < 0) throw new RangeError('Z-score: stddev must not be negative');
  if (stddev === 0) return 0;
  const result = (value - mean) / stddev;
  if (!Number.isFinite(result)) throw new Error('Z-score result is non-finite');
  return result;
}

/**
 * Compute descriptive statistics using population standard deviation.
 * NaN entries are ignored. Non-number and infinite values are rejected.
 * An empty array, or an array containing only NaN, throws an Error.
 */
export function computeStats(values) {
  if (!Array.isArray(values)) throw new TypeError('Statistics: values must be an array');
  const valid = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Statistics: value at index ${i} must be a finite number or NaN`);
    }
    valid.push(value);
  }
  if (valid.length === 0) throw new Error('Statistics: no finite values to summarize');

  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length;
  const result = {
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...valid),
    max: Math.max(...valid),
    count: valid.length
  };
  if (![result.mean, result.stddev, result.min, result.max].every(Number.isFinite)) {
    throw new Error('Statistics calculation became non-finite');
  }
  return result;
}
