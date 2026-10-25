import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT,
  MAX_CANDLE_CACHE_SYMBOL_LIMIT,
  MIN_CANDLE_CACHE_SYMBOL_LIMIT,
  pruneCandleCacheState,
  resolveCandleCacheSymbolLimit,
  selectTopCandleSymbols,
  shouldRetainCandleCacheKey
} from '../worker/candle-cache-policy.mjs';

test('candle cache defaults to 70 symbols and accepts only 50–80', () => {
  assert.equal(DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT, 70);
  assert.equal(resolveCandleCacheSymbolLimit(undefined), 70);
  assert.equal(resolveCandleCacheSymbolLimit('50'), MIN_CANDLE_CACHE_SYMBOL_LIMIT);
  assert.equal(resolveCandleCacheSymbolLimit('80'), MAX_CANDLE_CACHE_SYMBOL_LIMIT);
  assert.equal(resolveCandleCacheSymbolLimit('49'), 70);
  assert.equal(resolveCandleCacheSymbolLimit('81'), 70);
  assert.equal(resolveCandleCacheSymbolLimit('bad'), 70);
});

test('selects the highest-turnover symbols without duplicates', () => {
  const symbols = selectTopCandleSymbols([
    { symbol: 'lowUSD', turnover_usd: 10 },
    { symbol: 'highUSD', turnover_usd: 100 },
    { symbol: 'midUSD', turnover_usd: 50 },
    { symbol: 'HIGHUSD', turnover_usd: 90 }
  ], 50);
  assert.deepEqual([...symbols], ['HIGHUSD', 'MIDUSD', 'LOWUSD']);
});

test('retains only selected 1m/5m/15m series plus the BTC hourly regime', () => {
  const selected = new Set(['BTCUSD', 'ETHUSD']);
  assert.equal(shouldRetainCandleCacheKey('1m:BTCUSD', selected), true);
  assert.equal(shouldRetainCandleCacheKey('15m:ETHUSD', selected), true);
  assert.equal(shouldRetainCandleCacheKey('5m:SNDKBUSD', selected), false);
  assert.equal(shouldRetainCandleCacheKey('1h:BTCUSD', selected), true);
  assert.equal(shouldRetainCandleCacheKey('1h:ETHUSD', selected), false);
  assert.equal(shouldRetainCandleCacheKey('options:BTCUSD', selected), false);
});

test('prunes candle series, per-series metadata, and healing keys outside the selected universe', () => {
  const candles = new Map([
    ['1m:BTCUSD', [1, 2]],
    ['5m:ETHUSD', [1, 2]],
    ['15m:LOWUSD', [1, 2]],
    ['1h:BTCUSD', [1, 2]]
  ]);
  const metadata = new Map([
    ['1m:BTCUSD', 1],
    ['15m:LOWUSD', 2],
    ['5m:LOWUSD', 3]
  ]);
  const inFlight = new Set(['1m:BTCUSD', '15m:LOWUSD']);
  const result = pruneCandleCacheState({
    candles,
    eligibleSymbols: new Set(['BTCUSD', 'ETHUSD']),
    metadataMaps: [metadata],
    healingInFlight: inFlight
  });
  assert.deepEqual(result, { removedSeries: 1, removedMetadataEntries: 2, removedHealingKeys: 1 });
  assert.deepEqual([...candles.keys()].sort(), ['1h:BTCUSD', '1m:BTCUSD', '5m:ETHUSD']);
  assert.deepEqual([...metadata.keys()], ['1m:BTCUSD']);
  assert.deepEqual([...inFlight], ['1m:BTCUSD']);
});
