import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectVisibleMarketRows } from '../src/market-view.js';

test('dashboard limits the visible list to the top 40 while retaining the complete source universe', () => {
  const market = Array.from({ length: 231 }, (_, index) => ({
    symbol: 'COIN' + index + 'USD',
    market_rank: index + 1,
    turnover_usd: 231 - index
  }));

  const visible = selectVisibleMarketRows(market);

  assert.equal(DEFAULT_VISIBLE_MARKET_LIMIT, 40);
  assert.equal(visible.length, 40);
  assert.equal(visible[0].symbol, 'COIN0USD');
  assert.equal(visible.at(-1).symbol, 'COIN39USD');
  assert.deepEqual(visible, market.slice(0, 40));
  assert.equal(market.length, 231);
});

test('visible market selection preserves server ranking and never mutates the source', () => {
  const market = [{ symbol: 'BTCUSD' }, { symbol: 'ETHUSD' }, { symbol: 'SOLUSD' }];
  const snapshot = structuredClone(market);

  assert.deepEqual(selectVisibleMarketRows(market, 2), market.slice(0, 2));
  assert.deepEqual(market, snapshot);
  assert.deepEqual(selectVisibleMarketRows(market, 0), []);
});

test('invalid market payloads and limits fail safely', () => {
  assert.deepEqual(selectVisibleMarketRows(null), []);
  assert.deepEqual(selectVisibleMarketRows({}), []);
  assert.equal(selectVisibleMarketRows(Array.from({ length: 50 }, (_, i) => i), Number.NaN).length, 40);
});
