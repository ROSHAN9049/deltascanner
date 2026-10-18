import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('function Settings({');
const end = source.indexOf('\nfunction TradetronActivity', start);
const settings = source.slice(start, end);

test('Strategy Defaults explicitly discloses bridge trailing-stop limitation', () => {
  assert.match(settings, /Trailing stop: Not implemented by the scanner's bridge monitor/);
  assert.match(settings, /configure it in Tradetron strategy settings/);
});

test('Settings does not present the nonfunctional trail_r value as an editable control', () => {
  assert.doesNotMatch(settings, /<label>[^<]*trail_r/i);
  assert.doesNotMatch(settings, /value=\{settings\.trail_r\}/i);
});
