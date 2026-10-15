import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTradetronPosition,
  normalizeTradetronPositions,
  summarizeTradetronSnapshots,
  buildTradetronSnapshotRiskState,
  TRADETRON_SNAPSHOT_MAX_AGE_MS
} from '../src/tradetron-position-sync.js';

test('normalizes open Delta Exchange legs from Tradetron snapshot rows', () => {
  const positions = normalizeTradetronPositions([{
    deployment_id: 999273394,
    deployment_name: 'Signal Bridge',
    positions: [
      { instrument_symbol: 'DIN-DRAMBUSD 31 DEC 2099 XX 0', quantity: -3, price: 52.25, ltp: 52.12, market_value: -156, m2m: 0, open: true },
      { instrument_symbol: 'DIN-PAXGUSD 31 DEC 2099 XX 0', quantity: 0, price: 4189.7, ltp: 4189.5, open: false }
    ]
  }]);
  assert.equal(positions.length, 2);
  assert.equal(positions[0].symbol, 'DRAMBUSD');
  assert.equal(positions[0].side, 'SELL');
  assert.equal(positions[0].quantity, -3);
  assert.equal(positions[0].entryPrice, 52.25);
  assert.equal(positions[0].markPrice, 52.12);
  assert.equal(positions[0].open, true);
  assert.equal(positions[1].open, false);
});

test('a nonzero signed quantity identifies an open row when Tradetron omits its open flag', () => {
  const row = normalizeTradetronPosition({
    instrument_symbol: 'DIN-LTCUSD 31 DEC 2099 XX 0',
    net_quantity: 2,
    average_price: '61.92',
    m2m: '$ 1.25'
  }, { deployment_id: 7 });
  assert.equal(row.symbol, 'LTCUSD');
  assert.equal(row.side, 'BUY');
  assert.equal(row.open, true);
  assert.equal(row.pnl, 1.25);
});

test('closed zero-quantity snapshot rows do not become open positions', () => {
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 7,
    status: 'Exited',
    positions_hidden: false,
    pnl: -46.52,
    open_positions: 0,
    positions: [
      { instrument_symbol: 'DIN-ADAUSD 31 DEC 2099 XX 0', quantity: 0, open: false },
      { instrument_symbol: 'DIN-LINKUSD 31 DEC 2099 XX 0', quantity: 0, status: 'Closed' }
    ]
  }]);
  assert.equal(summary.openCount, 0);
  assert.equal(summary.openRows.length, 0);
  assert.equal(summary.reportedPnl, -46.52);
});

test('explicit closed status overrides a nonzero historical quantity', () => {
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 7,
    open_positions: 0,
    positions: [
      { instrument_symbol: 'DIN-AMDBUSD 31 DEC 2099 XX 0', quantity: 2, status: 'Exited', open: true },
      { instrument_symbol: 'DIN-LINKUSD 31 DEC 2099 XX 0', quantity: -1, position_status: 'Closed' }
    ]
  }]);
  assert.equal(summary.openCount, 0);
  assert.equal(summary.openRows.length, 0);
});

test('deployment open count remains visible if individual positions are hidden', () => {
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 7,
    positions_hidden: true,
    open_positions: 4,
    pnl: 1.09,
    positions: []
  }]);
  assert.equal(summary.openCount, 4);
  assert.equal(summary.positionsHidden, true);
  assert.equal(summary.openRows.length, 0);
});

test('does not infer P&L by treating a missing value as zero', () => {
  const summary = summarizeTradetronSnapshots([
    { deployment_id: 1, positions: [], pnl: 5 },
    { deployment_id: 2, positions: [], pnl: null }
  ]);
  assert.equal(summary.reportedPnl, null);
  assert.equal(summary.openPnl, null);
});

test('extracts Delta contract symbol from a Tradetron instrument identifier', () => {
  const row = normalizeTradetronPosition({ instrument: 'FUTCRYPTO_DIN-LINKUSD_31DEC2099_XX_0', quantity: -1, ltp: 13.038, pnl: -0.04, open: true }, { deployment_id: 7 });
  assert.equal(row.symbol, 'LINKUSD');
  assert.equal(row.side, 'SELL');
  assert.equal(row.open, true);
  assert.equal(row.markPrice, 13.038);
  assert.equal(row.pnl, -0.04);
});

