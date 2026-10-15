import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradetronPositionReconciliation } from '../src/tradetron-reconciliation.js';

const deployment = (positions, asOf = '2026-10-15T12:00:00.000Z') => [{
  deployment_id: 7,
  deployment_name: 'Signal Bridge',
  open_positions: positions.length,
  positions_hidden: false,
  as_of: asOf,
  last_success_at: asOf,
  positions
}];

const signal = ({ symbol, side, size = 1, createdAt = '2026-10-15T11:00:00.000Z', state = 'EXPIRED', accepted = true }) => ({
  id: 'signal-' + symbol + '-' + side + '-' + createdAt,
  symbol,
  side,
  size,
  state,
  created_at: createdAt,
  raw: { bridge_accepted: accepted, bridge_response: accepted ? 'Ok' : 'Rejected' }
});

test('reports a direction mismatch without claiming that a fill failed or a position reversed', () => {
  const report = buildTradetronPositionReconciliation({
    deployments: deployment([{ instrument_symbol: 'DIN-AVAXUSD 31 DEC 2099 XX 0', quantity: -1, open: true }]),
    signalOrders: [signal({ symbol: 'AVAXUSD', side: 'buy', size: 1 })]
  });
  assert.equal(report.snapshotAvailable, true);
  assert.equal(report.openPositionCount, 1);
  assert.equal(report.rows[0].comparisonStatus, 'DIRECTION_MISMATCH');
  assert.equal(report.rows[0].currentSide, 'SELL');
  assert.equal(report.rows[0].signalSide, 'BUY');
  assert.equal(report.rows[0].signalState, 'EXPIRED', 'reservation TTL state remains visible, not treated as close evidence');
});

test('uses the latest accepted bridge signal per symbol and ignores a newer rejected signal', () => {
  const report = buildTradetronPositionReconciliation({
    deployments: deployment([{ instrument_symbol: 'DIN-BTCUSD 31 DEC 2099 XX 0', quantity: 2, open: true }]),
    signalOrders: [
      signal({ symbol: 'BTCUSD', side: 'buy', size: 2, createdAt: '2026-10-15T11:58:00.000Z', accepted: false }),
      signal({ symbol: 'BTCUSD', side: 'sell', size: 2, createdAt: '2026-10-15T11:30:00.000Z', accepted: true })
    ]
  });
  assert.equal(report.rows[0].comparisonStatus, 'DIRECTION_MISMATCH');
  assert.equal(report.rows[0].signalSide, 'SELL');
});

test('flags a signal newer than the position snapshot instead of reporting a false mismatch', () => {
  const report = buildTradetronPositionReconciliation({
    deployments: deployment([{ instrument_symbol: 'DIN-ETHUSD 31 DEC 2099 XX 0', quantity: -3, open: true }], '2026-10-15T11:00:00.000Z'),
    signalOrders: [signal({ symbol: 'ETHUSD', side: 'buy', size: 1, createdAt: '2026-10-15T11:30:00.000Z' })]
  });
  assert.equal(report.rows[0].comparisonStatus, 'SIGNAL_NEWER_THAN_SNAPSHOT');
  assert.equal(report.newerSignalCount, 1);
  assert.equal(report.mismatchCount, 0);
});

test('separates quantity mismatches and counts exact matches', () => {
  const report = buildTradetronPositionReconciliation({
    deployments: deployment([
      { instrument_symbol: 'DIN-LTCUSD 31 DEC 2099 XX 0', quantity: -2, open: true },
      { instrument_symbol: 'DIN-LINKUSD 31 DEC 2099 XX 0', quantity: -1, open: true }
    ]),
    signalOrders: [
      signal({ symbol: 'LTCUSD', side: 'sell', size: 3 }),
      signal({ symbol: 'LINKUSD', side: 'sell', size: 1 })
    ]
  });
  assert.equal(report.rows.find(row => row.symbol === 'LTCUSD').comparisonStatus, 'QUANTITY_MISMATCH');
  assert.equal(report.rows.find(row => row.symbol === 'LINKUSD').comparisonStatus, 'MATCH');
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.matchedCount, 1);
});

test('does not report a mismatch when there is no accepted signal or snapshot coverage', () => {
  const report = buildTradetronPositionReconciliation({
    deployments: deployment([{ instrument_symbol: 'DIN-SOLUSD 31 DEC 2099 XX 0', quantity: 1, open: true }]),
    signalOrders: [signal({ symbol: 'SOLUSD', side: 'buy', size: 1, accepted: false })]
  });
  assert.equal(report.rows[0].comparisonStatus, 'NO_ACCEPTED_SIGNAL');

  const unavailable = buildTradetronPositionReconciliation({ deployments: [], signalOrders: [] });
  assert.equal(unavailable.snapshotAvailable, false);
  assert.equal(unavailable.openPositionCount, null);
  assert.deepEqual(unavailable.rows, []);
});
