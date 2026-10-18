import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHealthAge, formatLeaseRemaining, getEmergencyStopTooltip, getWorkerStatusDisplay } from '../src/worker-status-display.js';

test('cap reached blocks new signals in both cards while scanning stays on', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, emergencyStop: false,
    currentOpenPositions: 20, maxOpenPositions: 20
  });
  assert.equal(status.capReached, true);
  assert.equal(status.continuousValue, 'ON · BLOCKED');
  assert.equal(status.continuousSubtitle, '⚠️ Global cap reached (20/20). New signals blocked until positions close.');
  assert.equal(status.autoTradeSubtitle, 'Scanner enabled, but all new signals blocked by global cap (20/20).');
});

test('cap below maximum keeps continuous scanning active and shows live count', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, currentOpenPositions: 12, maxOpenPositions: 20
  });
  assert.equal(status.capReached, false);
  assert.equal(status.continuousValue, 'ON · ACTIVE');
  assert.equal(status.continuousSubtitle, 'Continuous scanning active. Global cap: 12/20.');
  assert.equal(status.autoTradeSubtitle, 'Scanner enabled. Signals active.');
});

test('continuous mode off is clearly distinguished from auto trade being off', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: false, currentOpenPositions: 3, maxOpenPositions: 20
  });
  assert.equal(status.continuousValue, 'OFF');
  assert.equal(status.continuousSubtitle, 'Continuous scanning is off. No continuous automatic routing.');
  assert.match(status.autoTradeSubtitle, /Signals active/);
});

test('auto off means no automatic routing and no signals', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: false, continuousMode: true, currentOpenPositions: 12, maxOpenPositions: 20
  });
  assert.equal(status.continuousValue, 'OFF');
  assert.equal(status.continuousSubtitle, 'Manual mode. No automatic routing.');
  assert.equal(status.autoTradeSubtitle, 'Scanner disabled. No signals will be sent.');
});

test('emergency stop overrides auto trade and cap subtitles', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, emergencyStop: true,
    currentOpenPositions: 20, maxOpenPositions: 20
  });
  assert.equal(status.autoTradeSubtitle, '🚨 EMERGENCY STOP ACTIVE. All signal flow halted.');
  assert.equal(status.continuousValue, 'ON · HALTED');
  assert.equal(status.continuousSubtitle, '🚨 EMERGENCY STOP ACTIVE. All signal flow halted.');
});

test('missing or invalid cap telemetry never claims capacity is available', () => {
  const status = getWorkerStatusDisplay({
    autoTrade: true, continuousMode: true, currentOpenPositions: null, maxOpenPositions: 20
  });
  assert.equal(status.capReached, false);
  assert.equal(status.hasCapData, false);
  assert.equal(status.capLabel, 'NO DATA');
  assert.match(status.continuousSubtitle, /cap status unavailable/i);
  assert.match(status.autoTradeSubtitle, /status unavailable/i);
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
  assert.equal(getEmergencyStopTooltip(true), 'Emergency stop active; all signal flow halted.');
});
