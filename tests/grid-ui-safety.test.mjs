import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/GridStrategy.jsx', import.meta.url), 'utf8');
const sharedStatusSource = await readFile(new URL('../shared/grid-settings.js', import.meta.url), 'utf8');

test('Grid UI exposes two allowlisted Testnet symbols and keeps execution behind the explicit opt-in', () => {
  assert.match(source, /executionMode\\s*===\\s*'testnet'/);
  assert.match(sharedStatusSource, /TESTNET GRID · EXECUTION DISABLED/);
  assert.match(sharedStatusSource, /TESTNET GRID · ACTIVE/);
  assert.match(source, /getGridDisplayStatus/);
  assert.match(source, /gridSymbolConfigs/);
  assert.match(source, /gridExecutionAllowed/);
  assert.match(source, /PAXGUSD/);
  assert.match(source, /NVDAXUSD/);
  assert.match(source, /Start Grid \\(Delta Testnet\\)/);
  assert.match(source, /Independent exchange-side SL\\/TP/);
  assert.doesNotMatch(source, /BTCUSD|ETHUSD/);
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
