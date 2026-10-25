import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../src/main.jsx',import.meta.url),'utf8');
const start=source.indexOf('function Settings({');
const end=source.indexOf('\nfunction Log(',start);
assert.notEqual(start,-1);
assert.notEqual(end,-1);
const settings=source.slice(start,end);

test('Settings discloses that trailing protection must be verified on Delta Testnet',()=>{
  assert.match(settings,/Trailing stop: Do not assume trailing protection unless it is confirmed by the Delta Testnet execution configuration/);
  assert.match(settings,/Delta Testnet execution view/);
  assert.doesNotMatch(settings,/Tradetron|tradetron|bridge monitor/);
});

test('Settings does not present the nonfunctional trail_r value as an editable control',()=>{
  assert.doesNotMatch(settings,/<label>[^<]*trail_r/i);
  assert.doesNotMatch(settings,/value=\{settings\.trail_r\}/i);
});
