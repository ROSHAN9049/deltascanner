import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskGovernorGates } from '../src/risk-governor.js';
import { GATE_BLOCK, GATE_PASS, GATE_UNKNOWN } from '../src/gate-result.js';

const gate = (rows, name) => rows.find(row => row.gate === name)?.result;

test('missing risk observations remain UNKNOWN instead of displaying false PASS', () => {
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
  assert.equal(gate(rows, '5m range <= 3 ATR'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'EMA21 distance <= 2.50 ATR'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'BTC regime'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Spread'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Fresh closed candles'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'API / worker healthy'), GATE_UNKNOWN);
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_PASS);
  assert.equal(gate(rows, 'Margin / min size'), GATE_UNKNOWN);
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
      details: { candlesFresh: true, emaDistanceAtr: 1.2, rangeAtrRatio: 2.1, btcRegimeOverride: true }
    },
    health: { workerLeaseActive: true, exchangeHealthy: true, tickFresh: true },
    positions: [],
    routedSymbols: ['BTCUSD'],
    routeDataVerified: true
  });
  for (const name of [
    'Signal CONFIRMED','Tradetron futures route','Fee + spread vs 1R','24h anti-chase',
    '5m range <= 3 ATR','EMA21 distance <= 2.50 ATR','BTC regime','Spread',
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

test('an open position blocks the duplicate-symbol check', () => {
  const rows = buildRiskGovernorGates({
    selected: { symbol: 'BTCUSD', stage: 'CONFIRMED', score: 90 },
    positions: [{ symbol: 'btcusd', qty: 1 }]
  });
  assert.equal(gate(rows, 'Duplicate symbol'), GATE_BLOCK);
});
