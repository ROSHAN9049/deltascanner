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

test('Grid allowlist contains liquid crypto majors and metals but excludes stablecoins and equity tokens', () => {
  assert.deepEqual(DELTA_TESTNET_FUTURES_ALLOWLIST, [
    'BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'DOGEUSD',
    'LINKUSD', 'LTCUSD', 'AVAXUSD', 'ADAUSD', 'XAUTUSD', 'PAXGUSD'
  ]);
  for (const symbol of ['USDTUSD', 'USDCUSD', 'SNDKBUSD', 'NVDAXUSD', 'SPYXUSD']) {
    assert.equal(isAllowedDeltaTestnetFutureSymbol(symbol), false);
  }
  for (const symbol of ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD',
    'DOGEUSD', 'LINKUSD', 'LTCUSD', 'AVAXUSD', 'ADAUSD', 'XAUTUSD', 'PAXGUSD']) {
    assert.equal(isAllowedDeltaTestnetFutureSymbol(symbol), true);
  }
});

test('Grid symbol parser accepts exactly two distinct allowlisted Testnet symbols and fails closed otherwise', () => {
  assert.deepEqual(parseDeltaTestnetGridSymbols('BTCUSD,ETHUSD'), ['BTCUSD', 'ETHUSD']);
  assert.deepEqual(parseDeltaTestnetGridSymbols(' ETHUSD, BTCUSD '), ['ETHUSD', 'BTCUSD']);
  assert.deepEqual(parseDeltaTestnetGridSymbols(''), []);
  assert.throws(() => parseDeltaTestnetGridSymbols('SLVONUSD,NVDAXUSD'), /outside the Delta Testnet allowlist/);
  assert.throws(() => parseDeltaTestnetGridSymbols('BTCUSD,BTCUSD'), /distinct symbols/);
  assert.throws(() => parseDeltaTestnetGridSymbols('BTCUSD'), /exactly two/);
});

test('Testnet route requires exact allowlisted, live operational and non-reduce-only perpetual product metadata', () => {
  const valid = {
    symbol: 'XAUTUSD', id: 181689, contract_type: 'perpetual_futures',
    state: 'live', trading_status: 'operational',
    only_reduce_only_orders_allowed: false
  };
  assert.equal(isEligibleDeltaTestnetPerpetualProduct(valid), true);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'SNDKBUSD' }), false);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'BTCUSD' }), true);
  assert.equal(isEligibleDeltaTestnetPerpetualProduct({ ...valid, symbol: 'SNDKBUSD' }), false);
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
    'BTCUSD,ETHUSD,SOLUSD,BNBUSD,XAUTUSD,PAXGUSD,USDTUSD',
    'BTCUSD,ETHUSD'
  );
  assert.deepEqual(result.symbols, ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XAUTUSD', 'PAXGUSD']);
  assert.deepEqual(result.rejectedSymbols, ['USDTUSD']);
  assert.equal(result.source, 'GRID_SYMBOL_POOL');
  assert.deepEqual(DEFAULT_DELTA_TESTNET_GRID_SYMBOL_POOL, ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'DOGEUSD']);
});

test('dynamic Grid pool falls back to legacy GRID_SYMBOLS and to filtered defaults', () => {
  const legacy = resolveDeltaTestnetGridSymbolPool('', 'BTCUSD,ETHUSD');
  assert.deepEqual(legacy.symbols, ['BTCUSD', 'ETHUSD']);
  assert.equal(legacy.source, 'GRID_SYMBOLS');
  const defaults = resolveDeltaTestnetGridSymbolPool('', '');
  assert.deepEqual(defaults.symbols, ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'DOGEUSD']);
  assert.equal(defaults.source, 'DEFAULT_GRID_SYMBOL_POOL');
});

test('dynamic Grid pool rejects duplicate symbols and more than six configured entries', () => {
  assert.throws(() => resolveDeltaTestnetGridSymbolPool('BTCUSD,BTCUSD', ''), /distinct/);
  assert.throws(() => resolveDeltaTestnetGridSymbolPool('BTCUSD,ETHUSD,SOLUSD,BNBUSD,XRPUSD,DOGEUSD,LINKUSD', ''), /one and six/);
});

test('Grid concurrent symbol cap defaults to two and is bounded by pool size', () => {
  assert.equal(parseGridMaxConcurrentSymbols('', 6), 2);
  assert.equal(parseGridMaxConcurrentSymbols('', 1), 1);
  assert.equal(parseGridMaxConcurrentSymbols('3', 6), 3);
  assert.equal(parseGridMaxConcurrentSymbols('6', 4), 4);
  assert.throws(() => parseGridMaxConcurrentSymbols('0', 6), /integer from 1 to 6/);
  assert.throws(() => parseGridMaxConcurrentSymbols('2.5', 6), /integer from 1 to 6/);
});
