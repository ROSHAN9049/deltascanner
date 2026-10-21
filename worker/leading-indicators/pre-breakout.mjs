import { atr as calculateATR } from '../strategy.mjs';
import { detectSqueezeSetup } from './squeeze.mjs';
import { detectAccumulation } from './accumulation.mjs';

export function detectPreBreakout(symbol, candles) {
  const squeeze = detectSqueezeSetup(candles);
  const accum = detectAccumulation(candles);

  if (!squeeze.isSqueeze || !accum.isAccumulating) {
    return { signal: null, reason: 'no_setup' };
  }

  const recent = candles.slice(-20);
  const rangeHigh = Math.max(...recent.map(c => Number(c.high)));
  const rangeLow = Math.min(...recent.map(c => Number(c.low)));
  const atrValue = calculateATR(candles, 14);

  if (!Number.isFinite(atrValue) || atrValue <= 0 ||
      !Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) ||
      rangeLow <= 0 || rangeHigh <= rangeLow) {
    return { signal: null, reason: 'invalid_risk_inputs' };
  }

  // Per the approved Phase 2A spec, a bullish OBV accumulation divergence
  // points UP; otherwise the combined setup's direction defaults to DOWN.
  const direction = accum.indicators.obvDiv.divergence === 'accumulation' ? 'UP' : 'DOWN';
  const entryPrice = direction === 'UP'
    ? rangeHigh * 1.001
    : rangeLow * 0.999;
  const stopLoss = direction === 'UP'
    ? entryPrice - (2 * atrValue)
    : entryPrice + (2 * atrValue);
  const tp1 = direction === 'UP'
    ? entryPrice + (3 * atrValue)
    : entryPrice - (3 * atrValue);
  const tp2 = direction === 'UP'
    ? entryPrice + (5 * atrValue)
    : entryPrice - (5 * atrValue);
  const confidenceScore = (squeeze.squeezeScore * 0.5) + (accum.accumulationScore * 0.5);
  const risk = Math.abs(entryPrice - stopLoss);
  const riskReward = risk > 0 ? Math.abs(tp1 - entryPrice) / risk : 0;

  return {
    signal: {
      symbol,
      type: 'PRE_BREAKOUT',
      direction,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      confidenceScore,
      rangeHigh,
      rangeLow,
      squeezeScore: squeeze.squeezeScore,
      accumulationScore: accum.accumulationScore,
      indicators: { squeeze, accum },
      riskReward
    },
    reason: 'setup_detected'
  };
}
