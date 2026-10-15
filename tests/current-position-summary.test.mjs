import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeCurrentPositionCount,
  summarizeTradetronSnapshots
} from '../src/tradetron-position-sync.js';

const now = Date.parse('2026-10-15T08:00:00.000Z');
const lastSuccessAt = new Date(now - 1000).toISOString();

const sampleDeployments = [{
  deployment_id: 999,
  deployment_name: 'Signal Bridge',
  currency_code: 'USD',
  open_positions: 2,
  total_positions: 2,
  positions_hidden: false,
  last_success_at: lastSuccessAt,
  positions: [
    { instrument_symbol: 'BTCUSD', net_quantity: 1, status: 'Open', entry_price: 80000, mark_price: 80100 },
    { instrument_symbol: 'ETHUSD', net_quantity: -2, status: 'Open', entry_price: 2400, mark_price: 2390 }
  ]
}];

test('current position summary uses a fresh Tradetron snapshot even when the webhook ledger is empty', () => {
  const result = summarizeCurrentPositionCount({
    eventPositions: [],
    deployments: sampleDeployments,
    syncState: { status: 'OK', last_success_at: lastSuccessAt },
    configured: true,
    now
  });
  assert.equal(result.status, 'FRESH');
  assert.equal(result.count, 2);
  assert.equal(result.source, 'tradetron-developer-api');
  assert.match(result.detail, /not proof of authenticated fill events/);
});

test('stale or failed snapshots do not silently show zero current positions', () => {
  const result = summarizeCurrentPositionCount({
    eventPositions: [],
    deployments: sampleDeployments,
    syncState: { status: 'ERROR', last_success_at: new Date(now - 10 * 60 * 1000).toISOString() },
    configured: true,
    now
  });
  assert.equal(result.count, null);
  assert.equal(result.status, 'STALE');
  assert.equal(result.lastKnownCount, 2);
});

test('hidden positions with no verified open count remain unknown rather than zero', () => {
  const hidden = [{ deployment_id: 123, positions_hidden: true, positions: [] }];
  const mirror = summarizeTradetronSnapshots(hidden);
  assert.equal(mirror.openCount, null);

  const result = summarizeCurrentPositionCount({
    eventPositions: [],
    deployments: hidden,
    syncState: { status: 'OK', last_success_at: lastSuccessAt },
    configured: true,
    now
  });
  assert.equal(result.count, null);
  assert.equal(result.status, 'COUNT_UNKNOWN');
});

test('when the Developer API is not configured, summary labels the event ledger as the only source', () => {
  const result = summarizeCurrentPositionCount({
    eventPositions: [{ symbol: 'BTCUSD', qty: 1 }, { symbol: 'ETHUSD', qty: 0 }],
    configured: false,
    now
  });
  assert.equal(result.status, 'EVENT_LEDGER_ONLY');
  assert.equal(result.count, 1);
  assert.equal(result.source, 'authenticated-event-ledger');
});
