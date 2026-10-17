import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApiDerivedTrackingPlan, normalizeDerivedPosition, strategyForDerivedTrade } from '../worker/tradetron-derived-trades.mjs';

const now = '2026-10-17T04:00:00.000Z';
const previous = (overrides = {}) => ({
  id: '2b12b2a5-cd6c-4a3c-9ec9-0a2d8bd77339',
  deployment_id: '123',
  position_key: 'DIN-BTCUSD',
  symbol: 'BTCUSD',
  quantity: 2,
  side: null,
  ltp: 100,
  raw_pnl: 10,
  is_open: true,
  raw_api_data: { instrument: 'DIN-BTCUSD', quantity: 2, open: true, ltp: 100, pnl: 10 },
  observed_at: '2026-10-17T03:59:00.000Z',
  last_observed_at: '2026-10-17T03:59:30.000Z',
  is_current: true,
  ...overrides
});

test('tracks an explicit nonzero-to-zero poll transition without inventing side or prices', () => {
  const plan = buildApiDerivedTrackingPlan({
    previousObservations: [previous()],
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-BTCUSD', quantity: 0, open: false, ltp: 101, pnl: 12 }] }],
    detectedAt: now
  });
  assert.equal(plan.trades.length, 1);
  const trade = plan.trades[0];
  assert.equal(trade.derived_from, 'poll_transition');
  assert.equal(trade.symbol, 'BTCUSD');
  assert.equal(trade.qty_closed, 2);
  assert.equal(trade.side, null);
  assert.equal(trade.entry_price, null);
  assert.equal(trade.exit_price, null);
  assert.equal(trade.raw_pnl, 12);
  assert.equal(trade.last_known_ltp, 101);
  assert.equal(trade.data_quality, 'MINIMAL');
  assert.equal(trade.is_verified, false);
  assert.equal(trade.transition_from_snapshot_id, previous().id);
});

test('uses explicit side only and emits PARTIAL when side exists but prices do not', () => {
  const plan = buildApiDerivedTrackingPlan({
    previousObservations: [previous({ side: 'LONG', raw_api_data: { instrument: 'DIN-BTCUSD', quantity: 2, open: true, side: 'BUY' } })],
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-BTCUSD', quantity: 0, open: false, side: 'BUY', pnl: 5 }] }],
    detectedAt: now
  });
  assert.equal(plan.trades[0].side, 'LONG');
  assert.equal(plan.trades[0].data_quality, 'PARTIAL');
});

test('negative quantity alone does not fabricate SHORT side', () => {
  const position = normalizeDerivedPosition({ instrument: 'DIN-ETHUSD', quantity: -3, open: true, pnl: 1 }, 99, now);
  assert.equal(position.side, null);
  assert.equal(position.is_open, true);
});

test('a missing symbol from the new poll never creates a close event', () => {
  const plan = buildApiDerivedTrackingPlan({
    previousObservations: [previous()],
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-ETHUSD', quantity: 1, open: true, pnl: 2 }] }],
    detectedAt: now
  });
  assert.equal(plan.trades.some(row => row.symbol === 'BTCUSD'), false);
});

test('records a one-time closed snapshot observation but labels it snapshot_closed', () => {
  const plan = buildApiDerivedTrackingPlan({
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-BCHUSD', quantity: 0, open: false, ltp: 50, pnl: -2 }] }],
    detectedAt: now
  });
  assert.equal(plan.trades.length, 1);
  assert.equal(plan.trades[0].derived_from, 'snapshot_closed');
  assert.equal(plan.trades[0].qty_closed, null);
  assert.equal(plan.trades[0].data_quality, 'MINIMAL');
});

test('uses a matching terminal exit notification only when one close candidate exists', () => {
  const plan = buildApiDerivedTrackingPlan({
    previousObservations: [previous()],
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-BTCUSD', quantity: 0, open: false, pnl: 3 }] }],
    notifications: [{ deployment_id: '123', event_at: '2026-10-17T03:59:45.000Z', description: 'Status changed from Live-Tranching To Exited' }],
    detectedAt: now
  });
  assert.equal(plan.trades[0].closed_at_estimated, '2026-10-17T03:59:45.000Z');
});

test('does not mark timestamps from another deployment or outside the transition window', () => {
  const plan = buildApiDerivedTrackingPlan({
    previousObservations: [previous()],
    snapshots: [{ deployment_id: 123, as_of: now, positions: [{ instrument: 'DIN-BTCUSD', quantity: 0, open: false, pnl: 3 }] }],
    notifications: [{ deployment_id: '456', event_at: '2026-10-17T03:59:45.000Z', description: 'Exited' }],
    detectedAt: now
  });
  assert.equal(plan.trades[0].closed_at_estimated, null);
});

test('CSV/full data quality helper semantics remain based on explicit side and prices', () => {
  const position = normalizeDerivedPosition({
    instrument: 'DIN-ETHUSD', quantity: 0, open: false, side: 'SHORT',
    entry_price: 99, exit_price: 95, pnl: -4
  }, 99, now);
  assert.equal(position.side, 'SHORT');
  const plan = buildApiDerivedTrackingPlan({
    snapshots: [{ deployment_id: 99, as_of: now, positions: [{ instrument: 'DIN-ETHUSD', quantity: 0, open: false, side: 'SHORT', entry_price: 99, exit_price: 95, pnl: -4 }] }],
    detectedAt: now
  });
  assert.equal(plan.trades[0].data_quality, 'FULL');
});

test('labels a derived close with the strongest matching current signal-cache strategy', () => {
  assert.equal(strategyForDerivedTrade({ symbol: 'btcUSD' }, [
    { symbol: 'BTCUSD', strategy: 'MOMENTUM', ready: false, stage: 'SETUP', score: 95, cached_at: now },
    { symbol: 'BTCUSD', strategy: 'SCALPING', ready: true, stage: 'CONFIRMED', score: 82, cached_at: now }
  ]), 'SCALPING');
});

test('strategy cache lookup ignores unrelated symbols and unsupported engines', () => {
  assert.equal(strategyForDerivedTrade({ symbol: 'ETHUSD' }, [
    { symbol: 'BTCUSD', strategy: 'MOMENTUM', ready: true, stage: 'CONFIRMED', score: 99 },
    { symbol: 'ETHUSD', strategy: 'OPTIONS_BUY', ready: true, stage: 'CONFIRMED', score: 99 }
  ]), null);
});

test('uses signal-cache label as best-effort only and leaves it unknown when no matching signal exists', () => {
  assert.equal(strategyForDerivedTrade({ symbol: '' }, [
    { symbol: 'BTCUSD', strategy: 'MOMENTUM', ready: true, stage: 'CONFIRMED', score: 99 }
  ]), null);
  assert.equal(strategyForDerivedTrade({ symbol: 'BTCUSD' }, []), null);
});
