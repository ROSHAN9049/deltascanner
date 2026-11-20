import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IV_HISTORY_PERSIST_INTERVAL_MS,
  markIvHistoryObservationsPersisted,
  selectDueIvHistoryObservations
} from '../worker/iv-history-write-policy.mjs';

function observation(symbol = 'C-BTC-90000-211126', group = {}) {
  return {
    ticker: { symbol },
    iv: 45,
    group: {
      underlying: 'BTC',
      option_type: 'CALL',
      delta_bucket: '0.40-0.60',
      dte_bucket: '4-10',
      ...group
    }
  };
}

test('new IV observations persist immediately, then at the five-minute cadence', () => {
  const lastPersisted = new Map();
  const row = observation();
  assert.deepEqual(selectDueIvHistoryObservations([row], lastPersisted, 10_000), [row]);
  markIvHistoryObservationsPersisted([row], lastPersisted, 10_000);
  assert.deepEqual(selectDueIvHistoryObservations([row], lastPersisted, 10_000 + IV_HISTORY_PERSIST_INTERVAL_MS - 1), []);
  assert.deepEqual(selectDueIvHistoryObservations([row], lastPersisted, 10_000 + IV_HISTORY_PERSIST_INTERVAL_MS), [row]);
});

test('a changed option history bucket receives its own first observation', () => {
  const lastPersisted = new Map();
  const original = observation();
  const changed = observation(original.ticker.symbol, { delta_bucket: '0.30-0.40' });
  markIvHistoryObservationsPersisted([original], lastPersisted, 20_000);
  assert.deepEqual(selectDueIvHistoryObservations([changed], lastPersisted, 20_001), [changed]);
});

test('invalid observations and clock regressions are not written', () => {
  const lastPersisted = new Map();
  const row = observation();
  markIvHistoryObservationsPersisted([row], lastPersisted, 30_000);
  assert.deepEqual(selectDueIvHistoryObservations([row], lastPersisted, 29_999), []);
  assert.deepEqual(selectDueIvHistoryObservations([{ ticker: { symbol: 'invalid' }, group: {} }], lastPersisted, 40_000), []);
});
