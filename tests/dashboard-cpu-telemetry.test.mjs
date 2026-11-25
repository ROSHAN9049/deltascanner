import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard renders API process CPU from the API health response field', async () => {
  const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /safeNum\(health\?\.apiProcessCpuPercent\)/);
  assert.doesNotMatch(source, /health\.workerCpuPercent/);
});
