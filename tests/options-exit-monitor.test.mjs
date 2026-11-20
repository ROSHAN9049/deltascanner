import test from 'node:test';
import assert from 'node:assert/strict';
import { createOptionsExitMonitor, OPTIONS_EXIT_MONITOR_INTERVAL_MS } from '../worker/options-exit-monitor.mjs';

test('exit monitor is disabled by default and performs no polling', async () => {
  let calls = 0;
  const worker = createOptionsExitMonitor({ monitor: async () => { calls += 1; } });
  await worker.start();
  assert.equal((await worker.runOnce()).status, 'DISABLED');
  assert.equal(calls, 0);
});

test('exit monitor polls every 60 seconds and stops its timer', async () => {
  const timers = [], cleared = [];
  let calls = 0;
  const worker = createOptionsExitMonitor({
    env: { OPTIONS_REGIME_STRATEGY_ENABLED: 'true', OPTIONS_EXIT_MONITOR_ENABLED: 'true' },
    monitor: async () => { calls += 1; return { status: 'OK' }; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, unref() { this.unrefCalled = true; } };
      timers.push(timer); return timer;
    },
    clearIntervalFn: timer => cleared.push(timer)
  });
  await worker.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, OPTIONS_EXIT_MONITOR_INTERVAL_MS);
  assert.equal(timers[0].delay, 60_000);
  assert.equal(timers[0].unrefCalled, true);
  assert.equal(calls, 1);
  await worker.stop();
  assert.deepEqual(cleared, timers);
});

test('exit monitor also runs in explicit Demo mode without Regime strategy flag', async () => {
  const timers = [];
  let calls = 0;
  const worker = createOptionsExitMonitor({
    env: { OPTIONS_EXECUTION_MODE: 'demo', OPTIONS_REGIME_STRATEGY_ENABLED: 'false', OPTIONS_EXIT_MONITOR_ENABLED: 'true' },
    monitor: async () => { calls += 1; return { status: 'OK', monitored: 1, exits: 0 }; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    }
  });
  await worker.start();
  assert.equal(timers.length, 1);
  assert.equal(calls, 1);
  await worker.stop();
});
