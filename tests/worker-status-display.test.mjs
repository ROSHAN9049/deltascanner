import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHealthAge, formatLeaseRemaining, formatRetentionLastRun, getEmergencyStopTooltip, getWorkerStatusDisplay } from '../src/worker-status-display.js';

test('cap reached blocks new signals in both cards while scanning stays on', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, emergencyStop: false,
    currentOpenPositions: 20, maxOpenPositions: 20
  });
  assert.equal(status.capReached, true);
  assert.equal(status.continuousValue, 'ON · BLOCKED');
  assert.equal(status.continuousSubtitle, '⚠️ Global cap reached (20/20). New entries blocked until positions close.');
  assert.equal(status.autoTradeSubtitle, 'Scanner active, but new entries are blocked by the global position cap (20/20).');
});

test('cap below maximum keeps continuous scanning active and shows live count', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, currentOpenPositions: 12, maxOpenPositions: 20
  });
  assert.equal(status.capReached, false);
  assert.equal(status.continuousValue, 'ON · ACTIVE');
  assert.equal(status.continuousSubtitle, 'Continuous scanning active. Global cap: 12/20.');
  assert.equal(status.autoTradeSubtitle, 'Scanner active. Signals and entry checks are running.');
});

test('continuous mode off is clearly distinguished from auto trade being off', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: false, currentOpenPositions: 3, maxOpenPositions: 20
  });
  assert.equal(status.continuousValue, 'OFF · MANUAL');
  assert.equal(status.continuousSubtitle, 'Continuous automatic routing is OFF; the worker continues market scanning.');
  assert.match(status.autoTradeSubtitle, /Signals and entry checks are running/);
});

test('scanner disabled is distinct from Auto Trade disabled', () => {
  const status = getWorkerStatusDisplay({
    scannerEnabled: false,
    autoTrade: false,
    continuousMode: true,
    currentOpenPositions: 0,
    maxOpenPositions: 20
  });
  assert.equal(status.continuousValue, 'OFF');
  assert.equal(status.autoTradeSubtitle, 'Scanner disabled. Market scans and signal refreshes are paused.');
  assert.equal(status.continuousSubtitle, 'Scanner is disabled; no market scan or signal refresh occurs.');
});

test('auto off keeps the scanner active while disabling automatic entries', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: false, continuousMode: true, currentOpenPositions: 12, maxOpenPositions: 20
  });
  assert.equal(status.continuousValue, 'OFF · AUTO TRADE');
  assert.equal(status.continuousSubtitle, 'Auto Trade is OFF; the scanner continues to scan, but automatic entries are not routed.');
  assert.equal(status.autoTradeSubtitle, 'Scanner remains active. Auto Trade is OFF, so no automatic entries are routed.');
});

test('emergency stop overrides auto trade and cap subtitles', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, emergencyStop: true,
    currentOpenPositions: 20, maxOpenPositions: 20
  });
  assert.equal(status.autoTradeSubtitle, '🚨 EMERGENCY STOP ACTIVE. New entries and automatic routing are halted; market scanning may continue.');
  assert.equal(status.continuousValue, 'ON · HALTED');
  assert.equal(status.continuousSubtitle, 'Emergency Stop is active; new entries are halted while public-market scanning may continue.');
});

test('missing or invalid cap telemetry never claims capacity is available', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, currentOpenPositions: null, maxOpenPositions: 20
  });
  assert.equal(status.capReached, false);
  assert.equal(status.hasCapData, false);
  assert.equal(status.capLabel, 'NO DATA');
  assert.match(status.continuousSubtitle, /cap status unavailable/i);
  assert.match(status.autoTradeSubtitle, /status is unavailable/i);
});

test('health ages and lease remaining are formatted in seconds without snake-case conversion', () => {
  assert.equal(formatHealthAge(1999), '1 sec');
  assert.equal(formatHealthAge(null), 'NO DATA');
  assert.equal(formatLeaseRemaining(1001), '2 sec');
  assert.equal(formatLeaseRemaining(0), '0 sec');
  assert.equal(formatLeaseRemaining(null), 'NO DATA');
  assert.equal(formatLeaseRemaining(undefined), 'NO DATA');
});

test('emergency-stop tooltip reflects the current state', () => {
  assert.equal(getEmergencyStopTooltip(false), 'No emergency halt active.');
  assert.equal(getEmergencyStopTooltip(true), 'Emergency Stop active; new entries and automatic routing are halted. Public-market scanning may continue.');
});

test('retention last-run age is human-readable and missing timestamps show NO DATA', () => {
  assert.equal(
    formatRetentionLastRun('2026-10-20T09:00:00.000Z', Date.parse('2026-10-20T09:42:00.000Z')),
    '42 min ago'
  );
  assert.equal(formatRetentionLastRun(null, Date.parse('2026-10-20T09:42:00.000Z')), 'NO DATA');
  assert.equal(formatRetentionLastRun('not-a-date', Date.parse('2026-10-20T09:42:00.000Z')), 'NO DATA');
  assert.equal(
    formatRetentionLastRun('2026-10-20T10:00:00.000Z', Date.parse('2026-10-20T09:42:00.000Z')),
    '0 min ago'
  );
});
