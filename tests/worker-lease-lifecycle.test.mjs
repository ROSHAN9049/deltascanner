// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/worker-lease-lifecycle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLeaseManager, getLeaseTtlSeconds } from '../worker/lease-manager.mjs';
import {
  createDeltaTestnetHealthProbe,
  DELTA_TESTNET_HEALTH_URL,
  DELTA_TESTNET_HEALTH_CACHE_TTL_MS
} from '../server/delta-testnet-health.js';

function timerHarness() {
  const scheduled = [];
  const cleared = new Set();
  return {
    scheduled, cleared,
    setIntervalFn(callback, ms) {
      const timer = { callback, ms, unref() { this.unrefed = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { cleared.add(timer); }
  };
}
function httpResponse(status, payload) {
  return { status, ok: status >= 200 && status < 300, async json() { return payload; } };
}

test('lease TTL defaults to 60 seconds and validates an environment override', () => {
  assert.equal(getLeaseTtlSeconds(''), 60);
  assert.equal(getLeaseTtlSeconds('120'), 120);
  assert.throws(() => getLeaseTtlSeconds('20'), /between 30 and 3600/);
  assert.throws(() => getLeaseTtlSeconds('not-a-number'), /between 30 and 3600/);
});

test('lease is acquired once, renews on a 15-second timer, and is not released per scan', async () => {
  const timers = timerHarness();
  let acquireCalls = 0, renewCalls = 0, releaseCalls = 0;
  const manager = createLeaseManager({
    leaseId: 'lease-a', workerId: 'worker-a', ttlSeconds: 60,
    renewEveryMs: 15_000, setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn,
    async acquireFn() { acquireCalls += 1; return true; },
    async renewFn() { renewCalls += 1; return true; },
    async releaseFn() { releaseCalls += 1; return true; }
  });
  await manager.start();
  assert.equal(acquireCalls, 1);
  assert.equal(manager.isHeld, true);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 15_000);
  assert.equal(timers.scheduled[0].unrefed, true);
  await manager.renewNow();
  assert.equal(renewCalls, 1);
  assert.equal(releaseCalls, 0);
  assert.equal(manager.isHeld, true);
  await manager.release();
});

test('denied renewal marks ownership lost and stops the renewal timer', async () => {
  const timers = timerHarness(), lost = [];
  const manager = createLeaseManager({
    leaseId: 'lease-b', workerId: 'worker-b', ttlSeconds: 60,
    setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn,
    async acquireFn() { return true; }, async renewFn() { return false; },
    async releaseFn() { return true; },
    async onLeaseLost(error) { lost.push(error.message); }
  });
  await manager.start();
  assert.equal(await manager.renewNow(), false);
  assert.equal(manager.isHeld, false);
  assert.equal(manager.isAcquired, false);
  assert.equal(timers.cleared.has(timers.scheduled[0]), true);
  assert.match(lost[0], /ownership was lost/);
});

test('transient renewal error fails closed until a later confirmed renewal', async () => {
  const timers = timerHarness(), errors = [];
  let attempts = 0;
  const manager = createLeaseManager({
    leaseId: 'lease-c', workerId: 'worker-c', ttlSeconds: 60,
    setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn,
    async acquireFn() { return true; },
    async renewFn() { attempts += 1; if (attempts === 1) throw new Error('temporary database timeout'); return true; },
    async releaseFn() { return true; }, async onError(error) { errors.push(error.message); }
  });
  await manager.start();
  assert.equal(await manager.renewNow(), false);
  assert.equal(manager.isAcquired, true);
  assert.equal(manager.isHealthy, false);
  assert.equal(manager.isHeld, false);
  assert.equal(await manager.renewNow(), true);
  assert.equal(manager.isHeld, true);
  assert.deepEqual(errors, ['temporary database timeout']);
  await manager.release();
});

test('release stops timers and calls the database release callback at most once', async () => {
  const timers = timerHarness();
  let releases = 0;
  const manager = createLeaseManager({
    leaseId: 'lease-d', workerId: 'worker-d', ttlSeconds: 60,
    setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn,
    async acquireFn() { return true; }, async renewFn() { return true; },
    async releaseFn() { releases += 1; return true; }
  });
  await manager.start();
  assert.equal(await manager.release(), true);
  assert.equal(await manager.release(), true);
  assert.equal(releases, 1);
  assert.equal(timers.cleared.has(timers.scheduled[0]), true);
  assert.equal(manager.isHeld, false);
});

test('Delta Testnet health probe reports a valid public API response', async () => {
  let requestedUrl = '';
  const probe = createDeltaTestnetHealthProbe({
    now: () => 1_790_000_000_000,
    async fetchImpl(url) { requestedUrl = url; return httpResponse(200, { success: true, result: [] }); }
  });
  const result = await probe();
  assert.equal(requestedUrl, DELTA_TESTNET_HEALTH_URL);
  assert.equal(result.healthy, true);
  assert.equal(result.status, 200);
  assert.equal(result.source, 'delta-testnet-public-api');
  assert.equal(result.cached, false);
  assert.equal(result.error, null);
});

test('Delta Testnet health cache suppresses repeated pings for 20 seconds', async () => {
  let now = 1_790_000_000_000, calls = 0;
  const probe = createDeltaTestnetHealthProbe({
    now: () => now,
    async fetchImpl() { calls += 1; return httpResponse(200, { success: true, result: [] }); }
  });
  assert.equal((await probe()).cached, false);
  assert.equal((await probe()).cached, true);
  assert.equal(calls, 1);
  assert.equal(DELTA_TESTNET_HEALTH_CACHE_TTL_MS, 20_000);
  now += 20_001;
  assert.equal((await probe()).cached, false);
  assert.equal(calls, 2);
});

test('HTTP errors and explicit API failure both report exchange unhealthy', async () => {
  const httpFailure = createDeltaTestnetHealthProbe({
    now: () => 1_790_000_000_000,
    async fetchImpl() { return httpResponse(503, { success: false }); }
  });
  const failedResponse = await httpFailure();
  assert.equal(failedResponse.healthy, false);
  assert.equal(failedResponse.status, 503);
  assert.match(failedResponse.error, /HTTP 503/);
  const apiFailure = createDeltaTestnetHealthProbe({
    now: () => 1_790_000_000_000,
    async fetchImpl() { return httpResponse(200, { success: false }); }
  });
  const failedPayload = await apiFailure();
  assert.equal(failedPayload.healthy, false);
  assert.match(failedPayload.error, /success=false/);
});

test('network errors, invalid JSON, and timed-out requests all fail closed', async () => {
  const networkFailure = createDeltaTestnetHealthProbe({
    async fetchImpl() { throw new Error('network unreachable'); }
  });
  assert.equal((await networkFailure()).healthy, false);
  const jsonFailure = createDeltaTestnetHealthProbe({
    async fetchImpl() { return { ok: true, status: 200, async json() { throw new Error('invalid JSON'); } }; }
  });
  assert.equal((await jsonFailure()).healthy, false);
  let fireTimeout;
  const timeoutFailure = createDeltaTestnetHealthProbe({
    setTimeoutFn(callback) { fireTimeout = callback; return { unref() {} }; },
    clearTimeoutFn() {},
    async fetchImpl(_url, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('request aborted by timeout')), { once: true });
      });
    }
  });
  const pending = timeoutFailure();
  await Promise.resolve();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  const timedOut = await pending;
  assert.equal(timedOut.healthy, false);
  assert.match(timedOut.error, /timeout|aborted/i);
});

