import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IV_HISTORY_PERSIST_INTERVAL_MS,
  IV_RETRY_BASE_DELAY_MS,
  IV_RETRY_MAX_DELAY_MS,
  clearIvRetryFailure,
  isIvRetryReady,
  markIvHistoryObservationsPersisted,
  recordIvRetryFailure,
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

test('transient IV database failures use bounded exponential retry backoff', () => {
  const retries = new Map();
  const first = recordIvRetryFailure(retries, 'BTC', 100_000);
  assert.equal(first.failures, 1);
  assert.equal(first.retryDelayMs, IV_RETRY_BASE_DELAY_MS);
  assert.equal(isIvRetryReady(retries, 'BTC', first.retryAt - 1), false);
  assert.equal(isIvRetryReady(retries, 'BTC', first.retryAt), true);

  const second = recordIvRetryFailure(retries, 'BTC', first.retryAt);
  assert.equal(second.failures, 2);
  assert.equal(second.retryDelayMs, IV_RETRY_BASE_DELAY_MS * 2);
  const third = recordIvRetryFailure(retries, 'BTC', second.retryAt);
  assert.equal(third.retryDelayMs, IV_RETRY_BASE_DELAY_MS * 4);
  const fourth = recordIvRetryFailure(retries, 'BTC', third.retryAt);
  assert.equal(fourth.retryDelayMs, IV_RETRY_MAX_DELAY_MS);
  const fifth = recordIvRetryFailure(retries, 'BTC', fourth.retryAt);
  assert.equal(fifth.retryDelayMs, IV_RETRY_MAX_DELAY_MS);
});

test('IV retry backoff is isolated by key and clears after a confirmed success', () => {
  const retries = new Map();
  recordIvRetryFailure(retries, 'BTC', 10_000);
  assert.equal(isIvRetryReady(retries, 'ETH', 10_001), true);
  assert.equal(isIvRetryReady(retries, 'BTC', 10_001), false);
  assert.equal(clearIvRetryFailure(retries, 'BTC'), true);
  assert.equal(isIvRetryReady(retries, 'BTC', 10_002), true);
  assert.equal(clearIvRetryFailure(retries, 'BTC'), false);
  assert.equal(retries.has('BTC'), false);
});

test('IV retry state stays bounded under many failing underlying keys', () => {
  const retries = new Map();
  for (let i = 0; i < 200; i++) recordIvRetryFailure(retries, 'UNDERLYING-' + i, 1_000);
  assert.equal(retries.size, 128);
  assert.equal(retries.has('UNDERLYING-0'), false);
  assert.equal(retries.has('UNDERLYING-199'), true);
});
