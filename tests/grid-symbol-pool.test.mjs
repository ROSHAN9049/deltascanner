import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGridSymbolOwnership,
  gridSymbolMarketMetrics,
  rankGridSymbolCandidates,
  selectGridSymbolsByPriority
} from '../shared/grid-symbol-pool.js';

test('Grid ownership marks a symbol with an open Momentum or Scalping Futures row as blocked', () => {
  const result = classifyGridSymbolOwnership({
    symbol: 'PAXGUSD',
    exchangePositions: [{
      id: 119, symbol: 'PAXGUSD', side: 'SELL', qty: 61,
      entry_price: 4089.23, client_order_id: 'SCALP-ENTRY'
    }],
    databasePositions: [{
      id: 119, symbol: 'PAXGUSD', strategy: 'SCALPING',
      side: 'SELL', qty: 61, entry_price: 4089.23,
      entry_order_id: '2177855282'
    }]
  });
  assert.equal(result.owner, 'FUTURES');
  assert.equal(result.blocked, true);
  assert.equal(result.position.id, 119);
  assert.equal(result.position.orderId, '2177855282');
  assert.equal(result.position.strategy, 'SCALPING');
});

test('Grid ownership distinguishes Grid-owned exposure from Futures-owned exposure', () => {
  const grid = classifyGridSymbolOwnership({
    symbol: 'NVDAXUSD',
    exchangePositions: [{
      symbol: 'NVDAXUSD', side: 'BUY', qty: 2,
      entry_price: 180, client_order_id: 'DDG-NVDAXUSD-ENTRY'
    }],
    databasePositions: [{
      id: 12, symbol: 'NVDAXUSD', strategy: 'GRID',
      side: 'BUY', qty: 2, entry_price: 180,
      client_order_id: 'DDG-NVDAXUSD-ENTRY'
    }]
  });
  assert.equal(grid.owner, 'GRID');
  assert.equal(grid.blocked, false);

  const flat = classifyGridSymbolOwnership({
    symbol: 'NVDAXUSD', exchangePositions: [], databasePositions: []
  });
  assert.equal(flat.owner, 'NONE');
  assert.equal(flat.blocked, false);
});

test('Grid candidate metrics use ATR status, USD turnover, and bid/ask spread', () => {
  const metrics = gridSymbolMarketMetrics('XAUTUSD', {
    ticker: {
      turnover_usd: 250000,
      quotes: { best_bid: 100, best_ask: 101 }
    },
    config: { atr_snapshot_status: 'READY', atr_14d: 5, atr_pct: 2.5 }
  });
  assert.equal(metrics.symbol, 'XAUTUSD');
  assert.equal(metrics.atrReady, true);
  assert.equal(metrics.turnover24hUsd, 250000);
  assert.ok(metrics.spreadPct > 0);
});

test('Grid priority prefers ATR READY, then highest turnover, then tightest spread', () => {
  const ranked = rankGridSymbolCandidates([
    { symbol: 'PAXGUSD', atrReady: true, turnover24hUsd: 500, spreadPct: 0.1 },
    { symbol: 'NVDAXUSD', atrReady: false, turnover24hUsd: 9999, spreadPct: 0.01 },
    { symbol: 'SPYXUSD', atrReady: true, turnover24hUsd: 900, spreadPct: 0.2 },
    { symbol: 'XAUTUSD', atrReady: true, turnover24hUsd: 900, spreadPct: 0.05 }
  ]);
  assert.deepEqual(ranked.map(row => row.symbol), [
    'XAUTUSD', 'SPYXUSD', 'PAXGUSD', 'NVDAXUSD'
  ]);
  assert.deepEqual(selectGridSymbolsByPriority(ranked, 2), ['XAUTUSD', 'SPYXUSD']);
});
