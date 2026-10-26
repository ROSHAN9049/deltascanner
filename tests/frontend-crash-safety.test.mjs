import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('market table no longer invokes the deleted Tradetron route helper', async () => {
  const source = await read('../src/main.jsx');
  assert.ok(source.includes('function MarketTable({ market, signals, openPositionSymbols = new Set() }) {'));
  assert.equal(source.includes('routeStatusForSymbol'), false);
  assert.equal(source.includes('<th>TT ROUTE</th>'), false);
  assert.ok(source.includes('<th>POSITION</th>'));
  assert.ok(source.includes("An open Delta Testnet position exists for this symbol."));
});

test('Dashboard gets executionCoverage and safely normalizes API collections', async () => {
  const source = await read('../src/main.jsx');
  assert.ok(source.includes('executionCoverage={executionCoverage}'));
  assert.ok(source.includes('executionCoverage = null, onInspect'));
  assert.ok(source.includes("const trades = Array.isArray(state?.deltaTestnetTrades) ? state.deltaTestnetTrades : [];"));
  assert.ok(source.includes("const positions = Array.isArray(state?.deltaTestnetPositions) ? state.deltaTestnetPositions : [];"));
  assert.ok(source.includes("const rotationLedger = Array.isArray(state?.ledger) ? state.ledger : [];"));
  assert.ok(source.includes('const signalRows = Array.isArray(state?.signalCache)'));
  assert.ok(source.includes('const optionCache = Array.isArray(state?.optionCache) ? state.optionCache : [];'));
  assert.ok(source.includes('const deltaTestnetOrders = Array.isArray(state?.deltaTestnetOrders) ? state.deltaTestnetOrders : [];'));
  assert.ok(source.includes('const logs = Array.isArray(state?.logs) ? state.logs : [];'));
});

test('top-level React error boundary renders a diagnostic instead of a blank screen', async () => {
  const source = await read('../src/main.jsx');
  assert.ok(source.includes('class AppErrorBoundary extends React.Component'));
  assert.ok(source.includes('static getDerivedStateFromError(error)'));
  assert.ok(source.includes('componentDidCatch(error, info)'));
  assert.ok(source.includes('Dashboard could not render'));
  assert.ok(source.includes("createRoot(document.getElementById('root')).render(<AppErrorBoundary><App /></AppErrorBoundary>);"));
});

test('engine state API exposes the Delta execution shape; frontend has no direct legacy Tradetron state reads', async () => {
  const api = await read('../api/engine/state.js');
  const source = await read('../src/main.jsx');
  assert.ok(api.includes('executionCoverage: {'));
  assert.ok(api.includes('deltaExecutionMode,'));
  assert.ok(api.includes('directDeltaExecutionEnabled: false,'));
  assert.equal(source.includes('state.tradetron'), false);
  assert.equal(source.includes('data.tradetron'), false);
  assert.equal(source.includes('tradetronDeveloperSnapshots'), false);
  assert.equal(source.includes('tradetronEvents'), false);
  assert.equal(source.includes('tradetronRouting'), false);
});
