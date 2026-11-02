import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELTA_TESTNET_FUTURES_ALLOWLIST,
  DELTA_TESTNET_MARKET_TICK_MAX_AGE_MS,
  canStartWorkerInExecutionProfile,
  isAllowedDeltaTestnetFutureSymbol,
  isEligibleDeltaTestnetPerpetualProduct,
  isMarketTickFresh,
  resolveDirectDeltaExecutionEnabled
} from '../worker/execution/execution-route-policy.mjs';

test('direct order routing requires both the explicit TESTNET environment and testnet execution mode', () => {
  assert.equal(resolveDirectDeltaExecutionEnabled('TESTNET', 'testnet'), true);
  assert.equal(resolveDirectDeltaExecutionEnabled('SIGNAL_ONLY', 'testnet'), false);
  assert.equal(resolveDirectDeltaExecutionEnabled('TESTNET', 'disabled'), false);
  assert.equal(resolveDirectDeltaExecutionEnabled('LIVE', 'live'), false);
});

test('worker startup permits scan-only or explicit Testnet profiles and rejects mixed/production profiles', () => {
  assert.equal(canStartWorkerInExecutionProfile({
    environment: 'SIGNAL_ONLY', deltaExecutionMode: 'testnet',
    directDeltaExecutionEnabled: false
  }), true);
  assert.equal(canStartWorkerInExecutionProfile({
    environment: 'TESTNET', deltaExecutionMode: 'testnet',
    directDeltaExecutionEnabled: true
  }), true);
  assert.equal(canStartWorkerInExecutionProfile({
    environment: 'TESTNET', deltaExecutionMode: 'disabled',
    directDeltaExecutionEnabled: false
  }), false);
  assert.equal(canStartWorkerInExecutionProfile({
    environment: 'SIGNAL_ONLY', deltaExecutionMode: 'testnet',
    directDeltaExecutionEnabled: true
  }), false);
  assert.equal(canStartWorkerInExecutionProfile({
    environment: 'TESTNET', deltaExecutionMode: 'testnet',
    directDeltaExecutionEnabled: true, githubActionsPublicScanOnly: true
  }), false);
});

test('the Testnet futures allowlist contains only the nine explicitly approved symbols', () => {
  assert.deepEqual(DELTA_TESTNET_FUTURES_ALLOWLIST, [
    'DOGSUSD', 'USOONUSD', 'SNDKBUSD', 'SPYXUSD', 'QQQXUSD',
    'XAUTUSD', 'PAXGUSD', 'NVDAXUSD', '1000SHIBUSD'
  ]);
  assert.equal(isAllowedDeltaTestnetFutureSymbol('XAUTUSD'), true);
  assert.equal(isAllowedDeltaTestnetFutureSymbol('BTCUSD'), false);
  assert.equal(isAllowedDeltaTestnetFutureSymbol('ETHUSD'), false);
  assert.equal(isAllowedDeltaTestnetFutureSymbol('SOLUSD'), false);
});

test('Testnet route requires exact allowlisted, live operational and non-reduce-only perpetual product metadata', () => {
  const valid = {
    symbol: 'XAUTUSD', id: 181689, contract_type: 'perpetual_futures',
    state: 'live', trading_status: 'operational',
    only_reduce_only_orders_allowed: false
  };
  assert.equal(isEligibleDeltaTestnetPerpetualProduct(valid), true);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'BTCUSD' }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, id: null }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, trading_status: 'suspended' }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, only_reduce_only_orders_allowed: true }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, only_reduce_only_orders_allowed: undefined }), false);
});

test('freshness gate rejects missing, stale, or materially future market ticks', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  assert.equal(DELTA_TESTNET_MARKET_TICK_MAX_AGE_MS, 180000);
  assert.equal(isMarketTickFresh('2026-11-02T09:59:00Z', now), true);
  assert.equal(isMarketTickFresh('2026-11-02T09:56:59Z', now), false);
  assert.equal(isMarketTickFresh(null, now), false);
  assert.equal(isMarketTickFresh('2026-11-02T10:01:00Z', now), false);
});
