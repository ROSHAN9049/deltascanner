import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('Dashboard receives executionCoverage before dereferencing it', async () => {
  const source = await read('../src/main.jsx');
  assert.match(source, /<Dashboard[\\s\\S]*?executionCoverage=\\{executionCoverage\\}/);
  const signature = source.match(/function Dashboard\\(\\{([^}]+)\\}\\) \\{/);
  assert.ok(signature, 'Dashboard props signature should exist');
  assert.match(signature[1], /executionCoverage\\s*=\\s*null/);
  assert.match(source, /executionCoverage\\?\\.deltaExecutionMode/);
});

test('frontend normalizes API-provided collections before rendering array operations', async () => {
  const source = await read('../src/main.jsx');
  assert.match(source, /Array\\.isArray\\(state\\?\\.deltaTestnetTrades\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.deltaTestnetPositions\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.ledger\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.signalCache\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.optionCache\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.deltaTestnetOrders\\)/);
  assert.match(source, /Array\\.isArray\\(state\\?\\.logs\\)/);
});

test('top-level React error boundary renders a diagnostic instead of a blank screen', async () => {
  const source = await read('../src/main.jsx');
  assert.match(source, /class AppErrorBoundary extends React\\.Component/);
  assert.match(source, /static getDerivedStateFromError\\(error\\)/);
  assert.match(source, /componentDidCatch\\(error, info\\)/);
  assert.match(source, /Dashboard could not render/);
  assert.match(source, /createRoot\\(document\\.getElementById\\('root'\\)\\)\\.render\\(<AppErrorBoundary><App \\/><\\/AppErrorBoundary>\\)/);
});

test('engine state response exposes executionCoverage without legacy Tradetron payload dependencies', async () => {
  const api = await read('../api/engine/state.js');
  assert.match(api, /executionCoverage:\s*\\{/);
  assert.match(api, /deltaExecutionMode,/);
  assert.match(api, /directDeltaExecutionEnabled:\s*false/);
  const source = await read('../src/main.jsx');
  assert.doesNotMatch(source, /(?:state|data)\\.tradetron\\s*\\?/);
  assert.doesNotMatch(source, /tradetronDeveloperSnapshots|tradetronEvents|tradetronRouting/);
});
