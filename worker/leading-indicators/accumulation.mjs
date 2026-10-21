function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function usableCandles(candles) {
  return Array.isArray(candles) && candles.every(c => {
    const high = numeric(c?.high);
    const low = numeric(c?.low);
    const close = numeric(c?.close);
    const volume = numeric(c?.volume ?? 0);
    return high !== null && low !== null && close !== null && volume !== null &&
      high > 0 && low > 0 && close > 0 && high >= low && volume >= 0;
  });
}

export function calculateOBV(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  if (!usableCandles(candles)) return [];

  const obv = [0];
  let running = 0;
  for (let index = 1; index < candles.length; index++) {
    const close = Number(candles[index].close);
    const previousClose = Number(candles[index - 1].close);
    const volume = Number(candles[index].volume ?? 0);
    if (close > previousClose) running += volume;
    else if (close < previousClose) running -= volume;
    obv.push(running);
  }
  return obv;
}

/**
 * Compare price and OBV direction over the last lookback candles.
 * OBV change is normalized by total volume in that window to avoid dependence
 * on the arbitrary starting level of a running OBV series.
 */
export function detectOBVDivergence(candles, lookback = 20) {
  if (!Number.isInteger(lookback) || lookback < 2) {
    throw new RangeError('OBV lookback must be an integer >= 2');
  }
  if (!usableCandles(candles) || candles.length < lookback + 1) {
    return { divergence: 'none', priceChangePct: 0, obvChangePct: 0, strength: 0 };
  }

  const window = candles.slice(-lookback);
  const firstClose = Number(window[0].close);
  const lastClose = Number(window.at(-1).close);
  const priceChangePct = ((lastClose - firstClose) / firstClose) * 100;
  const obv = calculateOBV(candles);
  const obvChange = obv.at(-1) - obv.at(-lookback);
  const totalVolume = window.reduce((sum, candle) => sum + Number(candle.volume ?? 0), 0);
  const obvChangePct = totalVolume > 0 ? (obvChange / totalVolume) * 100 : 0;

  let divergence = 'none';
  if (priceChangePct <= 0.5 && obvChange > 0) divergence = 'accumulation';
  else if (priceChangePct > 0.5 && obvChange < 0) divergence = 'distribution';

  const strength = divergence === 'none'
    ? 0
    : Math.min(100, Math.abs(obvChangePct) * 0.75 + Math.abs(priceChangePct) * 10);

  return { divergence, priceChangePct, obvChangePct, strength };
}

export function calculateCMF(candles, period = 20) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('CMF period must be a positive integer');
  }
  if (!usableCandles(candles) || candles.length < period) return { cmf: 0 };

  let moneyFlowVolume = 0;
  let volumeSum = 0;
  for (const candle of candles.slice(-period)) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume ?? 0);
    const range = high - low;
    const multiplier = range > 0
      ? ((close - low) - (high - close)) / range
      : 0;
    moneyFlowVolume += multiplier * volume;
    volumeSum += volume;
  }

  const cmf = volumeSum > 0 ? moneyFlowVolume / volumeSum : 0;
  return { cmf: Number.isFinite(cmf) ? cmf : 0 };
}

export function detectVolumeAccumulation(candles, lookback = 10) {
  if (!Number.isInteger(lookback) || lookback < 4) {
    throw new RangeError('Volume lookback must be an integer >= 4');
  }
  if (!usableCandles(candles) || candles.length < lookback) {
    return { pattern: 'none', volumeTrend: 'unknown', priceTrend: 'unknown' };
  }

  const window = candles.slice(-lookback);
  const middle = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, middle);
  const secondHalf = window.slice(middle);
  const meanVolume = rows => rows.reduce((sum, candle) => sum + Number(candle.volume ?? 0), 0) / rows.length;
  const firstVolume = meanVolume(firstHalf);
  const secondVolume = meanVolume(secondHalf);
  let volumeTrend = 'flat';
  if (secondVolume > firstVolume * 1.05) volumeTrend = 'rising';
  else if (secondVolume < firstVolume * 0.95) volumeTrend = 'falling';

  const firstClose = Number(window[0].close);
  const lastClose = Number(window.at(-1).close);
  const priceChangePct = ((lastClose - firstClose) / firstClose) * 100;
  let priceTrend = 'flat';
  if (priceChangePct > 0.5) priceTrend = 'rising';
  else if (priceChangePct < -0.5) priceTrend = 'falling';

  let pattern = 'none';
  if (volumeTrend === 'rising' && priceTrend === 'flat') pattern = 'accumulation';
  else if (volumeTrend === 'falling' && priceTrend === 'falling') pattern = 'capitulation';

  return { pattern, volumeTrend, priceTrend };
}

export function detectAccumulation(candles) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { accumulationScore: 0, isAccumulating: false };
  }
  if (!usableCandles(candles)) {
    return { accumulationScore: 0, isAccumulating: false };
  }

  const obvDiv = detectOBVDivergence(candles);
  const cmf = calculateCMF(candles);
  const volAccum = detectVolumeAccumulation(candles);

  const accumulationScore =
    (obvDiv.divergence === 'accumulation' ? 40 : 0) +
    (cmf.cmf > 0.15 ? 30 : 0) +
    (cmf.cmf > 0.05 && cmf.cmf <= 0.15 ? 15 : 0) +
    (volAccum.pattern === 'accumulation' ? 30 : 0);

  return {
    accumulationScore,
    isAccumulating: accumulationScore >= 60,
    indicators: { obvDiv, cmf, volAccum }
  };
}