test('generic pnl remains explicitly source-labeled when it duplicates the mark price', () => {
  const row = normalizeTradetronPosition({
    instrument: 'FUTCRYPTO_DIN-SNDKBUSD_31DEC2099_XX_0',
    quantity: 1,
    ltp: 1369.9,
    pnl: 1369.9,
    open: true
  }, { deployment_id: 999273394 });
  assert.equal(row.markPrice, 1369.9);
  assert.equal(row.pnl, 1369.9);
  assert.equal(row.pnlSource, 'pnl');
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 999273394,
    currency_code: 'USD',
    open_positions: 1,
    positions: [{ instrument: 'FUTCRYPTO_DIN-SNDKBUSD_31DEC2099_XX_0', quantity: 1, ltp: 1369.9, pnl: 1369.9, open: true }]
  }]);
  assert.equal(summary.openPnl, null);
});

test('generic row-level pnl is not treated as verified open M2M or summed into open P&L', () => {
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 999273394,
    positions_hidden: false,
    open_positions: 2,
    pnl: 19.58,
    currency_code: 'USD',
    positions: [
      { instrument: 'FUTCRYPTO_DIN-AMDBUSD_31DEC2099_XX_0', quantity: -2, ltp: 588.4, pnl: 56.78, open: true },
      { instrument: 'FUTCRYPTO_DIN-GOOGLXUSD_31DEC2099_XX_0', quantity: 5, ltp: 354.1, pnl: 18.25, open: true }
    ]
  }]);

  assert.equal(summary.openRows.length, 2);
  assert.equal(summary.openRows[0].pnl, 56.78);
  assert.equal(summary.openRows[0].pnlSource, 'pnl');
  assert.equal(summary.openPnl, null);
  assert.equal(summary.reportedPnl, 19.58);
});

test('explicit M2M fields remain eligible for open P&L aggregation', () => {
  const summary = summarizeTradetronSnapshots([{
    deployment_id: 7,
    open_positions: 2,
    positions: [
      { instrument: 'FUTCRYPTO_DIN-LINKUSD_31DEC2099_XX_0', quantity: -1, m2m: 1.5, open: true },
      { instrument: 'FUTCRYPTO_DIN-NEARUSD_31DEC2099_XX_0', quantity: -3, unrealized_pnl: -0.5, open: true }
    ]
  }]);
  assert.equal(summary.openPnl, 1);
});


test('does not aggregate deployment P&L across unknown or mixed currencies', () => {
  const unknownCurrencies = summarizeTradetronSnapshots([
    { deployment_id: 1, pnl: 2.5, positions: [{ instrument: 'FUTCRYPTO_DIN-BTCUSD_31DEC2099_XX_0', quantity: 1, m2m: 1.25, open: true }] },
    { deployment_id: 2, pnl: 3.5, positions: [{ instrument: 'FUTCRYPTO_DIN-ETHUSD_31DEC2099_XX_0', quantity: 1, m2m: 2.25, open: true }] }
  ]);
  assert.equal(unknownCurrencies.reportedPnl, null);
  assert.equal(unknownCurrencies.reportedPnlCurrencyCode, null);
  assert.equal(unknownCurrencies.openPnl, null);

  const mixedCurrencies = summarizeTradetronSnapshots([
    { deployment_id: 1, currency_code: 'USD', pnl: 2.5, positions: [] },
    { deployment_id: 2, currency_code: 'INR', pnl: 3.5, positions: [] }
  ]);
  assert.equal(mixedCurrencies.reportedPnl, null);
  assert.equal(mixedCurrencies.reportedPnlCurrencyCode, null);
});

test('aggregates multiple deployment P&L values only when the API declares one common currency', () => {
  const summary = summarizeTradetronSnapshots([
    { deployment_id: 1, currency_code: 'USD', pnl: 2.5, positions: [{ instrument: 'FUTCRYPTO_DIN-BTCUSD_31DEC2099_XX_0', quantity: 1, m2m: 1.25, open: true }] },
    { deployment_id: 2, currency_code: 'USD', pnl: 3.5, positions: [{ instrument: 'FUTCRYPTO_DIN-ETHUSD_31DEC2099_XX_0', quantity: 1, m2m: 2.25, open: true }] }
  ]);
  assert.equal(summary.reportedPnl, 6);
  assert.equal(summary.reportedPnlCurrencyCode, 'USD');
  assert.equal(summary.openPnl, 3.5);
});

