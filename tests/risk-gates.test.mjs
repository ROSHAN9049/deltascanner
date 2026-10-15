import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateRangeATR,
  gateEMADistance,
  gateBTCRegime,
  gateSpread,
  gateFeeSpreadVs1R,
  gateAntiChase,
  computeAllGates
} from '../src/indicators/risk-gates.mjs';

const assertGate = (result, status) => {
  assert.strictEqual(result.status, status);
  assert.ok(Number.isFinite(result.limit), 'every gate must have a numeric limit');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  assert.notStrictEqual(result.status, 'UNKNOWN');
};
const near = (actual, expected, epsilon = 1e-7) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};
const candle = (high, low, close = (high + low) / 2, time = 0) => ({ time, high, low, close });
const askForSpreadPct = (bid, spreadPct) => bid * (2 + spreadPct / 100) / (2 - spreadPct / 100);

function makeRegimeCandles(direction, rangeWidth, count = 220) {
  return Array.from({ length: count }, (_, index) => {
    const close = 1000 + direction * index * 0.25;
    return {
      time: index,
      open: close - direction * 0.1,
      high: close + rangeWidth / 2,
      low: close - rangeWidth / 2,
      close,
      volume: 1000 + index * 2
    };
  });
}

describe('gateRangeATR', () => {
  test('passes when the latest candle range is below the limit', () => {
    const result = gateRangeATR([candle(103, 97)], 2, 3);
    assertGate(result, 'PASS');
    near(result.observed, 3);
  });

  test('blocks when the latest candle range exceeds the limit', () => {
    const result = gateRangeATR([candle(104, 96)], 2, 3);
    assertGate(result, 'BLOCK');
    near(result.observed, 4);
  });

  test('passes exactly at the limit', () => {
    assertGate(gateRangeATR([candle(103, 97)], 2, 3), 'PASS');
  });

  test('blocks missing candles and invalid ATR instead of returning UNKNOWN', () => {
    assertGate(gateRangeATR([], 2), 'BLOCK');
    assertGate(gateRangeATR([candle(10, 8)], NaN), 'BLOCK');
  });
});

describe('gateEMADistance', () => {
  test('passes when price is within the ATR-distance limit', () => {
    const result = gateEMADistance(104, 100, 2, 2.5);
    assertGate(result, 'PASS');
    near(result.observed, 2);
  });

  test('blocks when price is too far from EMA21', () => {
    const result = gateEMADistance(106, 100, 2, 2.5);
    assertGate(result, 'BLOCK');
    near(result.observed, 3);
  });

  test('passes exactly at the distance limit', () => {
    assertGate(gateEMADistance(105, 100, 2, 2.5), 'PASS');
  });

  test('blocks missing price, EMA or ATR', () => {
    assertGate(gateEMADistance(null, 100, 2), 'BLOCK');
    assertGate(gateEMADistance(100, NaN, 2), 'BLOCK');
    assertGate(gateEMADistance(100, 100, 0), 'BLOCK');
  });
});

describe('gateBTCRegime', () => {
  test('classifies BULL_LOW_VOL', () => {
    const result = gateBTCRegime(makeRegimeCandles(1, 1), 1000);
    assertGate(result, 'PASS');
    assert.strictEqual(result.regime, 'BULL_LOW_VOL');
    assert.ok(result.observed < 2);
  });

  test('classifies BULL_HIGH_VOL', () => {
    const result = gateBTCRegime(makeRegimeCandles(1, 25), 1000);
    assertGate(result, 'PASS');
    assert.strictEqual(result.regime, 'BULL_HIGH_VOL');
    assert.ok(result.observed >= 2 && result.observed <= 4);
  });

  test('classifies BEAR_LOW_VOL', () => {
    const result = gateBTCRegime(makeRegimeCandles(-1, 1), 1000);
    assertGate(result, 'PASS');
    assert.strictEqual(result.regime, 'BEAR_LOW_VOL');
  });

  test('classifies BEAR_HIGH_VOL', () => {
    const result = gateBTCRegime(makeRegimeCandles(-1, 25), 1000);
    assertGate(result, 'PASS');
    assert.strictEqual(result.regime, 'BEAR_HIGH_VOL');
  });

  test('classifies CHOPPY first when ATR exceeds 4%', () => {
    const result = gateBTCRegime(makeRegimeCandles(1, 50), 1000);
    assertGate(result, 'BLOCK');
    assert.strictEqual(result.regime, 'CHOPPY');
    assert.ok(result.observed > 4);
  });

  test('classifies a flat EMA regime as NEUTRAL and blocks', () => {
    const result = gateBTCRegime(makeRegimeCandles(0, 1), 1000);
    assertGate(result, 'BLOCK');
    assert.strictEqual(result.regime, 'NEUTRAL');
  });

  test('blocks insufficient 1h history, invalid candles and missing BTC price', () => {
    assertGate(gateBTCRegime(makeRegimeCandles(1, 1).slice(0, 100), 1000), 'BLOCK');
    assert.strictEqual(gateBTCRegime(makeRegimeCandles(1, 1).slice(0, 100), 1000).regime, 'UNAVAILABLE');
    const invalid = makeRegimeCandles(1, 1);
    invalid[10].close = NaN;
    assertGate(gateBTCRegime(invalid, 1000), 'BLOCK');
    assertGate(gateBTCRegime(makeRegimeCandles(1, 1), undefined), 'BLOCK');
  });
});

