import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskGovernorGates } from '../src/risk-governor.js';
import { GATE_BLOCK, GATE_PASS, GATE_UNKNOWN } from '../src/gate-result.js';

const gate = (rows, name) => rows.find(row => row.gate === name)?.result;

test('missing risk observations fail closed for range and EMA gates instead of displaying UNKNOWN/PASS', () => {
  const rows = buildRiskGovernorGates({
    selected: { symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 90 },
    health: {},
    positions: [],
    routedSymbols: [],
    routeDataVerified: false
  });
  assert.equal(gate(rows, 'Signal CONFIRMED'), GATE_PASS);
  assert.equal(gate(rows, 'Tradetron futures route'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Fee + spread vs 1R'), GATE_UNKNOWN);
  assert.equal(gate(rows, '24h anti-chase'), GATE_UNKNOWN);
  assert.equal(gate(rows, '5m range <= 4 ATR'), GATE_BLOCK);
  assert.equal(gate(rows, 'EMA21 distance <= 3.50 ATR'), GATE_BLOCK);
  assert.equal(gate(rows, 'BTC regime'), GATE_BLOCK);
  assert.equal(gate(rows, 'Spread'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Fresh closed candles'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'API / worker healthy'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_PASS);
  assert.equal(gate(rows, 'Margin / min size'), GATE_UNKNOWN);
});

test('route and entry are blocked when Tradetron position snapshots are untrusted', () => {
  const rows = buildRiskGovernorGates({
    selected: { symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 92 },
    health: { workerLeaseActive: true, exchangeHealthy: true, tickFresh: true },
    positions: null,
    routedSymbols: ['BTCUSD'],
    routeDataVerified: true,
    entrySafetyTrusted: false
  });
  assert.equal(gate(rows, 'Tradetron futures route'), GATE_BLOCK);
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_UNKNOWN);
});

test('observed values can pass only the gate they actually verify', () => {
  const rows = buildRiskGovernorGates({
    selected: {
      symbol: 'BTCUSD',
      strategy: 'MOMENTUM',
      stage: 'CONFIRMED',
      score: 90,
      fee_risk_ratio: 0.1,
      change_24h: 0,
      side: 'BUY',
      spread_pct: 0.2,
      qty_contracts: 2,
      notional: 25,
      details: { candlesFresh: true, emaDistanceAtr: 1.2, rangeAtr: 2.1, btcRegimeOverride: true }
    },
    health: { workerLeaseActive: true, exchangeHealthy: true, tickFresh: true },
    positions: [],
    routedSymbols: ['BTCUSD'],
    routeDataVerified: true
  });
  for (const name of [
    'Signal CONFIRMED','Tradetron futures route','Fee + spread vs 1R','24h anti-chase',
    '5m range <= 4 ATR','EMA21 distance <= 3.50 ATR','BTC regime','Spread',
    'Fresh closed candles','API / worker healthy','Duplicate symbol','Margin / min size'
  ]) assert.equal(gate(rows,name), GATE_PASS, name + ' expected PASS');
});

test('explicit backend blocker takes precedence over a low/missing observed value', () => {
  const rows = buildRiskGovernorGates({
    selected: {
      symbol: 'ETHUSD',
      strategy: 'SCALPING',
      stage: 'CONFIRMED',
      score: 95,
      spread_pct: 0.1,
      fee_risk_ratio: 0.1,
      side: 'BUY',
      change_24h: 0,
      blocked_reasons: ['SPREAD_TOO_WIDE', '5m range too high', 'Fresh closed candles unavailable']
    },
    health: { workerLeaseActive: true, exchangeHealthy: true, tickFresh: true },
    positions: [],
    routedSymbols: ['ETHUSD'],
    routeDataVerified: true
  });
  assert.equal(gate(rows, 'Spread'), GATE_BLOCK);
  assert.equal(gate(rows, '5m range <= 3 ATR'), GATE_BLOCK);
  assert.equal(gate(rows, 'Fresh closed candles'), GATE_BLOCK);
});

test('a pending-reservation duplicate blocker stays BLOCK even with no open position row', () => {
  const rows = buildRiskGovernorGates({
    selected: {
      symbol: 'PAXGUSD',
      strategy: 'MOMENTUM',
      stage: 'CONFIRMED',
      score: 99,
      blocked_reasons: ['Duplicate symbol']
    },
    positions: []
  });
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_BLOCK);
});

test('an open position blocks the duplicate-symbol check', () => {
  const rows = buildRiskGovernorGates({
    selected: { symbol: 'BTCUSD', stage: 'CONFIRMED', score: 90 },
    positions: [{ symbol: 'btcusd', qty: 1 }]
  });
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_BLOCK);
});

test('Momentum and Scalp use their own worker-aligned range and EMA thresholds', () => {
  const momentum = buildRiskGovernorGates({ selected: {
    symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 91,
    details: { rangeAtr: 3.8, emaDistanceAtr: 3.4 }
  }});
  assert.equal(gate(momentum, '5m range <= 4 ATR'), GATE_PASS);
  assert.equal(gate(momentum, 'EMA21 distance <= 3.50 ATR'), GATE_PASS);

  const scalp = buildRiskGovernorGates({ selected: {
    symbol: 'BTCUSD', strategy: 'SCALPING', stage: 'CONFIRMED', score: 91,
    details: { rangeAtr: 3.8, emaDistanceAtr: 3.4 }
  }});
  assert.equal(gate(scalp, '5m range <= 3 ATR'), GATE_BLOCK);
  assert.equal(gate(scalp, 'EMA21 distance <= 2.50 ATR'), GATE_BLOCK);
});

test('SCALP alias uses the same dashboard thresholds as SCALPING', () => {
  const rows = buildRiskGovernorGates({ selected: {
    symbol: 'ETHUSD', strategy: 'SCALP',
    details: { rangeAtr: 2.9, emaDistanceAtr: 2.4 }
  }});
  assert.equal(gate(rows, '5m range <= 3 ATR'), GATE_PASS);
  assert.equal(gate(rows, 'EMA21 distance <= 2.50 ATR'), GATE_PASS);
});

test('BTC regime uses a clearly labeled 5m/15m approximation when both trend labels exist', () => {
  const rows = buildRiskGovernorGates({ selected: {
    symbol: 'ETHUSD', strategy: 'MOMENTUM',
    btc_trend: 'BULL',
    details: { btcTrend15m: 'BULL' }
  }});
  assert.equal(gate(rows, 'BTC regime'), GATE_PASS);
  const record = rows.find(row => row.gate === 'BTC regime');
  assert.match(record.blockReason, /Dashboard-only approximation PASS/);
  assert.match(record.blockReason, /not the full 1h EMA50\/EMA200 \+ ATR regime/);
});

test('BTC regime approximation BLOCKs mixed/flat trends and never returns UNKNOWN', () => {
  const rows = buildRiskGovernorGates({ selected: {
    symbol: 'ETHUSD', strategy: 'SCALPING', btc_trend: 'BULL',
    details: { btcTrend15m: 'BEAR' }
  }});
  assert.equal(gate(rows, 'BTC regime'), GATE_BLOCK);
  assert.match(rows.find(row => row.gate === 'BTC regime').blockReason, /trends are mixed or flat/);
});

test('BTC regime fails closed with an explicit adapter-window reason when 15m BTC trend is absent', () => {
  const rows = buildRiskGovernorGates({ selected: {
    symbol: 'ETHUSD', strategy: 'MOMENTUM', btc_trend: 'BULL'
  }});
  assert.equal(gate(rows, 'BTC regime'), GATE_BLOCK);
  assert.match(rows.find(row => row.gate === 'BTC regime').blockReason, /about 21 hours/);
  assert.match(rows.find(row => row.gate === 'BTC regime').blockReason, /does not/);
});
