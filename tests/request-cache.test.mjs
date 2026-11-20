import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlSingleFlightCache } from '../server/request-cache.js';

test('cache reuses a value until its TTL expires', async () => {
  let now = 1000;
  let loads = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 15_000, now: () => now });
  const loader = async () => ({ sequence: ++loads });
  assert.deepEqual(await cache.get('private', loader), { sequence: 1 });
  now += 10_000;
  assert.deepEqual(await cache.get('private', loader), { sequence: 1 });
  assert.equal(loads, 1);
  now += 5_001;
  assert.deepEqual(await cache.get('private', loader), { sequence: 2 });
  assert.equal(loads, 2);
});

test('concurrent misses share one in-flight database load', async () => {
  let loads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createTtlSingleFlightCache({ ttlMs: 15_000 });
  const loader = async () => {
    loads += 1;
    await gate;
    return { ok: true };
  };
  const first = cache.get('public', loader);
  const second = cache.get('public', loader);
  await Promise.resolve();
  assert.equal(loads, 1);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(loads, 1);
});

test('public and private cache keys cannot share account-specific payloads', async () => {
  let loads = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 15_000 });
  assert.deepEqual(await cache.get('public', async () => ({ accountDataProtected: true, n: ++loads })),
    { accountDataProtected: true, n: 1 });
  assert.deepEqual(await cache.get('private', async () => ({ accountDataProtected: false, n: ++loads })),
    { accountDataProtected: false, n: 2 });
  assert.deepEqual(await cache.get('public', async () => ({ n: ++loads })),
    { accountDataProtected: true, n: 1 });
});

test('failed loads are not cached and can be retried', async () => {
  let attempts = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 15_000 });
  await assert.rejects(cache.get('public', async () => {
    attempts += 1;
    throw new Error('db unavailable');
  }), /db unavailable/);
  assert.deepEqual(await cache.get('public', async () => {
    attempts += 1;
    return { ok: true };
  }), { ok: true });
  assert.equal(attempts, 2);
});


test('stale-if-error serves the last good value without extending its age', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = createTtlSingleFlightCache({ ttlMs: 100, now: () => now });
  const loader = async () => ({ sequence: ++loads });
  assert.deepEqual(await cache.get('public', loader), { sequence: 1 });
  now += 150;
  assert.deepEqual(await cache.get('public', async () => {
    loads += 1;
    throw new Error('database timeout');
  }, { staleIfErrorMs: 500 }), { sequence: 1 });
  assert.equal(loads, 2);
  now += 300;
  assert.deepEqual(await cache.get('public', async () => {
    loads += 1;
    throw new Error('database timeout');
  }, { staleIfErrorMs: 500 }), { sequence: 1 });
  now += 100;
  await assert.rejects(cache.get('public', async () => {
    loads += 1;
    throw new Error('database timeout');
  }, { staleIfErrorMs: 500 }), /database timeout/);
});

test('stale-if-error never returns an expired safety value after its max age', async () => {
  let now = 1_000;
  const cache = createTtlSingleFlightCache({ ttlMs: 50, now: () => now });
  await cache.get('settings', async () => ({ emergencyStop: false }));
  now += 1_001;
  await assert.rejects(cache.get('settings', async () => {
    throw new Error('settings unavailable');
  }, { staleIfErrorMs: 1_000 }), /settings unavailable/);
});