test('health is lease-independent and schema ties renewal to lease plus worker ownership', async () => {
  const [engineSource, health, schema, migration] = await Promise.all([
    readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../api/health.js', import.meta.url), 'utf8'),
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20261029100000_worker_lease_ownership.sql', import.meta.url), 'utf8')
  ]);
  const scanStart = engineSource.indexOf('  async scanOnce() {');
  const scanEnd = engineSource.indexOf('\n  async recordMemoryUsage', scanStart);
  const scanBody = engineSource.slice(scanStart, scanEnd);
  assert.doesNotMatch(scanBody, /await this\.acquireLease\(\)|await this\.releaseLease\(\)/);
  assert.match(engineSource, /renewEveryMs: 15_000/);
  assert.match(engineSource, /this\.activeScanPromise = cycle/);
  assert.match(engineSource, /Do not close scan dependencies or relinquish the lease while scanOnce/);
  assert.match(health, /const exchangeHealthy = exchangeProbe\?\.healthy === true/);
  assert.match(health, /const workerLeaseActive = Number\.isFinite\(leaseExpiresMs\) && leaseExpiresMs > nowMs/);
  assert.match(schema, /lease_id = p_lease_id and worker_id = p_worker_id/);
  assert.match(migration, /lease_id = p_lease_id and worker_id = p_worker_id/);
});
