import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNormalizedScore, calculateNormalizedScores } from '../worker/strategy.mjs';

function row(symbol, rsi, trend, volumeSpike, emaDistanceAtr, side = 'BUY') {
  return { symbol, side, rsi, trend, volumeSpike, emaDistanceAtr };
}

test('outlier symbol scores above 90 while weaker signals rank lower on the sigmoid scale', () => {
  const universe = [
    row('OUTLIERUSD', 92, 'BULL', 5, 0.1),
    row('WEAK01USD', 22, 'BEAR', 0.1, 4.8),
    row('WEAK02USD', 25, 'BEAR', 0.2, 4.5),
    row('WEAK03USD', 28, 'BEAR', 0.3, 4.2),
    row('WEAK04USD', 31, 'BEAR', 0.4, 3.9),
    row('WEAK05USD', 34, 'BEAR', 0.5, 3.6),
    row('WEAK06USD', 37, 'BEAR', 0.6, 3.3),
    row('WEAK07USD', 40, 'BEAR', 0.7, 3.0),
    row('WEAK08USD', 43, 'BEAR', 0.8, 2.7),
    row('WEAK09USD', 46, 'BEAR', 0.9, 2.4)
  ];
  const high = calculateNormalizedScore('OUTLIERUSD', universe);
  const low = calculateNormalizedScore('WEAK01USD', universe);
  const batch = calculateNormalizedScores(universe);
  assert.equal(batch.get('OUTLIERUSD'), high);
  assert.ok(high > 90, 'cross-sectional outlier should exceed 90');
  assert.ok(low < 50, 'weak signal should remain below neutral');
  for (const score of batch.values()) assert.ok(score >= 0 && score <= 100);
});

test('direction-aligned features reward a bearish trend for SELL and invert SELL RSI', () => {
  const universe = [
    row('BUYUSD', 65, 'BULL', 1.5, 0.5, 'BUY'),
    row('SELLUSD', 35, 'BEAR', 1.5, 0.5, 'SELL'),
    row('WEAKUSD', 65, 'BEAR', 1.5, 2.0, 'BUY')
  ];
  const buy = calculateNormalizedScore('BUYUSD', universe);
  const sell = calculateNormalizedScore('SELLUSD', universe);
  const weak = calculateNormalizedScore('WEAKUSD', universe);
  assert.ok(buy > weak);
  assert.ok(sell > weak);
});

test('constant components use z-score zero and return a neutral score', () => {
  const universe = [
    row('AAAUSD', 50, 'BULL', 1, 1),
    row('BBBUSD', 50, 'BULL', 1, 1),
    row('CCCUSD', 50, 'BULL', 1, 1)
  ];
  assert.equal(calculateNormalizedScore('AAAUSD', universe), 50);
  assert.equal(
    calculateNormalizedScore('AAAUSD', [...universe].reverse()),
    calculateNormalizedScore('AAAUSD', universe)
  );
});

test('missing target, no universe, non-directional signals, and incomplete features return null', () => {
  const universe = [
    row('AAAUSD', 55, 'BULL', 1, 1),
    row('BBBUSD', 45, 'BEAR', 1.2, 0.8)
  ];
  assert.equal(calculateNormalizedScore('NOTFOUNDUSD', universe), null);
  assert.equal(calculateNormalizedScore('AAAUSD', []), null);
  assert.equal(calculateNormalizedScore('AAAUSD', [
    row('AAAUSD', 55, 'BULL', 1, 1, ''),
    row('BBBUSD', 45, 'BEAR', 1.2, 0.8, '')
  ]), null);
  assert.equal(calculateNormalizedScore('AAAUSD', [
    row('AAAUSD', 55, 'BULL', null, 1),
    row('BBBUSD', 45, 'BEAR', 1.2, 0.8)
  ]), null);
});

test('uniform universe scores approximately 50 and sigmoid output remains bounded', () => {
  const universe = Array.from({ length: 6 }, (_, index) =>
    row('UNIFORM' + index + 'USD', 50, 'BULL', 1.25, 1.0)
  );
  for (const item of universe) {
    const score = calculateNormalizedScore(item.symbol, universe);
    assert.ok(Math.abs(score - 50) <= 0.01);
    assert.ok(score >= 0 && score <= 100);
  }
});

test('missing universe and missing target return null rather than fabricating scores', () => {
  assert.equal(calculateNormalizedScore('AAAUSD', null), null);
  assert.equal(calculateNormalizedScore('AAAUSD', undefined), null);
  assert.equal(calculateNormalizedScore('UNKNOWNUSD', [
    row('AAAUSD', 55, 'BULL', 1, 1),
    row('BBBUSD', 45, 'BEAR', 1.2, 0.8)
  ]), null);
});
