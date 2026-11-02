import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY_POSITION_LIMITS,
  normalizeStrategyPositionKey,
  getStrategyPositionLimit,
  countOpenStrategyPositions,
  assessStrategyPositionCap
} from '../shared/strategy-position-limits.js';

test('strategy keys normalize aliases into the four independent limits', () => {
  assert.equal(normalizeStrategyPositionKey('MOMENTUM'), 'MOMENTUM');
  assert.equal(normalizeStrategyPositionKey('SCALP'), 'SCALPING');
  assert.equal(normalizeStrategyPositionKey('SCALPING'), 'SCALPING');
  assert.equal(normalizeStrategyPositionKey('GRID'), 'GRID');
  assert.equal(normalizeStrategyPositionKey('OPTIONS_BUY'), 'OPTIONS');
  assert.equal(normalizeStrategyPositionKey('OPTIONS_SELL'), 'OPTIONS');
  assert.equal(normalizeStrategyPositionKey('UNKNOWN'), null);
});

test('requested defaults and persisted overrides resolve independently', () => {
  assert.deepEqual(DEFAULT_STRATEGY_POSITION_LIMITS, {
    MOMENTUM: 5, SCALPING: 5, GRID: 2, OPTIONS: 4
  });
  assert.equal(getStrategyPositionLimit({}, 'MOMENTUM'), 5);
  assert.equal(getStrategyPositionLimit({}, 'SCALPING'), 5);
  assert.equal(getStrategyPositionLimit({}, 'GRID'), 2);
  assert.equal(getStrategyPositionLimit({}, 'OPTIONS_BUY'), 4);
  assert.equal(getStrategyPositionLimit({
    max_momentum_positions: 3,
    max_scalping_positions: 7,
    max_grid_positions: 2,
    max_options_positions: 4
  }, 'MOMENTUM'), 3);
  assert.equal(getStrategyPositionLimit({max_momentum_positions: 99}, 'MOMENTUM'), 1,
    'invalid persisted values fail closed to a single position');
});

test('open position count uses only OPEN rows belonging to the requested strategy', () => {
  const rows = [
    {status:'OPEN', strategy:'MOMENTUM', symbol:'DOGSUSD'},
    {status:'OPEN', strategy:'MOMENTUM', symbol:'XAUTUSD'},
    {status:'CLOSED', strategy:'MOMENTUM', symbol:'PAXGUSD'},
    {status:'OPEN', strategy:'SCALPING', symbol:'QQQXUSD'},
    {status:'OPEN', strategy:'OPTIONS_BUY', symbol:'C-BTC-90000-010127'}
  ];
  assert.equal(countOpenStrategyPositions(rows, 'MOMENTUM'), 2);
  assert.equal(countOpenStrategyPositions(rows, 'SCALPING'), 1);
  assert.equal(countOpenStrategyPositions(rows, 'OPTIONS'), 1);
  assert.equal(countOpenStrategyPositions(null, 'MOMENTUM'), null);
});

test('strategy cap blocks at the configured exposure and keeps other strategies independent', () => {
  const rows = [
    {id:'p1',status:'OPEN',strategy:'MOMENTUM',entry_order_id:'o1'},
    {id:'p2',status:'OPEN',strategy:'MOMENTUM',entry_order_id:'o2'},
    {id:'p3',status:'OPEN',strategy:'MOMENTUM',entry_order_id:'o3'},
    {id:'s1',status:'OPEN',strategy:'SCALPING'}
  ];
  const settings = {max_momentum_positions:3,max_scalping_positions:5};
  const momentum = assessStrategyPositionCap({
    strategy:'MOMENTUM',settings,openPositions:rows,pendingOrders:[],now:Date.parse('2026-11-03T00:00:00Z')
  });
  const scalp = assessStrategyPositionCap({
    strategy:'SCALPING',settings,openPositions:rows,pendingOrders:[],now:Date.parse('2026-11-03T00:00:00Z')
  });
  assert.equal(momentum.status,'BLOCK');
  assert.equal(momentum.exposure,3);
  assert.equal(momentum.reason,'Strategy position cap reached (MOMENTUM: 3/3); new entries blocked');
  assert.equal(scalp.status,'PASS');
  assert.equal(scalp.exposure,1);
});

test('pending and recently filled entry reservations consume a slot but are not double-counted against OPEN rows', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const assessment = assessStrategyPositionCap({
    strategy:'MOMENTUM',
    settings:{max_momentum_positions:3},
    openPositions:[{status:'OPEN',strategy:'MOMENTUM',client_order_id:'already-open'}],
    pendingOrders:[
      {role:'ENTRY',strategy:'MOMENTUM',state:'PENDING',client_order_id:'pending-1'},
      {role:'ENTRY',strategy:'MOMENTUM',state:'FILLED',client_order_id:'filled-awaiting-position',created_at:new Date(now-1000).toISOString()},
      {role:'ENTRY',strategy:'MOMENTUM',state:'FILLED',client_order_id:'old-filled',created_at:new Date(now-300000).toISOString()},
      {role:'ENTRY',strategy:'SCALPING',state:'PENDING',client_order_id:'other-strategy'},
      {role:'EXIT',strategy:'MOMENTUM',state:'PENDING',client_order_id:'exit-order'},
      {role:'ENTRY',strategy:'MOMENTUM',state:'FILLED',client_order_id:'already-open',created_at:new Date(now-1000).toISOString()}
    ],
    now
  });
  assert.equal(assessment.openPositions,1);
  assert.equal(assessment.pendingReservations,2);
  assert.equal(assessment.exposure,3);
  assert.equal(assessment.status,'BLOCK');
});

test('missing database evidence fails closed instead of showing free capacity', () => {
  const result = assessStrategyPositionCap({
    strategy:'GRID',settings:{},openPositions:null,pendingOrders:[],now:Date.now()
  });
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.blocked,true);
  assert.match(result.reason,/fail closed/);
});
