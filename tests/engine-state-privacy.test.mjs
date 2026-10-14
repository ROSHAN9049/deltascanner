import test from 'node:test';
import assert from 'node:assert/strict';
import { protectEngineState } from '../server/engine-state-privacy.js';

function sampleState() {
  return {
    settings: {
      id: 1,
      equity: 51.5,
      available_balance: 48,
      realized_pnl: 2,
      unrealized_pnl: -0.5,
      fees_today: 0.1,
      risk_pct: 0.3,
      grid_state: { positions: [{ symbol: 'ETHUSD', qty: 1 }], realizedPnl: 1 }
    },
    positions: [{ symbol: 'BTCUSD', qty: 1 }],
    trades: [{ symbol: 'ETHUSD', net_pnl: 5 }],
    ledger: [{ released: 3 }],
    counters: { total: 12 },
    daily: { trade_date: '2026-10-14', pnl: 5 },
    signalOrders: [{ raw: { private: true } }],
    signalOrderCount: 1,
    tradeRowCount: 1,
    ledgerRowCount: 1,
    signalOrderStats: { total: 1, sent: 1, pending: 0, expired: 0, failed: 0, events: 0 },
    tradetronEvents: [{ event_id: 'x' }],
    logs: [
      { id: 1, level: 'ERROR', message: 'Sensitive error', created_at: '2026-10-14T00:00:00Z', data: { internal: 'detail' } },
      {
        id: 2,
        level: 'INFO',
        message: 'Worker heartbeat scan',
        created_at: '2026-10-14T00:01:00Z',
        data: {
          reservedSignals: 3,
          signalReservationTtlMs: 900000,
          secret: 'must-not-leak',
          tradetronRouting: {
            supportedSymbols: ['btcUSD', 'ETHUSD'],
            configuredSymbols: ['BTCUSD', 'ETHUSD', 'MATICUSD'],
            unavailableMarketSymbols: ['MATICUSD'],
            marketSymbolCount: 237,
            configuredRoutes: 1,
            optionsRouteConfigured: false,
            authToken: 'must-not-leak'
          }
        }
      }
    ],
    signals: [{ symbol: 'BTCUSD', score: 90, qty_contracts: 2, notional: 50, risk_usd: 0.3, ready: true }],
    signalCache: [{ symbol: 'BTCUSD', score: 90, qty_contracts: 2, notional: 50, risk_usd: 0.3, ready: true }],
    marketCache: [{ symbol: 'BTCUSD' }],
    optionCache: [],
    tradetronDeveloperDataProtected: false,
    tradetronDeveloperSync: { status: 'OK' },
    tradetronDeveloperSnapshots: [{ pnl: -2 }],
    tradetronDeveloperNotifications: [{ title: 'Private' }],
    tradetronDeveloperPnlHistory: [{ reported_pnl: -2 }]
  };
}

test('unauthenticated state hides private ledger and marks it protected, not empty', () => {
  const state = protectEngineState(sampleState(), false);
  assert.equal(state.accountDataProtected, true);
  assert.deepEqual(state.positions, []);
  assert.deepEqual(state.trades, []);
  assert.deepEqual(state.ledger, []);
  assert.equal(state.counters, null);
  assert.equal(state.daily, null);
  assert.equal(state.tradeRowCount, null);
  assert.equal(state.ledgerRowCount, null);
  assert.equal(state.settings.equity, null);
  assert.equal(state.settings.available_balance, null);
  assert.equal(state.settings.realized_pnl, null);
  assert.equal(state.settings.unrealized_pnl, null);
  assert.equal(state.settings.fees_today, null);
  assert.equal(state.settings.grid_state, null);
  assert.equal(state.settings.risk_pct, 0.3);
  assert.deepEqual(state.signalOrderStats, {
    total: null, sent: null, pending: null, expired: null, failed: null, events: null
  });
  assert.deepEqual(state.tradetronEvents, []);
  assert.equal(state.tradetronDeveloperDataProtected, true);
  assert.deepEqual(state.tradetronDeveloperSnapshots, []);
  assert.equal(state.tradetronDeveloperSync, null);
  assert.equal(state.signals[0].symbol, 'BTCUSD');
  assert.equal(state.signals[0].qty_contracts, null);
  assert.equal(state.signals[0].notional, null);
  assert.equal(state.signals[0].risk_usd, null);
  assert.equal(state.signals[0].ready, false);
  assert.ok(state.signals[0].blocked_reasons.includes('Account sizing hidden; enter ENGINE_SECRET'));
  assert.equal(state.signalCache[0].score, 90);
  assert.equal(state.signalCache[0].qty_contracts, null);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].message, 'Worker heartbeat scan');
  assert.equal('reservedSignals' in state.logs[0].data, false);
  assert.deepEqual(state.logs[0].data.tradetronRouting.unavailableMarketSymbols, ['MATICUSD']);
  assert.equal(JSON.stringify(state).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(state).includes('Sensitive error'), false);
});

test('authenticated state remains unchanged apart from explicit access status', () => {
  const input = sampleState();
  const state = protectEngineState(input, true);
  assert.equal(state.accountDataProtected, false);
  assert.deepEqual(state.settings, input.settings);
  assert.deepEqual(state.positions, input.positions);
  assert.deepEqual(state.trades, input.trades);
  assert.deepEqual(state.logs, input.logs);
  assert.deepEqual(state.tradetronDeveloperSnapshots, input.tradetronDeveloperSnapshots);
});
