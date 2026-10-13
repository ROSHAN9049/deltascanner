import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTradetronPosition,
  normalizeTradetronPositions,
  summarizeTradetronSnapshots
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
