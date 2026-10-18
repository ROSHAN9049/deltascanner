import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const historyStart = source.indexOf('function TradeHistory({');
const historyEnd = source.indexOf('\nfunction PNL(', historyStart);
assert.notEqual(historyStart, -1);
assert.notEqual(historyEnd, -1);
const history = source.slice(historyStart, historyEnd);

test('Momentum History, Scalp History, and Trade History receive total API-derived count', () => {
  const callSites = [
    /tab === 'momentum-history' && <TradeHistory[^\n]*strategy="MOMENTUM"[^\n]*apiDerivedTradeCount=\{state\?\.apiDerivedTradeCount \?\? null\}/,
    /tab === 'scalp-history' && <TradeHistory[^\n]*strategy="SCALPING"[^\n]*apiDerivedTradeCount=\{state\?\.apiDerivedTradeCount \?\? null\}/,
    /tab === 'trade-history' && <><TradeHistory/
  ];
  assert.match(source, callSites[0]);
  assert.match(source, callSites[1]);
  assert.match(source, /tab === 'trade-history' && <><TradeHistory[^\n]*apiDerivedTradeCount=\{state\?\.apiDerivedTradeCount \?\? null\}/);
});

test('all history tabs share the same API-derived, unverified section and strategy filter', () => {
  assert.match(history, /API-Derived History · Unverified/);
  assert.match(history, /Derived from API snapshots\. Not verified fills\./);
  assert.match(history, /filter\(row => !strategy \|\| String\(row\?\.strategy \|\| ''\)\.toUpperCase\(\) === String\(strategy\)\.toUpperCase\(\)\)/);
  assert.match(history, /UNVERIFIED/);
  assert.match(history, /RAW/);
});

test('API-derived coverage distinguishes complete, partial, count mismatch, and unknown', () => {
  assert.match(history, /derivedCoverage === 'COMPLETE'/);
  assert.match(history, /derivedCoverage === 'PARTIAL'/);
  assert.match(history, /derivedCoverage === 'MISMATCH'/);
  assert.match(history, /derivedCoverage === 'UNKNOWN'/);
  assert.match(history, /Partial API-derived history — loaded/);
  assert.match(history, /row-count mismatch/);
  assert.match(history, /Exact API-derived row count unavailable/);
});

test('strategy tabs give a scoped honest empty state without treating missing rows as verified closes', () => {
  assert.match(history, /No API-derived closes stored yet for \$\{strategy\}/);
  assert.match(history, /No API-derived closes match \$\{strategy\}/);
  assert.match(history, /No API-derived closes stored yet\. Monitoring active\./);
  assert.match(history, /No API-derived rows are available in the current response/);
  assert.match(history, /trades\.map\(t =>/);
  assert.doesNotMatch(history, /const allTrades = \[\.\.\.trades, \.\.\.derivedRows\]/);
});
