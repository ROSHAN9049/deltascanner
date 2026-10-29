// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/settings-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsAuditEntry } from '../server/settings-audit.js';

test('audit row records actor, timestamp, and persisted old-to-new boolean changes', () => {
  const row = buildSettingsAuditEntry({
    actor: 'authenticated-engine-session',
    at: '2026-10-29T00:00:00.000Z',
    previous: { auto_trade: false },
    patch: { auto_trade: true },
    persisted: { auto_trade: true }
  });
  assert.equal(row.level, 'INFO');
  assert.equal(row.message, 'Settings changed');
  assert.equal(row.data.event, 'SETTINGS_CHANGED');
  assert.equal(row.data.actor, 'authenticated-engine-session');
  assert.equal(row.data.at, '2026-10-29T00:00:00.000Z');
  assert.deepEqual(row.data.changes, [{ setting: 'auto_trade', from: false, to: true }]);
});

test('audit row records only actual changes and uses persisted values', () => {
  const row = buildSettingsAuditEntry({
    actor: 'engine-secret-header',
    at: '2026-10-29T00:00:00.000Z',
    previous: { auto_trade: false, emergency_stop: true, risk_pct: 1 },
    patch: { auto_trade: true, emergency_stop: true, risk_pct: 2 },
    persisted: { auto_trade: true, emergency_stop: true, risk_pct: 2 }
  });
  assert.deepEqual(row.data.changes, [
    { setting: 'auto_trade', from: false, to: true },
    { setting: 'risk_pct', from: 1, to: 2 }
  ]);
});

test('unchanged values do not create a settings-changed audit event', () => {
  assert.equal(buildSettingsAuditEntry({
    actor: 'authenticated-engine-session',
    previous: { auto_trade: true },
    patch: { auto_trade: true },
    persisted: { auto_trade: true }
  }), null);
});

test('grid state is summarized instead of copying a full state payload into audit logs', () => {
  const row = buildSettingsAuditEntry({
    actor: 'authenticated-engine-session',
    previous: { grid_state: { status: 'OFF', positions: [], pausedReason: null } },
    patch: { grid_state: { status: 'RUNNING', positions: [{ symbol: 'BTCUSD' }], pausedReason: null } },
    persisted: { grid_state: { status: 'RUNNING', positions: [{ symbol: 'BTCUSD' }], pausedReason: null, wasEnabled: true } }
  });
  assert.deepEqual(row.data.changes, [{
    setting: 'grid_state',
    from: { status: 'OFF', openPositions: 0, pausedReason: null, wasEnabled: false },
    to: { status: 'RUNNING', openPositions: 1, pausedReason: null, wasEnabled: true }
  }]);
});
