import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNormalizedScore, calculateNormalizedScores } from '../worker/strategy.mjs';

function row(symbol, rsi, trend, volumeSpike, emaDistanceAtr, side = 'BUY') {
  return { symbol, side, rsi, trend, volumeSpike, emaDistanceAtr };
}

test('normalized score ranks the cross-sectional feature combination on a 0-100 sigmoid scale', () => {
  const universe = [
    row('AAAUSD', 60, 'BULL', 2, 0.5),
    row('BBBUSD', 50, 'FLAT', 1, 1.5),
    row('CCCUSD', 40, 'BEAR', 0, 2.5)
  ];
  const high = calculateNormalizedScore('AAAUSD', universe);
  const middle = calculateNormalizedScore('BBBUSD', universe);
  const low = calculateNormalizedScore('CCCUSD', universe);
  const batch = calculateNormalizedScores(universe);
  assert.equal(batch.get('AAAUSD'), high);
  assert.equal(batch.get('BBBUSD'), middle);
  assert.equal(batch.get('CCCUSD'), low);

  assert.ok(high > 80, 'supportive feature combination should rank above 80');
  assert.equal(middle, 50);
  assert.ok(low < 20, 'opposed feature combination should rank below 20');
  for (const score of [high, middle, low]) assert.ok(score >= 0 && score <= 100);
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
