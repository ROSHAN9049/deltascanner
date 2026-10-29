import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/GridStrategy.jsx', import.meta.url), 'utf8');

test('Grid UI explicitly locks execution when the worker reports Testnet lifecycle is not migrated', () => {
  assert.match(source, /gridNotMigratedToDelta\s*=\s*gridEntrySafety\?\.reason\s*===\s*'GRID_NOT_MIGRATED_TO_DELTA_TESTNET'/);
  assert.match(source, /disabled=\{[^}]*gridNotMigratedToDelta/);
  assert.match(source, /Grid Testnet Not Migrated/);
});

test('Grid P&L is labelled as simulation and never presented as exchange P&L', () => {
  assert.match(source, /SIMULATED GRID P&amp;L/);
  assert.match(source, /not exchange-reported P&amp;L/);
  assert.match(source, /No direct Delta Testnet Grid orders are sent/);
});

test('Grid UI has no misleading Tradetron brand or LIVE OFFLINE labels', () => {
  assert.doesNotMatch(source, /Tradetron|TRADETRON|LIVE OFFLINE|TRADETRON_CAPITAL_USD/i);
});
