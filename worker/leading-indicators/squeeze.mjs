import { calculateBollingerBands } from '../../src/indicators/ta.mjs';
import { atr as calculateATR, ema } from '../strategy.mjs';

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;

function validSeries(candles) {
  return Array.isArray(candles) && candles.every(c => {
    const high = number(c?.high);
    const low = number(c?.low);
    const close = number(c?.close);
    return high !== null && low !== null && close !== null &&
      high > 0 && low > 0 && close > 0 && high >= low;
  });
}

function closesOf(candles) {
  return candles.map(c => Number(c.close));
}

function bandsForCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  return calculateBollingerBands(closesOf(candles).slice(-20), 20, 2);
}

/**
 * A squeeze is present when the latest Bollinger bandwidth is below 60% of
 * its 20-observation average. Each observation is itself a 20-close BB window.
 * Twenty bandwidth observations therefore require 39 candles.
 */
export function detectBollingerSqueeze(candles) {
  if (!validSeries(candles) || candles.length < 20) {
    return { squeezed: false, bandwidth: null, avgBandwidth: null, bandwidthRatio: null };
  }

  const closes = closesOf(candles);
  const latest = calculateBollingerBands(closes.slice(-20), 20, 2);
  const bandwidth = latest.middle > 0 ? (latest.upper - latest.lower) / latest.middle : null;
  if (bandwidth === null || !Number.isFinite(bandwidth)) {
    return { squeezed: false, bandwidth: null, avgBandwidth: null, bandwidthRatio: null };
  }

  if (candles.length < 39) {
    return { squeezed: false, bandwidth, avgBandwidth: null, bandwidthRatio: null };
  }

  const widths = [];
  const firstEnd = candles.length - 20;
  for (let end = firstEnd; end < candles.length; end++) {
    const window = closes.slice(end - 19, end + 1);
    const bands = calculateBollingerBands(window, 20, 2);
    if (bands.middle <= 0) {
      return { squeezed: false, bandwidth, avgBandwidth: null, bandwidthRatio: null };
    }
    widths.push((bands.upper - bands.lower) / bands.middle);
  }

  const avgBandwidth = widths.reduce((sum, value) => sum + value, 0) / widths.length;
  const bandwidthRatio = avgBandwidth > 0
    ? bandwidth / avgBandwidth
    : bandwidth === 0 ? 0 : Number.POSITIVE_INFINITY;

  return {
    squeezed: bandwidthRatio < 0.6,
    bandwidth,
    avgBandwidth,
    bandwidthRatio
  };
}

/**
 * Compare the latest 14-period ATR with the mean of the latest 20 ATR readings.
 * The worker's existing atr() convention excludes the final, possibly-forming
 * candle. Thirty-five raw candles are needed for 20 valid ATR observations.
 */
export function detectATRCompression(candles) {
  if (!validSeries(candles) || candles.length < 16) {
    return { compressed: false, currentATR: 0, avgATR: null, ratio: null };
  }

  const currentATR = calculateATR(candles, 14);
  if (!Number.isFinite(currentATR) || currentATR <= 0 || candles.length < 35) {
    return { compressed: false, currentATR: Math.max(0, Number(currentATR) || 0), avgATR: null, ratio: null };
  }

  const values = [];
  for (let end = candles.length - 19; end <= candles.length; end++) {
    const value = calculateATR(candles.slice(0, end), 14);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  if (values.length !== 20) {
    return { compressed: false, currentATR, avgATR: null, ratio: null };
  }

  const avgATR = values.reduce((sum, value) => sum + value, 0) / values.length;
  const ratio = avgATR > 0 ? currentATR / avgATR : null;
  return { compressed: ratio !== null && ratio < 0.6, currentATR, avgATR, ratio };
}

/**
 * TTM squeeze: both Bollinger bands fit inside the EMA20 ± 2×ATR Keltner
 * channel. Widths are also returned for diagnostics.
 */
export function detectKeltnerSqueeze(candles) {
  if (!validSeries(candles) || candles.length < 20) {
    return { ttmSqueeze: false, bbWidth: null, kcWidth: null };
  }

  const bb = bandsForCandles(candles);
  const center = ema(candles, 20);
  const currentATR = calculateATR(candles, 14);
  if (!bb || !Number.isFinite(center) || center <= 0 ||
      !Number.isFinite(currentATR) || currentATR <= 0) {
    return { ttmSqueeze: false, bbWidth: null, kcWidth: null };
  }

  const kcWidth = 4 * currentATR;
  const kcUpper = center + 2 * currentATR;
  const kcLower = center - 2 * currentATR;
  const bbWidth = bb.upper - bb.lower;
  return {
    ttmSqueeze: bb.upper < kcUpper && bb.lower > kcLower,
    bbWidth,
    kcWidth
  };
}

export function detectTightRange(candles, lookback = 10) {
  if (!Number.isInteger(lookback) || lookback < 2) {
    throw new RangeError('Tight range lookback must be an integer >= 2');
  }
  if (!validSeries(candles) || candles.length < lookback) {
    return { tight: false, rangePct: null };
  }

  const recent = candles.slice(-lookback);
  const high = Math.max(...recent.map(c => Number(c.high)));
  const low = Math.min(...recent.map(c => Number(c.low)));
  const price = Number(recent.at(-1).close);
  const rangePct = price > 0 ? ((high - low) / price) * 100 : null;
  return { tight: rangePct !== null && rangePct < 2.5, rangePct };
}

export function detectInsideBars(candles, lookback = 3) {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new RangeError('Inside-bar lookback must be a positive integer');
  }
  if (!validSeries(candles) || candles.length < 2) {
    return { insideBarCount: 0, isCompression: false };
  }

  let insideBarCount = 0;
  const first = Math.max(1, candles.length - lookback);
  for (let index = candles.length - 1; index >= first; index--) {
    const current = candles[index];
    const previous = candles[index - 1];
    if (Number(current.high) <= Number(previous.high) &&
        Number(current.low) >= Number(previous.low)) {
      insideBarCount++;
    } else {
      break;
    }
  }

  return { insideBarCount, isCompression: insideBarCount >= 2 };
}

export function detectSqueezeSetup(candles) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { squeezeScore: 0, isSqueeze: false, reason: 'insufficient_data' };
  }

  const bb = detectBollingerSqueeze(candles);
  const atr = detectATRCompression(candles);
  const kc = detectKeltnerSqueeze(candles);
  const tight = detectTightRange(candles);
  const inside = detectInsideBars(candles);

  const squeezeScore =
    (bb.squeezed ? 35 : 0) +
    (atr.compressed ? 30 : 0) +
    (kc.ttmSqueeze ? 20 : 0) +
    (tight.tight ? 10 : 0) +
    (inside.isCompression ? 5 : 0);

  return {
    squeezeScore,
    isSqueeze: squeezeScore >= 60,
    indicators: { bb, atr, kc, tight, inside }
  };
}
