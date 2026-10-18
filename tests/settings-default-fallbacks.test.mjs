import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function Settings({');
const end = source.indexOf('\nfunction TradetronActivity', start);
const settings = source.slice(start, end);

test('Settings fallback values match db/schema.sql defaults', () => {
  assert.match(settings, /riskPct: settings\.risk_pct \?\? 1,/);
  assert.match(settings, /momentumRr: settings\.momentum_rr \?\? 2\.5,/);
  assert.match(settings, /scalpingRr: settings\.scalping_rr \?\? 2\.5,/);
  assert.doesNotMatch(settings, /riskPct: settings\.risk_pct \?\? 0\.3,/);
  assert.doesNotMatch(settings, /momentumRr: settings\.momentum_rr \?\? 2\.0,/);
  assert.doesNotMatch(settings, /scalpingRr: settings\.scalping_rr \?\? 2\.0,/);
});
