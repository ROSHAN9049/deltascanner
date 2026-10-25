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

test('Delta analytics retain safe partial-history labels and only use verified trade rows for the equity curve', () => {
  assert.match(analytics, /tradesComplete\?'Recorded exit reason labels':'Partial data — loaded records only \(history incomplete\)'/);
  assert.match(analytics, /tradesComplete && trades.length > 0 && trades.every\(t=>safeNum\(t.net_pnl\)!==null\)/);
  assert.match(analytics, /equityPoints\(trades\)/);
  assert.doesNotMatch(analytics, /equityPoints\(derivedRows\)/);
});
