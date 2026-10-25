import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DELTA_TESTNET_PRIVATE_API_RETRY_MS,
  canExecuteDeltaTestnetOrders,
  checkDeltaTestnetPrivateApi,
  isPrivateApiConnectivityError
} from '../worker/execution/testnet-private-api-health.mjs';

test('private API retry interval is five minutes', () => {
  assert.equal(DELTA_TESTNET_PRIVATE_API_RETRY_MS, 300_000);
});

test('Testnet order execution stays locked until private API health is confirmed', () => {
  assert.equal(canExecuteDeltaTestnetOrders('testnet', false), false);
  assert.equal(canExecuteDeltaTestnetOrders('testnet', undefined), false);
  assert.equal(canExecuteDeltaTestnetOrders('testnet', true), true);
  assert.equal(canExecuteDeltaTestnetOrders('disabled', false), true);
});

test('private API probe requires both wallet and positions checks', async () => {
  const calls = [];
  const result = await checkDeltaTestnetPrivateApi({
    async getAccountSnapshot() {
      calls.push('wallet');
      return { equity: 100, available: 50 };
    },
    async getOpenPositions() {
      calls.push('positions');
      return [{ symbol: 'ETHUSD' }];
    }
  });
  assert.deepEqual(calls.sort(), ['positions', 'wallet']);
  assert.equal(result.account.equity, 100);
  assert.equal(result.positions.length, 1);
});

test('private API probe fails when either authenticated endpoint fails', async () => {
  await assert.rejects(
    checkDeltaTestnetPrivateApi({
      async getAccountSnapshot() { throw new Error('401 ip_not_whitelisted_for_api_key'); },
      async getOpenPositions() { return []; }
    }),
    /ip_not_whitelisted_for_api_key/
  );
  await assert.rejects(
    checkDeltaTestnetPrivateApi({
      async getAccountSnapshot() { return { equity: 100 }; },
      async getOpenPositions() { throw new Error('positions unavailable'); }
    }),
    /positions unavailable/
  );
});

test('private API auth and network errors trigger fail-closed recovery handling', () => {
  assert.equal(isPrivateApiConnectivityError(new Error('401 ip_not_whitelisted_for_api_key')), true);
  assert.equal(isPrivateApiConnectivityError(Object.assign(new Error('upstream failed'), { status: 503 })), true);
  assert.equal(isPrivateApiConnectivityError(new Error('Order size below minimum')), false);
});


test('worker startup remains scan-only on private API failure and retries every five minutes', async () => {
  const index = await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  assert.match(index, /await verifyDeltaTestnetPrivateApi\('startup'\)/);
  assert.match(index, /setInterval\(\(\) => \{/);
  assert.match(index, /DELTA_TESTNET_PRIVATE_API_RETRY_MS/);
  assert.match(index, /Private Delta Testnet API unavailable\. Continuing in SCAN-ONLY mode\./);
  const privatePreflight = index.slice(
    index.indexOf("if (CONFIG.deltaExecutionMode === 'testnet') {", index.indexOf('async function startupPreflight')),
    index.indexOf("} else if (CONFIG.tradetronBridgeEnabled)", index.indexOf('async function startupPreflight'))
  );
  assert.doesNotMatch(privatePreflight, /process\.exit\(1\)/);
});

test('engine blocks Testnet entries and keeps scanning with an unavailable account snapshot', async () => {
  const engine = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /canExecuteDeltaTestnetOrders\(CONFIG\.deltaExecutionMode, this\.privateExecutionAvailable\)/);
  assert.match(engine, /equity: 0, available: 0, unrealized: 0, positions: \[\], privateApiAvailable: false/);
  assert.match(engine, /Delta Testnet entries blocked: private API is unavailable/);
});
