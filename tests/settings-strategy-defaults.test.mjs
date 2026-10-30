import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../src/main.jsx',import.meta.url),'utf8');
const start=source.indexOf('function Settings({');
const end=source.indexOf('\nfunction Log(',start);
assert.notEqual(start,-1);
assert.notEqual(end,-1);
const settings=source.slice(start,end);

test('Strategy Defaults documents the implemented Momentum RSI gate',()=>{
  assert.match(settings,/Momentum: EMA9\/21\/50 \+ RSI BUY 45–80 \/ SELL 20–55 \+ adaptive volume gate \+ minimum SL distance ≥1\.50%/);
  assert.doesNotMatch(settings,/RSI 54–68 \/ 32–46/);
});

test('Strategy Defaults accurately names Scalping entry and trend timeframes',()=>{
  assert.match(settings,/Scalping: 1m EMA entry \+ 5m\/15m trend \+ RSI \+ VWAP \+ adaptive volume gate \+ minimum SL distance ≥1\.50%/);
  assert.doesNotMatch(settings,/Scalping: 1m\/5m EMA \+ RSI \+ VWAP/);
});

test('Strategy Defaults is Delta Testnet-focused and discloses exit-safety limitations',()=>{
  assert.match(settings,/Exits: Verify Delta Testnet exit orders and close events in the Delta Testnet Positions tab/);
  assert.match(settings,/Trailing stop: Do not assume trailing protection unless it is confirmed by the Delta Testnet execution configuration/);
  assert.match(settings,/These defaults describe scanner signal logic/);
  assert.match(settings,/Confirm active order protections and exit handling in the Delta Testnet execution view/);
  assert.doesNotMatch(settings,/Tradetron|tradetron|bridge monitor/i);
});
