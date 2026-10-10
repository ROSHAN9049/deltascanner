import test from 'node:test';
import assert from 'node:assert/strict';
import { routeStatusForSymbol } from '../src/market-route-status.js';

test('symbols outside the confirmed worker basket stay scan-only even with a high score', () => {
  const result = routeStatusForSymbol('PAXGUSD', { score: 99, ready: true }, ['BTCUSD', 'ETHUSD']);
  assert.equal(result.label, 'SCAN ONLY');
  assert.equal(result.tone, 'down');
  assert.match(result.title, /No entry can be routed/);
});

test('configured route is not presented as READY unless the selected signal is ready', () => {
  const result = routeStatusForSymbol('BTCUSD', { score: 90, stage: 'CONFIRMED', ready: false }, ['btcUsd']);
  assert.equal(result.label, 'ROUTED');
  assert.equal(result.tone, 'warn');
  assert.match(result.title, /not marked READY/i);
});

test('a routed and ready signal is clearly distinguished from scan-only symbols', () => {
  const result = routeStatusForSymbol(' ethusd ', { score: 85, ready: true }, ['ETHUSD']);
  assert.equal(result.label, 'READY');
  assert.equal(result.tone, 'up');
  assert.match(result.title, /not a confirmed fill/i);
});

test('missing route data fails closed as scan-only', () => {
  assert.equal(routeStatusForSymbol('BTCUSD', { ready: true }).label, 'SCAN ONLY');
  assert.equal(routeStatusForSymbol('', null, ['BTCUSD']).label, 'SCAN ONLY');
});

test('any ready engine makes the routed symbol READY even if the other engine is not ready', () => {
  const result = routeStatusForSymbol('BTCUSD', [
    { score: 95, ready: false },
    { score: 85, ready: true }
  ], ['BTCUSD']);
  assert.equal(result.label, 'READY');
  assert.equal(result.tone, 'up');
});
