import test from 'node:test';
import assert from 'node:assert/strict';
import { protectEngineState } from '../server/engine-state-privacy.js';

function sampleState() {
  return {
    settings: {
      id: 1, equity: 52746, available_balance: 549.83, realized_pnl: 12,
      unrealized_pnl: -4, fees_today: 0.5, risk_pct: 0.3,
      grid_state: { positions: [{ symbol: 'ETHUSD', qty: 1 }] }
    },
    signals: [{ symbol: 'BTCUSD', score: 90, qty_contracts: 2, notional: 50, risk_usd: 0.3, ready: true }],
    signalCache: [{ symbol: 'BTCUSD', score: 90, qty_contracts: 2, notional: 50, risk_usd: 0.3, ready: true }],
    optionCache: [],
    marketCache: [{ symbol: 'BTCUSD' }],
    ledger: [{ released: 3 }],
    ledgerRowCount: 1,
    logs: [
      { id: 1, level: 'ERROR', message: 'Sensitive error', created_at: '2026-10-14T00:00:00Z', data: { internal: 'private-detail' } },
      {
        id: 2, level: 'INFO', message: 'Worker heartbeat scan',
        created_at: '2026-10-14T00:01:00Z',
        data: {
          deltaExecutionMode: 'testnet', deltaEnvironment: 'TESTNET',
          lastTickAt: '2026-10-14T00:01:00Z', privateToken: 'must-not-leak',
          gridEntrySafety: { configured: false, trusted: null, blocked: true, reason: 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET', blockingQty: 2 }
        }
      }
    ],
    executionCoverage: {
      directDeltaExecutionEnabled: false, deltaExecutionMode: 'testnet',
      deltaExecutionModeSource: 'supabase-worker-heartbeat',
      gridEntrySafety: { configured: false, trusted: null, blocked: true, reason: 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET' }
    },
    deltaTestnetPositions: [{ symbol: 'ETHUSD', qty: 2 }],
    deltaTestnetOpenPositionCount: 2,
    deltaTestnetOrders: [{ symbol: 'ETHUSD', state: 'open' }],
    deltaTestnetOrderCount: 1,
    deltaTestnetTrades: [{ symbol: 'BTCUSD', realized_pnl: 5 }],
    deltaTestnetTradeRowCount: 1,
    deltaTestnetClosedTodayCount: 1,
    deltaTestnetClosedTodayPnl: 5,
    deltaTestnetClosedTodayPnlComplete: true
  };
}

test('unauthenticated response redacts account ledgers while keeping public market/signal data', () => {
  const state = protectEngineState(sampleState(), false);
  assert.equal(state.accountDataProtected, true);
  assert.equal(state.settings.equity, null);
  assert.equal(state.settings.available_balance, null);
  assert.equal(state.settings.grid_state, null);
  assert.equal(state.settings.risk_pct, 0.3);
  assert.deepEqual(state.ledger, []);
  assert.equal(state.ledgerRowCount, null);
  assert.deepEqual(state.deltaTestnetPositions, []);
  assert.equal(state.deltaTestnetOpenPositionCount, null);
  assert.deepEqual(state.deltaTestnetOrders, []);
  assert.equal(state.deltaTestnetOrderCount, null);
  assert.deepEqual(state.deltaTestnetTrades, []);
  assert.equal(state.deltaTestnetTradeRowCount, null);
  assert.equal(state.deltaTestnetClosedTodayCount, null);
  assert.equal(state.deltaTestnetClosedTodayPnl, null);
  assert.equal(state.deltaTestnetClosedTodayPnlComplete, false);
  assert.equal(state.signals[0].symbol, 'BTCUSD');
  assert.equal(state.signals[0].qty_contracts, null);
  assert.equal(state.signals[0].notional, null);
  assert.equal(state.signals[0].ready, false);
  assert.ok(state.signals[0].blocked_reasons.includes('Account sizing hidden; enter ENGINE_SECRET'));
  assert.equal(state.signalCache[0].qty_contracts, null);
  assert.equal(state.marketCache.length, 1);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].message, 'Worker heartbeat scan');
  assert.equal(state.logs[0].data.deltaExecutionMode, 'testnet');
  assert.equal('blockingQty' in state.logs[0].data.gridEntrySafety, false);
  assert.equal(JSON.stringify(state).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(state).includes('private-detail'), false);
});

test('authenticated response preserves Delta Testnet ledgers and settings', () => {
  const input = sampleState();
  const state = protectEngineState(input, true);
  assert.equal(state.accountDataProtected, false);
  assert.deepEqual(state.settings, input.settings);
  assert.deepEqual(state.deltaTestnetPositions, input.deltaTestnetPositions);
  assert.deepEqual(state.deltaTestnetOrders, input.deltaTestnetOrders);
  assert.deepEqual(state.deltaTestnetTrades, input.deltaTestnetTrades);
  assert.deepEqual(state.logs, input.logs);
});
