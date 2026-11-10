import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerGridAutoRangeStatus } from '../server/engine-state-privacy.js';

test('uses the Worker diagnostic when the heartbeat is fresh', () => {
  const now = Date.parse('2026-11-10T05:00:00.000Z');
  const result = resolveWorkerGridAutoRangeStatus({
    created_at: '2026-11-10T04:59:30.000Z',
    data: { gridAutoRangeEnvironmentEnabled: true, gridTestnetDiagnostics: {} }
  }, { now });
  assert.equal(result.enabled, true);
  assert.equal(result.heartbeatFresh, true);
});

test('reports an explicit fresh Worker false flag as disabled', () => {
  const now = Date.parse('2026-11-10T05:00:00.000Z');
  const result = resolveWorkerGridAutoRangeStatus({
    created_at: '2026-11-10T04:59:30.000Z',
    data: { gridAutoRangeEnvironmentEnabled: false, gridTestnetDiagnostics: { gridAutoRangeEnvironmentEnabled: true } }
  }, { now });
  assert.equal(result.enabled, false);
  assert.equal(result.heartbeatFresh, true);
});

test('does not trust stale or missing Worker diagnostic values', () => {
  const now = Date.parse('2026-11-10T05:00:00.000Z');
  const stale = resolveWorkerGridAutoRangeStatus({
    created_at: '2026-11-10T04:50:00.000Z',
    data: { gridTestnetDiagnostics: { gridAutoRangeEnvironmentEnabled: true } }
  }, { now });
  assert.equal(stale.enabled, null);
  assert.equal(stale.heartbeatFresh, false);
  const missing = resolveWorkerGridAutoRangeStatus({
    created_at: '2026-11-10T04:59:30.000Z', data: { gridTestnetDiagnostics: {} }
  }, { now });
  assert.equal(missing.enabled, null);
  assert.equal(missing.heartbeatFresh, true);
});


test('prefers the direct heartbeat flag when nested diagnostics disagree', () => {
  const now = Date.parse('2026-11-10T05:00:00.000Z');
  const result = resolveWorkerGridAutoRangeStatus({
    created_at: '2026-11-10T04:59:30.000Z',
    data: {
      gridAutoRangeEnvironmentEnabled: true,
      gridTestnetDiagnostics: { gridAutoRangeEnvironmentEnabled: false }
    }
  }, { now });
  assert.equal(result.enabled, true);
  assert.equal(result.heartbeatFresh, true);
});
