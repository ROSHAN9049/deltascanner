import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function TradeHistory({');
const end = source.indexOf('\nfunction PNL(', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const history = source.slice(start, end);

test('history tabs use Delta Testnet trades and have no Tradetron or mirror API props', () => {
  assert.match(source, /tab === 'momentum-history' && <TradeHistory trades=\{trades\.filter\(t => t\.strategy === 'MOMENTUM'\)\} title="Momentum History"/);
  assert.match(source, /tab === 'scalp-history' && <TradeHistory trades=\{trades\.filter\(t => t\.strategy === 'SCALPING'\)\} title="Scalping History"/);
  assert.match(source, /tab === 'trade-history' && <TradeHistory trades=\{trades\} title="Trade History · Delta Testnet Ledger"/);
  assert.doesNotMatch(source, /Tradetron|tradetron|apiDerivedTrades|apiDerivedTradeCount/);
});

test('trade history displays only the Delta Testnet ledger and does not merge inferred rows', () => {
  assert.match(history, /Delta Testnet closed-trade history is unavailable or incomplete/);
  assert.match(history, /DELTA TESTNET/);
  assert.match(history, /tradesComplete/);
  assert.doesNotMatch(history, /API-Derived|raw_pnl|derivedRows|tradetron/i);
  // Explicitly label ledger rows whose fees or net P&L are not verified;
  // this is not an inferred/API-derived trade source.
  assert.match(history, /NET UNVERIFIED/);
});

test('the dashboard no longer renders mirror coverage or signal record sections', () => {
  for (const oldSection of [
    'Tradetron Execution Coverage',
    'Legacy Data · Tradetron Live Mirror',
    'Tradetron Live Mirror',
    'Tradetron Signal Records',
    'function TradetronActivity',
    'function TradetronDeveloperApiPanel',
    '/api/tradetron/webhook'
  ]) assert.equal(source.includes(oldSection), false, oldSection + ' must be removed');
});