describe('gateSpread', () => {
  test('passes an acceptable spread', () => {
    assertGate(gateSpread(100, 100.2), 'PASS');
  });

  test('blocks a spread above the limit', () => {
    assertGate(gateSpread(100, askForSpreadPct(100, 0.5)), 'BLOCK');
  });

  test('passes exactly at the spread limit', () => {
    const result = gateSpread(100, askForSpreadPct(100, 0.35));
    assertGate(result, 'PASS');
    near(result.observed, 0.35);
  });

  test('blocks missing, inverted or invalid bid/ask', () => {
    assertGate(gateSpread(undefined, 100), 'BLOCK');
    assertGate(gateSpread(101, 100), 'BLOCK');
    assertGate(gateSpread(0, 100), 'BLOCK');
  });
});

describe('gateFeeSpreadVs1R', () => {
  test('passes when costs are less than the allowed portion of 1R', () => {
    assertGate(gateFeeSpreadVs1R(100, 5, 5, 0.2), 'PASS');
  });

  test('blocks when combined costs exceed the allowed portion of 1R', () => {
    assertGate(gateFeeSpreadVs1R(100, 12, 10, 0.2), 'BLOCK');
  });

  test('passes exactly at the cost limit', () => {
    const result = gateFeeSpreadVs1R(100, 10, 10, 0.2);
    assertGate(result, 'PASS');
    near(result.observed, 0.2);
  });

  test('blocks missing expected move, fees or spread cost', () => {
    assertGate(gateFeeSpreadVs1R(0, 1, 1), 'BLOCK');
    assertGate(gateFeeSpreadVs1R(100, undefined, 1), 'BLOCK');
    assertGate(gateFeeSpreadVs1R(100, 1, NaN), 'BLOCK');
  });
});

describe('gateAntiChase', () => {
  test('passes when all three moves are inside their thresholds', () => {
    const result = gateAntiChase(14, 7, 4);
    assertGate(result, 'PASS');
    assert.strictEqual(result.observed, 14);
  });

  test('blocks an extended 24h move', () => {
    const result = gateAntiChase(15.1, 1, 1);
    assertGate(result, 'BLOCK');
    assert.strictEqual(result.limit, 15);
  });

  test('blocks an extended 1h move', () => {
    const result = gateAntiChase(1, -8.1, 1);
    assertGate(result, 'BLOCK');
    assert.strictEqual(result.limit, 8);
  });

  test('blocks an extended 15m move', () => {
    const result = gateAntiChase(1, 1, 5.1);
    assertGate(result, 'BLOCK');
    assert.strictEqual(result.limit, 5);
  });

  test('passes exactly at all three thresholds', () => {
    assertGate(gateAntiChase(15, -8, 5), 'PASS');
  });

  test('blocks missing or invalid change observations', () => {
    assertGate(gateAntiChase(1, undefined, 1), 'BLOCK');
    assertGate(gateAntiChase(1, NaN, 1), 'BLOCK');
  });
});

describe('computeAllGates', () => {
  test('returns all gate results and uses strategy-specific range/EMA limits', () => {
    const candles5m = [candle(103, 97)];
    const candles1h = makeRegimeCandles(1, 1);
    const result = computeAllGates({
      candles5m,
      candles1h,
      ticker: {
        strategy: 'MOMENTUM',
        mark_price: 104,
        btcPrice: 1000,
        quotes: { best_bid: 100, best_ask: 100.2 },
        expectedMove: 100,
        roundTripFees: 5,
        spreadCost: 5,
        change24h: 1,
        change1h: 1,
        change15m: 1
      },
      atr5m: 2,
      ema21: 100
    });
    assert.deepStrictEqual(Object.keys(result), ['rangeATR', 'emaDistance', 'btcRegime', 'spread', 'feeSpreadVs1R', 'antiChase']);
    assert.strictEqual(result.rangeATR.limit, 4);
    assert.strictEqual(result.emaDistance.limit, 3.5);
    assert.ok(Object.values(result).every(gate => ['PASS', 'BLOCK'].includes(gate.status)));
  });
});
