import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELTA_INDIA_LIVE_PUBLIC_REST,
  DELTA_INDIA_TESTNET_REST,
  resolveHybridDeltaRequest
} from '../worker/hybrid-market-policy.mjs';

test('public market data is anonymous and production India only', () => {
  assert.deepEqual(resolveHybridDeltaRequest({ method: 'GET' }), {
    base: DELTA_INDIA_LIVE_PUBLIC_REST,
    purpose: 'LIVE_PUBLIC_MARKET_DATA'
  });
});

test('authenticated execution and account traffic is fixed to Testnet', () => {
  assert.deepEqual(resolveHybridDeltaRequest({ method: 'POST', authenticated: true }), {
    base: DELTA_INDIA_TESTNET_REST,
    purpose: 'DEMO_EXECUTION_OR_ACCOUNT'
  });
});

test('Testnet product metadata is read-only and remains separate from live quotes', () => {
  assert.deepEqual(resolveHybridDeltaRequest({ method: 'GET', executionMetadata: true }), {
    base: DELTA_INDIA_TESTNET_REST,
    purpose: 'DEMO_EXECUTION_METADATA'
  });
});

test('anonymous writes are rejected instead of reaching production', () => {
  assert.throws(() => resolveHybridDeltaRequest({ method: 'POST' }), /read-only GET/);
  assert.throws(() => resolveHybridDeltaRequest({ method: 'DELETE' }), /read-only GET/);
});

test('authenticated requests reject any non-Testnet execution host', () => {
  assert.throws(() => resolveHybridDeltaRequest({
    method: 'POST', authenticated: true, testnetBase: DELTA_INDIA_LIVE_PUBLIC_REST
  }), /restricted to India Testnet/);
});
