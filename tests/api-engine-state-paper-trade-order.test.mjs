import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('paperTradeResult is initialized before dashboard availability reads it', async () => {
  const source = await readFile(new URL('../api/engine/state.js', import.meta.url), 'utf8');
  const resultDeclaration = source.indexOf('      paperTradeResult,');
  const availabilityRead = source.indexOf('    const dataAvailability = {');
  assert.notEqual(resultDeclaration, -1, 'paperTradeResult must be part of the private-data query result');
  assert.notEqual(availabilityRead, -1, 'dashboard availability state must be present');
  assert.ok(
    resultDeclaration < availabilityRead,
    'paperTradeResult must be initialized before dataAvailability accesses it'
  );
});
