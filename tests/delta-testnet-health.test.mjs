import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeltaTestnetHealthProbe,
  DELTA_TESTNET_HEALTH_URL,
  DELTA_TESTNET_HEALTH_TIMEOUT_MS,
  DELTA_TESTNET_HEALTH_MAX_ATTEMPTS
} from '../server/delta-testnet-health.js';

test('Testnet health probe targets the public products API, not a guessed /health route', async () => {
  let requestedUrl = null;
  const probe = createDeltaTestnetHealthProbe({
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
  });
  const result = await probe();
  assert.equal(requestedUrl, DELTA_TESTNET_HEALTH_URL);
  assert.equal(result.healthy, true);
  assert.equal(result.status, 200);
  assert.equal(DELTA_TESTNET_HEALTH_TIMEOUT_MS, 8000);
  assert.equal(DELTA_TESTNET_HEALTH_MAX_ATTEMPTS, 3);
});

test('transient Testnet edge failures are retried before reporting unhealthy', async () => {
  let calls = 0;
  const probe = createDeltaTestnetHealthProbe({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ success: true, result: [{ symbol: 'PAXGUSD' }] }), { status: 200 });
    },
    cacheTtlMs: 0
  });
  const result = await probe();
  assert.equal(calls, 2);
  assert.equal(result.healthy, true);
  assert.equal(result.error, null);
});

test('invalid HTTP 200 payload is not misreported as healthy', async () => {
  const probe = createDeltaTestnetHealthProbe({
    fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200 })
  });
  const result = await probe();
  assert.equal(result.healthy, false);
  assert.match(result.error, /invalid health response/);
});

test('network timeout/failure retries remain bounded and fail closed', async () => {
  let calls = 0;
  const probe = createDeltaTestnetHealthProbe({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('connect ETIMEDOUT');
    },
    maxAttempts: 2,
    cacheTtlMs: 0
  });
  const result = await probe();
  assert.equal(calls, 2);
  assert.equal(result.healthy, false);
  assert.match(result.error, /ETIMEDOUT/);
});
