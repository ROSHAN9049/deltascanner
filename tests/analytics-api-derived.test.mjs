import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const analyticsStart = source.indexOf('function Analytics({');
const analyticsEnd = source.indexOf('\nfunction equityPoints', analyticsStart);
assert.notEqual(analyticsStart, -1, 'Analytics component exists');
assert.notEqual(analyticsEnd, -1, 'Analytics component has a clear end');
const analytics = source.slice(analyticsStart, analyticsEnd);

test('Analytics receives API-derived records and total count from engine state', () => {
  assert.match(source, /<Analytics trades=\{trades\} apiDerivedTrades=\{state\?\.apiDerivedTrades \|\| \[\]\} apiDerivedTradeCount=\{state\?\.apiDerivedTradeCount \?\? null\}/);
  assert.match(analytics, /apiDerivedTrades = \[\]/);
  assert.match(analytics, /apiDerivedTradeCount = null/);
});

test('API-derived analytics are separately labelled unverified and use raw_pnl', () => {
  assert.match(analytics, /API-Derived Trade Analytics · UNVERIFIED/);
  assert.match(analytics, /Not authenticated fills\. Do not treat as verified P&amp;L\./);
  assert.match(analytics, /String\(row\?\.strategy \|\| ''\)\.toUpperCase\(\) === engine/);
  assert.match(analytics, /safeNum\(row\?\.raw_pnl\)/);
  assert.match(analytics, /Avg raw P&amp;L:/);
  assert.match(analytics, /Best:/);
  assert.match(analytics, /Worst:/);
  assert.match(analytics, /all observations remain unverified/);
});

test('API-derived empty state appears when neither strategy has rows', () => {
  assert.match(analytics, /No API-derived closes detected yet\. Monitoring active\./);
  assert.match(analytics, /derivedByEngine\.every\(engine => engine\.count === 0\)/);
});

test('partial history is disclosed for exit reasons and top-five-excluded net', () => {
  assert.match(analytics, /tradesComplete \? "recorded exit reason labels" : "⚠️ Partial data — loaded records only \(history incomplete\)"/);
  assert.match(analytics, /tradesComplete \? "available only when every recorded trade has net P&L" : "⚠️ Partial data — loaded records only \(history incomplete\)"/);
  assert.match(analytics, /!tradesComplete \? <div className="lockedText apiStateWarn">⚠️ Partial data — loaded records only \(history incomplete\)<\/div> : null/);
});

test('verified equity curve uses only the verified trades array', () => {
  assert.match(analytics, /const allPnlKnown = tradesComplete && trades\.length > 0 && trades\.every\(trade => safeNum\(trade\.net_pnl\) !== null\)/);
  assert.match(analytics, /equityPoints\(trades\)/);
  assert.doesNotMatch(analytics, /equityPoints\(derivedRows\)/);
});
