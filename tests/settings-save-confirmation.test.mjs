import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const start = source.indexOf('function Settings({');
const end = source.indexOf('\nfunction TradetronActivity', start);
const settings = source.slice(start, end);

test('Save Settings validates and opens confirmation without persisting immediately', () => {
  const requestStart = settings.indexOf('const saveSettings = event => {');
  const confirmStart = settings.indexOf('const confirmSaveSettings = async () => {');
  assert.notEqual(requestStart, -1);
  assert.ok(confirmStart > requestStart);
  const requestHandler = settings.slice(requestStart, settings.indexOf('const cancelSaveSettings', requestStart));
  assert.match(requestHandler, /setPendingSettingsPatch\(patch\)/);
  assert.match(requestHandler, /setShowSaveConfirmation\(true\)/);
  assert.doesNotMatch(requestHandler, /await mutate\(patch\)/);
});

test('confirmation dialog has Cancel and Save; only Save runs existing persistence flow', () => {
  assert.match(settings, /Save settings to server\?/);
  assert.match(settings, /Changes to risk %, RR, TP1%, max hold, and other settings will take effect on the next scan cycle/);
  assert.match(settings, /onClick=\{cancelSaveSettings\}/);
  assert.match(settings, /onClick=\{confirmSaveSettings\}/);
  assert.match(settings, /const cancelSaveSettings = \(\) => \{\s*setShowSaveConfirmation\(false\);\s*setPendingSettingsPatch\(null\);/);
  assert.match(settings, /const confirmSaveSettings = async \(\) => \{[\s\S]*?await mutate\(patch\)/);
  assert.match(settings, /Settings saved to server\./);
  assert.match(settings, /Save failed\. Check the error message above and retry\./);
});

test('confirmation dialog is styled and accessible as a modal', () => {
  assert.match(settings, /role="dialog" aria-modal="true"/);
  assert.match(css, /\.confirmOverlay\{position:fixed;inset:0/);
  assert.match(css, /\.confirmDialog/);
});
