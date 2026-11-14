import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELTA_TESTNET_FUTURES_ALLOWLIST,
  DELTA_TESTNET_MARKET_TICK_MAX_AGE_MS,
  canStartWorkerInExecutionProfile,
  isAllowedDeltaTestnetFutureSymbol,
  parseDeltaTestnetGridSymbols,
  isEligibleDeltaTestnetPerpetualProduct,
  isMarketTickFresh,
  resolveDirectDeltaExecutionEnabled,
  DEFAULT_DELTA_TESTNET_GRID_SYMBOL_POOL,
  resolveDeltaTestnetGridSymbolPool,
  parseGridMaxConcurrentSymbols
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

test('the Testnet futures allowlist contains only the nine supported futures routes', () => {
  assert.deepEqual(DELTA_TESTNET_FUTURES_ALLOWLIST, [
    'DOGSUSD', 'USOONUSD', 'SNDKBUSD', 'SPYXUSD', 'QQQXUSD',
    'XAUTUSD', 'PAXGUSD', 'NVDAXUSD', '1000SHIBUSD'
  ]);
  for (const symbol of ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD']) {
    assert.equal(isAllowedDeltaTestnetFutureSymbol(symbol), false);
  }
  assert.equal(isAllowedDeltaTestnetFutureSymbol('XAUTUSD'), true);
});

test('Grid symbol parser accepts exactly two distinct allowlisted Testnet symbols and fails closed otherwise', () => {
  assert.deepEqual(parseDeltaTestnetGridSymbols('PAXGUSD,NVDAXUSD'), ['PAXGUSD', 'NVDAXUSD']);
  assert.deepEqual(parseDeltaTestnetGridSymbols(' NVDAXUSD, PAXGUSD '), ['NVDAXUSD', 'PAXGUSD']);
  assert.deepEqual(parseDeltaTestnetGridSymbols(''), []);
  assert.throws(() => parseDeltaTestnetGridSymbols('SLVONUSD,NVDAXUSD'), /outside the Delta Testnet allowlist/);
  assert.throws(() => parseDeltaTestnetGridSymbols('PAXGUSD,PAXGUSD'), /distinct symbols/);
  assert.throws(() => parseDeltaTestnetGridSymbols('PAXGUSD'), /exactly two/);
});

test('Testnet route requires exact allowlisted, live operational and non-reduce-only perpetual product metadata', () => {
  const valid = {
    symbol: 'XAUTUSD', id: 181689, contract_type: 'perpetual_futures',
    state: 'live', trading_status: 'operational',
    only_reduce_only_orders_allowed: false
  };
  assert.equal(isEligibleDeltaTestnetPerpetualProduct(valid), true);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'BTCUSD' }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'ETHUSD', state: 'prelaunch' }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'SOLUSD', trading_status: 'suspended' }), false);
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


test('dynamic Grid pool filters unsupported requested symbols against the Testnet allowlist', () => {
  const result = resolveDeltaTestnetGridSymbolPool(
    'PAXGUSD,NVDAXUSD,SPYXUSD,XAUTUSD,SLVONUSD,ADAUSD',
    'PAXGUSD,NVDAXUSD'
  );
  assert.deepEqual(result.symbols, ['PAXGUSD', 'NVDAXUSD', 'SPYXUSD', 'XAUTUSD']);
  assert.deepEqual(result.rejectedSymbols, ['SLVONUSD', 'ADAUSD']);
  assert.equal(result.source, 'GRID_SYMBOL_POOL');
  assert.equal(DEFAULT_DELTA_TESTNET_GRID_SYMBOL_POOL.length, 4);
});

test('dynamic Grid pool falls back to legacy GRID_SYMBOLS and to filtered defaults', () => {
  const legacy = resolveDeltaTestnetGridSymbolPool('', 'PAXGUSD,NVDAXUSD');
  assert.deepEqual(legacy.symbols, ['PAXGUSD', 'NVDAXUSD']);
  assert.equal(legacy.source, 'GRID_SYMBOLS');
  const defaults = resolveDeltaTestnetGridSymbolPool('', '');
  assert.deepEqual(defaults.symbols, ['PAXGUSD', 'NVDAXUSD', 'SPYXUSD', 'XAUTUSD']);
  assert.equal(defaults.source, 'DEFAULT_GRID_SYMBOL_POOL');
});

test('dynamic Grid pool rejects duplicate symbols and more than six configured entries', () => {
  assert.throws(() => resolveDeltaTestnetGridSymbolPool('PAXGUSD,PAXGUSD', ''), /distinct/);
  assert.throws(() => resolveDeltaTestnetGridSymbolPool('PAXGUSD,NVDAXUSD,SPYXUSD,XAUTUSD,DOGSUSD,USOONUSD,QQQXUSD', ''), /one and six/);
});

test('Grid concurrent symbol cap defaults to two and is bounded by pool size', () => {
  assert.equal(parseGridMaxConcurrentSymbols('', 6), 2);
  assert.equal(parseGridMaxConcurrentSymbols('', 1), 1);
  assert.equal(parseGridMaxConcurrentSymbols('3', 6), 3);
  assert.equal(parseGridMaxConcurrentSymbols('6', 4), 4);
  assert.throws(() => parseGridMaxConcurrentSymbols('0', 6), /integer from 1 to 6/);
  assert.throws(() => parseGridMaxConcurrentSymbols('2.5', 6), /integer from 1 to 6/);
});
