import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isManualOverrideAllowed,
  isManualOverrideOptionCandidate
} from '../src/options-manual-override.js';

test('manual override UI gate accepts the health endpoint object contract', () => {
  assert.equal(isManualOverrideAllowed({
    optionsManualTestOverride: { allowed: true, flagEnabled: true },
    optionsExecutionGate: { allowed: true }
  }), true);
});

test('manual override UI gate accepts the boolean compatibility field but still requires execution gate', () => {
  assert.equal(isManualOverrideAllowed({
    optionsManualTestOverrideAllowed: true,
    optionsExecutionGate: { allowed: true }
  }), true);
  assert.equal(isManualOverrideAllowed({
    optionsManualTestOverride: true,
    optionsExecutionGate: { allowed: false }
  }), false);
  assert.equal(isManualOverrideAllowed({
    optionsManualTestOverride: { allowed: false },
    optionsExecutionGate: { allowed: true }
  }), false);
});

test('BUY manual candidate ignores score, analysis readiness, spread and OI but uses row-level Delta/DTE', () => {
  const row = {
    symbol: 'C-BTC-77000-131126',
    strategy: 'OPTIONS_BUY',
    delta: 0.5965,
    dte: 7,
    score: 54,
    stage: 'SETUP',
    ready: false,
    analysisReady: false,
    spread_pct: 2.43,
    oi: 0
  };
  assert.equal(isManualOverrideOptionCandidate({
    row,
    manualOverrideAllowed: true,
    deltaMin: 0.45,
    deltaMax: 0.65,
    dteMin: 2,
    dteMax: 14
  }), true);
});

test('manual candidate remains blocked when Delta or DTE falls outside its configured band', () => {
  const base = {
    symbol: 'C-BTC-77000-131126',
    delta: 0.5965,
    dte: 7,
    spread_pct: 2.43,
    oi: 0
  };
  const gates = {
    manualOverrideAllowed: true,
    deltaMin: 0.45,
    deltaMax: 0.65,
    dteMin: 2,
    dteMax: 14
  };
  assert.equal(isManualOverrideOptionCandidate({
    row: { ...base, delta: 0.7 }, ...gates
  }), false);
  assert.equal(isManualOverrideOptionCandidate({
    row: { ...base, dte: 1 }, ...gates
  }), false);
});

test('SELL manual candidate still requires visible protective-hedge metadata', () => {
  const base = {
    symbol: 'P-BTC-89000-061126',
    delta: -0.25,
    dte: 7,
    details: {}
  };
  const gates = {
    manualOverrideAllowed: true,
    deltaMin: 0.2,
    deltaMax: 0.35,
    dteMin: 2,
    dteMax: 14,
    requiresHedge: true
  };
  assert.equal(isManualOverrideOptionCandidate({ row: base, ...gates }), false);
  assert.equal(isManualOverrideOptionCandidate({
    row: {
      ...base,
      details: {
        hedgeSymbol: 'C-BTC-90000-061126',
        hedgeStrike: 90000,
        hedgeDelta: 0.2
      }
    },
    ...gates
  }), true);
});

test('manual candidate is never enabled when the server gate is off', () => {
  assert.equal(isManualOverrideOptionCandidate({
    row: { symbol: 'C-BTC-77000-131126', delta: 0.5965, dte: 7 },
    manualOverrideAllowed: false,
    deltaMin: 0.45,
    deltaMax: 0.65,
    dteMin: 2,
    dteMax: 14
  }), false);
});
