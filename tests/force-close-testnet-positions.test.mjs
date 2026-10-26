import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTestnetOnly,
  createTestnetClient,
  DELTA_TESTNET_REST_BASE,
  normalizeOpenPosition,
  runForceClose
} from '../scripts/force-close-testnet-positions.mjs';

const env = overrides => ({
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_TESTNET_REST_BASE: DELTA_TESTNET_REST_BASE,
  DELTA_TESTNET_API_KEY: 'demo-key-not-real',
  DELTA_TESTNET_API_SECRET: 'demo-secret-not-real',
  ...overrides
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('force close requires Testnet mode, fixed Testnet endpoint, and credentials', () => {
  assert.deepEqual(assertTestnetOnly(env()), {
    apiKey: 'demo-key-not-real',
    apiSecret: 'demo-secret-not-real'
  });
  assert.throws(() => assertTestnetOnly(env({ DELTA_EXECUTION_MODE: 'disabled' })), /must be exactly testnet/);
  assert.throws(() => assertTestnetOnly(env({ DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange' })), /hardcoded Delta Testnet host/);
  assert.throws(() => assertTestnetOnly(env({ DELTA_TESTNET_API_SECRET: '' })), /API_KEY and DELTA_TESTNET_API_SECRET/);
});

test('normalizer selects opposite close side and refuses ambiguous/fractional sizes', () => {
  assert.deepEqual(normalizeOpenPosition({
    product_symbol: 'PAXGUSD', size: '2', product_id: 41
  }), {
    symbol: 'PAXGUSD', qty: 2, direction: 'LONG', closeSide: 'sell', productId: 41
  });
  assert.deepEqual(normalizeOpenPosition({
    product_symbol: 'XRPUSD', size: '-7', product_id: 42
  }), {
    symbol: 'XRPUSD', qty: 7, direction: 'SHORT', closeSide: 'buy', productId: 42
  });
  assert.throws(() => normalizeOpenPosition({ symbol: 'BTCUSD', qty: 1 }), /no reliable side/);
  assert.throws(() => normalizeOpenPosition({ symbol: 'BTCUSD', size: '1.5', product_id: 1 }), /non-integer/);
});

test('missing --confirm refuses before any HTTP request', async () => {
  let calls = 0;
  await assert.rejects(
    runForceClose({
      env: env(),
      argv: [],
      fetchImpl: async () => { calls += 1; throw new Error('must not call network'); }
    }),
    /No orders sent/
  );
  assert.equal(calls, 0);
});

test('force close sends a signed Testnet reduce-only market order per open position and verifies flat', async () => {
  const positions = [
    { product_symbol: 'PAXGUSD', size: '2', product_id: 41 },
    { product_symbol: 'XRPUSD', size: '-7', product_id: 42 }
  ];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, headers: init.headers });
    assert.equal(parsed.origin, DELTA_TESTNET_REST_BASE);
    if (parsed.pathname === '/v2/positions/margined' && init.method === 'GET') {
      return response({ success: true, result: positions.map(row => ({ ...row })) });
    }
    if (parsed.pathname === '/v2/orders' && init.method === 'POST') {
      assert.equal(body.order_type, 'market_order');
      assert.equal(body.reduce_only, true);
      const existing = positions.find(row => Number(row.product_id) === body.product_id);
      assert.ok(existing, 'close order product must refer to an actual open Testnet position');
      const actualSize = Number(existing.size);
      assert.equal(body.size, Math.abs(actualSize));
      assert.equal(body.side, actualSize > 0 ? 'sell' : 'buy');
      existing.size = '0';
      return response({ success: true, result: { id: 9000 + body.product_id, state: 'closed' } });
    }
    throw new Error('Unexpected request ' + init.method + ' ' + parsed.pathname);
  };
  const logs = [];
  const result = await runForceClose({
    env: env(),
    argv: ['--confirm'],
    fetchImpl,
    now: () => 1770000000000,
    sleepImpl: async () => {},
    log: message => logs.push(String(message)),
    warn: message => logs.push(String(message)),
    verifyTimeoutMs: 100
  });

  const posts = calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/orders');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(call => call.body.product_id).sort(), [41, 42]);
  assert.ok(posts.every(call => call.body.reduce_only === true && call.body.order_type === 'market_order'));
  assert.ok(posts.every(call => /^[0-9a-f]{64}$/.test(call.headers.signature)));
  assert.equal(result.closeOrdersSubmitted, 2);
  assert.equal(result.verifiedFlat, true);
  assert.equal(result.remainingPositions.length, 0);
  assert.ok(logs.some(line => line.includes('Final verification: open positions=0')));
});

test('malformed position snapshot fails closed and sends no orders', async () => {
  const calls = [];
  const client = createTestnetClient({
    env: env(),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method });
      return response({ success: true, result: { not: 'an array' } });
    }
  });
  await assert.rejects(client.getOpenPositions(), /response is malformed/);
  assert.equal(calls.length, 1);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('API error on initial snapshot fails before any order submission', async () => {
  const calls = [];
  await assert.rejects(
    runForceClose({
      env: env(),
      argv: ['--confirm'],
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, method: init.method });
        return response({ success: false, error: { code: 'test_api_unavailable' } }, 503);
      },
      log: () => {},
      warn: () => {}
    }),
    /failed \(503\): test_api_unavailable/
  );
  assert.equal(calls.some(call => call.method === 'POST'), false);
});
