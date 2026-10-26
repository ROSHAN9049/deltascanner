import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectOpenPositionSymbols, selectVisibleMarketRows, selectVisibleSignalRows } from '../src/market-view.js';

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


test('signal stage rows cover both engines for the same visible top-40 coin list', () => {
  const market = [
    { symbol: 'BTCUSD' },
    { symbol: 'ETHUSD' },
    { symbol: 'SOLUSD' }
  ];
  const signals = [
    { symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'SETUP', score: 82, captured_at: '2026-10-12T09:00:00Z' },
    { symbol: 'BTCUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 91, captured_at: '2026-10-12T09:01:00Z' },
    { symbol: 'ETHUSD', strategy: 'SCALPING', stage: 'SETUP', score: 85, captured_at: '2026-10-12T09:01:00Z' },
    { symbol: 'SOLUSD', strategy: 'MOMENTUM', stage: 'CONFIRMED', score: 99, captured_at: '2026-10-12T09:01:00Z' }
  ];
  const rows = selectVisibleSignalRows(market, signals, 2);

  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.symbol), ['BTCUSD', 'BTCUSD', 'ETHUSD', 'ETHUSD']);
  assert.equal(rows.find(row => row.symbol === 'BTCUSD' && row.strategy === 'MOMENTUM').stage, 'CONFIRMED');
  const missing = rows.find(row => row.symbol === 'BTCUSD' && row.strategy === 'SCALPING');
  assert.equal(missing.stage, 'WATCH');
  assert.equal(missing.snapshot_missing, true);
  assert.equal(rows.find(row => row.symbol === 'ETHUSD' && row.strategy === 'SCALPING').stage, 'SETUP');
  assert.equal(rows.some(row => row.symbol === 'SOLUSD'), false);
});


test('only positive-quantity OPEN ledger rows appear as active symbols', () => {
  const positions = [
    { symbol: 'PAXGUSD', qty: 16, status: 'CLOSED_EXTERNALLY' },
    { symbol: 'XRPUSD', qty: -42, status: 'CLOSED_EXTERNALLY' },
    { symbol: 'ETHUSD', qty: 2, status: 'OPEN' },
    { symbol: 'BTCUSD', qty: 0, status: 'OPEN' },
    { symbol: 'SOLUSD', qty: 1, status: 'CLOSED' },
    { symbol: 'DOGEUSD', qty: 1, status: 'open' }
  ];
  assert.deepEqual([...selectOpenPositionSymbols(positions)].sort(), ['DOGEUSD', 'ETHUSD']);
});

test('open position symbol selection handles missing or invalid rows safely', () => {
  assert.deepEqual([...selectOpenPositionSymbols(null)], []);
  assert.deepEqual([...selectOpenPositionSymbols({})], []);
  assert.deepEqual([...selectOpenPositionSymbols([{ symbol: 'BTCUSD', qty: 3 }])], []);
});
