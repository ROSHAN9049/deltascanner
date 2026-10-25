import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getGlobalPositionCapDisplay } from '../src/worker-status-display.js';

test('trusted cap telemetry shows ACTIVE below the configured limit', () => {
  assert.deepEqual(getGlobalPositionCapDisplay({maxOpenPositions:20,currentOpenPositions:12,trusted:true}), {
    state:'ACTIVE',className:'cap-active',currentOpenPositions:12,maxOpenPositions:20,capReached:false
  });
});

test('cap telemetry shows REACHED at and above the configured limit', () => {
  for(const currentOpenPositions of [20,21]){
    const status=getGlobalPositionCapDisplay({maxOpenPositions:20,currentOpenPositions,trusted:true});
    assert.equal(status.state,'REACHED');
    assert.equal(status.className,'cap-reached');
    assert.equal(status.capReached,true);
    assert.equal(status.currentOpenPositions,currentOpenPositions);
    assert.equal(status.maxOpenPositions,20);
  }
});

test('untrusted or missing position count fails closed to STATUS UNKNOWN', () => {
  for(const input of [
    {maxOpenPositions:20,currentOpenPositions:20,trusted:false},
    {maxOpenPositions:20,currentOpenPositions:null,trusted:true},
    {maxOpenPositions:20,currentOpenPositions:-1,trusted:true},
    {maxOpenPositions:null,currentOpenPositions:5,trusted:true}
  ]){
    const status=getGlobalPositionCapDisplay(input);
    assert.equal(status.state,'UNKNOWN');
    assert.equal(status.className,'cap-unknown');
    assert.equal(status.currentOpenPositions,null);
    assert.equal(status.capReached,false);
  }
});

test('Settings uses the Delta Testnet open-position count and never claims the cap is disabled', async () => {
  const source=await readFile(new URL('../src/main.jsx',import.meta.url),'utf8');
  const css=await readFile(new URL('../src/style.css',import.meta.url),'utf8');
  const start=source.indexOf('function Settings({');
  const end=source.indexOf('\nfunction Log(',start);
  assert.notEqual(start,-1);
  assert.notEqual(end,-1);
  const settings=source.slice(start,end);
  assert.match(source,/currentOpenPositions=\{state\?\.deltaTestnetOpenPositionCount \?\? null\}/);
  assert.match(settings,/currentOpenPositions = null/);
  assert.match(settings,/currentOpenPositions,/);
  assert.match(settings,/trusted: safeNum\(currentOpenPositions\) !== null/);
  assert.match(settings,/Global position cap: ACTIVE/);
  assert.match(settings,/Global position cap: REACHED/);
  assert.match(settings,/Global position cap: STATUS UNKNOWN/);
  assert.doesNotMatch(settings,/Global scanner position cap: DISABLED|workerEntrySafety|Tradetron/i);
  assert.match(css,/\.capStatus\.cap-active/);
  assert.match(css,/\.capStatus\.cap-reached/);
  assert.match(css,/\.capStatus\.cap-unknown/);
});
