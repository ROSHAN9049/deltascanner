import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRollingIvRank, extractCurrentImpliedVolatility, normalizeImpliedVolatility
} from '../worker/options-iv-rank.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);

test('normalizes decimal and percentage implied volatility', () => {
  assert.equal(normalizeImpliedVolatility(0.65), 65);
  assert.equal(normalizeImpliedVolatility(65), 65);
  assert.equal(extractCurrentImpliedVolatility({ greeks: { iv: 0.42 } }), 42);
  assert.equal(extractCurrentImpliedVolatility({ quotes: { bid_iv: '0.22', ask_iv: '0.26' } }), 24);
  assert.equal(extractCurrentImpliedVolatility({ quotes: { bid_iv: '0.22' } }), 22);
  assert.equal(extractCurrentImpliedVolatility({ mark_iv: '0.31', quotes: { bid_iv: '0.22', ask_iv: '0.26' } }), 31);
  assert.equal(extractCurrentImpliedVolatility({}), null);
});

test('rolling IV Rank uses 30-day low/high after at least seven days of history', () => {
  const history = [
    { iv_current: 20, observed_at: new Date(NOW - 10 * DAY).toISOString() },
    { iv_current: 30, observed_at: new Date(NOW - 5 * DAY).toISOString() },
    { iv_current: 40, observed_at: new Date(NOW - DAY).toISOString() }
  ];
  const result = calculateRollingIvRank(history, 30, NOW);
  assert.equal(result.ivRank, 50);
  assert.equal(result.ivLow, 20);
  assert.equal(result.ivHigh, 40);
  assert.ok(result.historyDays >= 7);
});

test('rolling IV Rank fails closed with less than seven days of history', () => {
  const history = [
    { iv_current: 20, observed_at: new Date(NOW - 6 * DAY).toISOString() }
  ];
  const result = calculateRollingIvRank(history, 30, NOW);
  assert.equal(result.ivRank, null);
  assert.equal(result.reason, 'LESS_THAN_7_DAYS_IV_HISTORY');
});

test('one-day provisional IV Rank is allowed only when Testnet mode is explicitly supplied', () => {
  const history = [
    { iv_current: 20, observed_at: new Date(NOW - 36 * 60 * 60 * 1000).toISOString() },
    { iv_current: 40, observed_at: new Date(NOW - 12 * 60 * 60 * 1000).toISOString() }
  ];

  const production = calculateRollingIvRank(history, 30, NOW, {
    minimumHistoryDays: 1
  });
  assert.equal(production.ivRank, null);
  assert.equal(production.reason, 'LESS_THAN_7_DAYS_IV_HISTORY');
  assert.equal(production.minimumHistoryDays, 7);

  const testnet = calculateRollingIvRank(history, 30, NOW, {
    testnetExecution: true,
    minimumHistoryDays: 1
  });
  assert.equal(testnet.ivRank, 50);
  assert.equal(testnet.method, 'TESTNET_SHORT_WINDOW_1D');
  assert.equal(testnet.minimumHistoryDays, 1);
  assert.ok(testnet.historyDays >= 1);
});

test('rolling IV Rank fails closed when the 30-day range is flat', () => {
  const history = [
    { iv_current: 25, observed_at: new Date(NOW - 8 * DAY).toISOString() }
  ];
  const result = calculateRollingIvRank(history, 25, NOW);
  assert.equal(result.ivRank, null);
  assert.equal(result.reason, 'IV_RANGE_NOT_ESTABLISHED');
});

test('rolling IV Rank excludes observations older than 30 days', () => {
  const history = [
    { iv_current: 5, observed_at: new Date(NOW - 31 * DAY).toISOString() },
    { iv_current: 20, observed_at: new Date(NOW - 8 * DAY).toISOString() }
  ];
  const result = calculateRollingIvRank(history, 30, NOW);
  assert.equal(result.ivRank, 100);
  assert.equal(result.ivLow, 20);
});
