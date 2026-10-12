import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectVisibleMarketRows } from '../src/market-view.js';

test('the visible list shows only the top 40 without changing the complete universe', () => {
  const market = Array.from({ length: 231 }, (_, i) => ({
    symbol: 'COIN' + i + 'USD',
    market_rank: i + 1,
    turnover_usd: 231 - i
  }));
  const visible = selectVisibleMarketRows(market);
  assert.equal(DEFAULT_VISIBLE_MARKET_LIMIT, 40);
  assert.equal(visible.length, 40);
  assert.equal(visible[0].symbol, 'COIN0USD');
  assert.equal(visible[39].symbol, 'COIN39USD');
  assert.deepEqual(visible, market.slice(0, 40));
  assert.equal(market.length, 231);
});

test('visible selection preserves API ranking and does not mutate input', () => {
  const market = [{ symbol: 'BTCUSD' }, { symbol: 'ETHUSD' }, { symbol: 'SOLUSD' }];
  const original = structuredClone(market);
  assert.deepEqual(selectVisibleMarketRows(market, 2), market.slice(0, 2));
  assert.deepEqual(market, original);
  assert.deepEqual(selectVisibleMarketRows(market, 0), []);
});

test('invalid payloads fail safely and invalid limits use the default', () => {
  assert.deepEqual(selectVisibleMarketRows(null), []);
  assert.deepEqual(selectVisibleMarketRows({}), []);
  assert.equal(selectVisibleMarketRows(Array.from({ length: 50 }, (_, i) => i), Number.NaN).length, 40);
});
