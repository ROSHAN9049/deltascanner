import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function Analytics({');
const end = source.indexOf('\nfunction equityPoints', start);
assert.notEqual(start, -1, 'Analytics component exists');
assert.notEqual(end, -1, 'Analytics component has a clear end');
const analytics = source.slice(start, end);

test('Analytics uses only the Delta Testnet trade ledger', () => {
  assert.match(source, /<Analytics trades=\{trades\} accountDataProtected=\{accountDataProtected\} tradesComplete=\{tradeHistoryComplete\}/);
  assert.match(analytics, /function Analytics\(\{ trades = \[\], accountDataProtected = false, tradesComplete = false, tradeRowCount = null \}\)/);
  assert.doesNotMatch(source, /apiDerivedTrades|apiDerivedTradeCount|Tradetron|tradetron/);
  assert.doesNotMatch(analytics, /raw_pnl|API-Derived|unverified fills/);
});

test('Delta analytics compute win metrics from exchange realized P&L and net curve only from verified after-cost P&L', () => {
  assert.match(analytics, /const realizedValue = trade => trade\?\.gross_pnl_verified === true/);
  assert.match(analytics, /const wins = realizedRows\.filter\(trade => realizedValue\(trade\) > 0\)/);
  assert.match(analytics, /const avgLoss = losses\.length/);
  assert.match(analytics, /const netKnown = tradesComplete/);
  assert.match(analytics, /trade\?\.net_pnl_verified === true && safeNum\(trade\.net_pnl\) !== null/);
  assert.match(analytics, /equityPoints\(trades\)/);
  assert.doesNotMatch(analytics, /equityPoints\(derivedRows\)/);
});
