import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIvHistoryGroup, deltaBucketFor, dteBucketFor, groupIvHistoryByBucket,
  ivHistoryGroupKey
} from '../worker/options-iv-grouping.mjs';

const NOW = Date.UTC(2026, 10, 10, 12);

test('assigns absolute delta into stable strategy buckets', () => {
  assert.equal(deltaBucketFor(0.22), '0.10-0.30');
  assert.equal(deltaBucketFor(-0.22), '0.10-0.30');
  assert.equal(deltaBucketFor(0.5), '0.40-0.60');
  assert.equal(deltaBucketFor(0.9), null);
});

test('assigns DTE to short and weekly tenor buckets', () => {
  assert.equal(dteBucketFor(1.2), '0-3');
  assert.equal(dteBucketFor(3), '0-3');
  assert.equal(dteBucketFor(4), '4-10');
  assert.equal(dteBucketFor(10), '4-10');
  assert.equal(dteBucketFor(14), '11-90');
  assert.equal(dteBucketFor(0), null);
});

test('contracts with different expiry symbols inherit the same history group', () => {
  const oldExpiry = buildIvHistoryGroup({
    symbol: 'C-BTC-90000-111126', greeks: { delta: 0.24 }
  }, 'BTC', NOW);
  const newExpiry = buildIvHistoryGroup({
    symbol: 'C-BTC-92000-121126', greeks: { delta: 0.26 }
  }, 'BTC', NOW);
  assert.deepEqual(oldExpiry && {
    underlying: oldExpiry.underlying, option_type: oldExpiry.option_type,
    delta_bucket: oldExpiry.delta_bucket, dte_bucket: oldExpiry.dte_bucket
  }, {
    underlying: 'BTC', option_type: 'CALL',
    delta_bucket: '0.10-0.30', dte_bucket: '4-10'
  });
  assert.equal(ivHistoryGroupKey(oldExpiry), ivHistoryGroupKey(newExpiry));
});

test('groups history independently by underlying, type, delta and DTE', () => {
  const rows = [
    { underlying: 'BTC', option_type: 'CALL', delta_bucket: '0.10-0.30', dte_bucket: '4-10', symbol: 'C-BTC-1-111126', iv_current: 42 },
    { underlying: 'BTC', option_type: 'CALL', delta_bucket: '0.10-0.30', dte_bucket: '4-10', symbol: 'C-BTC-2-121126', iv_current: 44 },
    { underlying: 'BTC', option_type: 'PUT', delta_bucket: '0.10-0.30', dte_bucket: '4-10', iv_current: 48 },
    { underlying: 'ETH', option_type: 'CALL', delta_bucket: '0.10-0.30', dte_bucket: '4-10', iv_current: 51 },
    { underlying: 'BTC', option_type: 'CALL', delta_bucket: '0.40-0.60', dte_bucket: '0-3', iv_current: 60 }
  ];
  const groups = groupIvHistoryByBucket(rows);
  assert.equal(groups.size, 4);
  assert.equal(groups.get('BTC|CALL|0.10-0.30|4-10').length, 2);
  assert.equal(groups.get('BTC|PUT|0.10-0.30|4-10').length, 1);
  assert.equal(groups.get('ETH|CALL|0.10-0.30|4-10').length, 1);
  assert.equal(groups.get('BTC|CALL|0.40-0.60|0-3').length, 1);
});

test('does not group observations without delta, expiry or valid option type', () => {
  assert.equal(buildIvHistoryGroup({ symbol: 'C-BTC-90000-111126' }, 'BTC', NOW), null);
  assert.equal(buildIvHistoryGroup({ symbol: 'X-BTC-90000-111126', delta: 0.5 }, 'BTC', NOW), null);
});
