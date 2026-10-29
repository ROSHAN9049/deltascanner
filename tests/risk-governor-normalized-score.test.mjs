// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/risk-governor-normalized-score.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNormalizedScoreDiagnostic, buildRiskGovernorGates } from '../src/risk-governor.js';

test('normalized score diagnostic warns when original is high but normalized is below 80', () => {
  const result = buildNormalizedScoreDiagnostic({ score: 95, details: { normalizedScore: 62 } });
  assert.equal(result.status, 'WARN');
  assert.match(result.reason, /Original score inflated/);
});

test('normalized score diagnostic passes when both values meet 80', () => {
  const result = buildNormalizedScoreDiagnostic({ score: 90, details: { normalizedScore: 82 } });
  assert.equal(result.status, 'PASS');
});

test('normalized score diagnostic blocks when both values are below 80', () => {
  const result = buildNormalizedScoreDiagnostic({ score: 69, details: { normalizedScore: 45 } });
  assert.equal(result.status, 'BLOCK');
});

test('missing normalized score stays UNKNOWN instead of manufacturing a pass', () => {
  const result = buildNormalizedScoreDiagnostic({ score: 95, stage: 'CONFIRMED', details: {} });
  assert.equal(result.status, 'UNKNOWN');
});

test('normalized score below 80 blocks the governor gate set despite a confirmed original score', () => {
  const selected = {
    symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 95, side: 'BUY',
    details: { normalizedScore: 40 }
  };
  const gates = buildRiskGovernorGates({ selected });
  const confirmedGate = gates.find(gate => gate.gate === 'Signal CONFIRMED');
  const normalizedGate = gates.find(gate => gate.gate === 'Normalized score >= 80');
  assert.equal(confirmedGate.result, 'PASS');
  assert.equal(normalizedGate.result, 'BLOCK');
  assert.equal(buildNormalizedScoreDiagnostic(selected).status, 'WARN');
});
