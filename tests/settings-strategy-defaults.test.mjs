import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function Settings({');
const end = source.indexOf('\nfunction TradetronActivity', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const settings = source.slice(start, end);

test('Strategy Defaults documents the implemented Momentum RSI gate', () => {
  assert.match(settings, /Momentum: EMA9\/21\/50 \+ RSI BUY 45–80 \/ SELL 20–55/);
  assert.doesNotMatch(settings, /RSI 54–68 \/ 32–46/);
});

test('Strategy Defaults accurately names Scalping entry and trend timeframes', () => {
  assert.match(settings, /Scalping: 1m EMA entry \+ 5m\/15m trend \+ RSI \+ VWAP/);
  assert.doesNotMatch(settings, /Scalping: 1m\/5m EMA \+ RSI \+ VWAP/);
});

test('Strategy Defaults does not claim the bridge enforces partial exits or trailing', () => {
  assert.match(settings, /Scanner sends TP1 price and final TP to Tradetron/);
  assert.match(settings, /Partial-exit %, breakeven, and trailing rules are NOT enforced by the scanner's bridge monitor/);
  assert.match(settings, /These defaults describe the scanner's signal logic/);
  assert.match(settings, /Actual exit execution is managed by your Tradetron strategy configuration/);
});
