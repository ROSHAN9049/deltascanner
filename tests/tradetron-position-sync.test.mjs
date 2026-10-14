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

test('extracts Delta contract symbol from a Tradetron instrument identifier', () => {
  const row = normalizeTradetronPosition({ instrument: 'FUTCRYPTO_DIN-LINKUSD_31DEC2099_XX_0', quantity: -1, ltp: 13.038, pnl: -0.04, open: true }, { deployment_id: 7 });
  assert.equal(row.symbol, 'LINKUSD');
  assert.equal(row.side, 'SELL');
  assert.equal(row.open, true);
  assert.equal(row.markPrice, 13.038);
  assert.equal(row.pnl, -0.04);
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
