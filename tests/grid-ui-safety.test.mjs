import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/GridStrategy.jsx', import.meta.url), 'utf8');

test('Grid UI labels Testnet as active diagnostics while keeping order routing disabled', () => {
  assert.match(source, /executionMode\s*===\s*'testnet'/);
  assert.match(source, /ACTIVE \(WAITING FOR TESTNET PRODUCTS\)/);
  assert.match(source, /TESTNET ORDER ROUTE LOCKED/);
  assert.match(source, /Testnet Diagnostics Only · Orders Locked/);
  assert.match(source, /no exchange orders or positions are created/);
  assert.doesNotMatch(source, /Start Grid \(Delta Testnet\)/);
});

test('Grid P&L distinguishes verified Testnet net P&L from simulator estimates', () => {
  assert.match(source, /DELTA TESTNET NET P&L/);
  assert.match(source, /Only fully fill-matched trades with verified commissions/);
  assert.match(source, /SIMULATED GRID P&amp;L/);
  assert.match(source, /not exchange-reported P&amp;L/);
});

test('Grid UI has no misleading Tradetron brand or LIVE OFFLINE labels', () => {
  assert.doesNotMatch(source, /Tradetron|TRADETRON|LIVE OFFLINE|TRADETRON_CAPITAL_USD/i);
});
