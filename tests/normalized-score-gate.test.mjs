// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/normalized-score-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../worker/strategy.mjs';
import { DeltaEngine } from '../worker/engine.mjs';

function candles() {
  return Array.from({ length: 100 }, (_, i) => {
    const close = 100 + i * 0.1 + 0.9 * Math.sin((i - 98) * 0.5);
    return {
      time: 1_790_000_000_000 + i * 60_000,
      open: close - 0.05,
      high: close + 0.15,
      low: close - 0.15,
      close,
      volume: 10
    };
  });
}
function analyseAt(normalizedScore, strategy = 'MOMENTUM') {
  const series = candles();
  const price = series[98].close;
  const ticker = {
    symbol: 'TESTUSD', mark_price: price, close: price, ltp_change_24h: 0,
    turnover_usd: 100_000, quotes: { best_bid: price - 0.01, best_ask: price + 0.01 }
  };
  const product = {
    id: 1, tick_size: 0.01, taker_commission_rate: 0.0001,
    maker_commission_rate: 0.0001, contract_value: 1,
    notional_type: 'vanilla', max_leverage_notional: 1_000_000
  };
  return analyse(ticker, product, series, series, series, series, series, strategy, {
    normalizedScore, volumeMin: 0.75, antiChasePct: 15,
    rangeAtrMax: strategy === 'SCALPING' ? 3 : 4,
    emaDistanceMax: strategy === 'SCALPING' ? 2.5 : 3.5,
    spreadMaxPct: 0.35, costGateRatio: strategy === 'SCALPING' ? 0.25 : 0.2,
    minStopPct: strategy === 'SCALPING' ? 0.75 : 0.95, rr: 2,
    pullbackAllowanceAtr: 1, btcOverrideScoreMin: 90, btcOverrideVolumeMin: 1.5
  });
}
function riskGateSignal(normalizedScore) {
  return {
    symbol: 'TESTUSD', strategy: 'MOMENTUM', normalizedScore,
    stage: 'SETUP', ready: false, side: '', score: 95,
    candlesFresh: true, blocked: []
  };
}
async function runRiskGate(normalizedScore) {
  const engine = new DeltaEngine();
  return engine.riskGate(riskGateSignal(normalizedScore), 'MOMENTUM',
    { equity: 1_000, available: 1_000 },
    { emergency_stop: true, enabled: false, auto_trade: false, continuous_mode: true }, [], []);
}
async function runOpenTrade(normalizedScore) {
  const engine = new DeltaEngine();
  engine.privateExecutionAvailable = true;
  let riskGateCalls = 0;
  engine.riskGate = async () => {
    riskGateCalls += 1;
    return { reasons: ['SELF_TEST_STOP'], size: null };
  };
  const signal = {
    symbol: 'TESTUSD', stage: 'CONFIRMED', ready: true, side: 'BUY',
    score: 95, normalizedScore, price: 110, sl: 108, tp1: 112, tp: 114,
    productId: 1, contractValue: 1, notionalType: 'vanilla'
  };
  const result = await engine.openTrade({}, 'MOMENTUM', signal,
    { equity: 1_000, available: 1_000 },
    { risk_pct: 1, max_leverage: 2, emergency_stop: true }, [], []);
  return { result, riskGateCalls };
}

test('strategy hardReady blocks normalized score 79.99', () => {
  const signal = analyseAt(79.99);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Normalized score below 80 or unavailable'));
});
test('strategy hardReady allows normalized score exactly 80 when other gates pass', () => {
  const signal = analyseAt(80);
  assert.equal(signal.stage, 'CONFIRMED');
  assert.equal(signal.ready, true);
  assert.ok(!signal.blocked.includes('Normalized score below 80 or unavailable'));
});
test('strategy hardReady fails closed for a null normalized score', () => {
  const signal = analyseAt(null);
  assert.equal(signal.ready, false);
  assert.ok(signal.blocked.includes('Normalized score below 80 or unavailable'));
});
test('strategy hardReady allows normalized score 85 when other gates pass', () => {
  const signal = analyseAt(85, 'SCALPING');
  assert.equal(signal.stage, 'CONFIRMED');
  assert.equal(signal.ready, true);
});
test('riskGate blocks below-threshold and missing normalized scores', async () => {
  for (const score of [79.99, null]) {
    const gate = await runRiskGate(score);
    assert.ok(gate.reasons.includes('Normalized score below 80 or unavailable'), String(score));
  }
});
test('riskGate allows normalized scores 80 and 85 without the normalized-score blocker', async () => {
  for (const score of [80, 85]) {
    const gate = await runRiskGate(score);
    assert.ok(!gate.reasons.includes('Normalized score below 80 or unavailable'), String(score));
  }
});
test('openTrade rejects normalized score 79.99 before the risk gate', async () => {
  const result = await runOpenTrade(79.99);
  assert.equal(result.result, false);
  assert.equal(result.riskGateCalls, 0);
});
test('openTrade rejects a null normalized score before the risk gate', async () => {
  const result = await runOpenTrade(null);
  assert.equal(result.result, false);
  assert.equal(result.riskGateCalls, 0);
});
test('openTrade passes normalized score 80 to downstream risk controls', async () => {
  const result = await runOpenTrade(80);
  assert.equal(result.result, false);
  assert.equal(result.riskGateCalls, 1);
});
test('openTrade passes normalized score 85 to downstream risk controls', async () => {
  const result = await runOpenTrade(85);
  assert.equal(result.result, false);
  assert.equal(result.riskGateCalls, 1);
});