function freshSnapshotFixture(overrides = {}) {
  const now = Date.parse('2026-10-14T04:00:00.000Z');
  return {
    now,
    syncState: {
      status: 'OK',
      last_success_at: new Date(now - 30_000).toISOString(),
      details: { deploymentIds: [7] }
    },
    deployments: [{
      deployment_id: 7,
      deployment_name: 'Signal Bridge',
      status: 'Active',
      positions_hidden: false,
      last_success_at: new Date(now - 30_000).toISOString(),
      open_positions: 1,
      positions: [{
        instrument_symbol: 'DIN-BTCUSD 31 DEC 2099 XX 0',
        quantity: -2,
        open: true
      }]
    }],
    ...overrides
  };
}

test('fresh complete Tradetron snapshots become duplicate-entry blockers, not exit-ledger rows', () => {
  const fixture = freshSnapshotFixture();
  const result = buildTradetronSnapshotRiskState(fixture);
  assert.equal(result.trusted, true);
  assert.equal(result.positionCount, 1);
  assert.equal(result.openPositions[0].symbol, 'BTCUSD');
  assert.equal(result.openPositions[0].side, 'SELL');
  assert.equal(result.openPositions[0].qty, 2);
  assert.equal(result.openPositions[0].origin, 'TRADETRON_API_SNAPSHOT');
  assert.equal(result.openPositions[0].snapshot_only, true);
});

test('stale, failed, or partial snapshots block duplicate-risk trust', () => {
  const fixture = freshSnapshotFixture();
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture, syncState: { ...fixture.syncState, last_success_at: new Date(fixture.now - TRADETRON_SNAPSHOT_MAX_AGE_MS - 1).toISOString() }
  }).reason, 'SNAPSHOT_STALE');
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture, syncState: { ...fixture.syncState, status: 'PARTIAL' }
  }).reason, 'SYNC_NOT_OK');
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture, deployments: []
  }).reason, 'DEPLOYMENT_COVERAGE_INCOMPLETE');
});

test('hidden or unreconciled open position counts fail closed', () => {
  const fixture = freshSnapshotFixture();
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture, deployments: fixture.deployments.map(row => ({ ...row, positions_hidden: true }))
  }).reason, 'POSITIONS_HIDDEN');
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture, deployments: fixture.deployments.map(row => ({ ...row, open_positions: 3 }))
  }).reason, 'OPEN_POSITION_COUNT_UNRECONCILED');
});

test('reported open-leg count must exactly match normalized open snapshot rows', () => {
  const fixture = freshSnapshotFixture();
  const oneOpenRow = fixture.deployments[0];
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture,
    deployments: [{ ...oneOpenRow, open_positions: 0 }]
  }).reason, 'OPEN_POSITION_COUNT_UNRECONCILED');
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture,
    deployments: [{ ...oneOpenRow, open_positions: 2 }]
  }).reason, 'OPEN_POSITION_COUNT_UNRECONCILED');
  assert.equal(buildTradetronSnapshotRiskState({
    ...fixture,
    deployments: [{ ...oneOpenRow, open_positions: undefined }]
  }).reason, 'OPEN_POSITION_COUNT_UNAVAILABLE');
});

test('an open API row without signed quantity or side is not treated as a verified blocker', () => {
  const fixture = freshSnapshotFixture({
    deployments: [{
      deployment_id: 7,
      positions_hidden: false,
      last_success_at: new Date(Date.parse('2026-10-14T03:59:30Z')).toISOString(),
      open_positions: 1,
      positions: [{ instrument_symbol: 'DIN-BTCUSD 31 DEC 2099 XX 0', open: true }]
    }]
  });
  assert.equal(buildTradetronSnapshotRiskState(fixture).reason, 'OPEN_POSITION_ROW_UNVERIFIED');
});
