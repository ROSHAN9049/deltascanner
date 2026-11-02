import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('dashboard state API only queries and returns Delta Testnet execution records', async () => {
  const api = await read('../api/engine/state.js');
  assert.doesNotMatch(api, /tradetron|dd_tradetron|apiDerivedTrades|dd_api_derived_trades/i);
  assert.match(api, /dd_delta_positions/);
  assert.match(api, /deltaTestnetPositions/);
  assert.match(api, /deltaTestnetTrades/);
  assert.match(api, /deltaTestnetOpenPositionCount/);
  assert.match(api, /deltaExecutionMode/);
});

test('legacy Tradetron Vercel webhook endpoint has been removed', async () => {
  await assert.rejects(access(new URL('../api/tradetron/webhook.js', import.meta.url)));
});

test('worker disables Tradetron routes, keeps Testnet Grid hard-locked, and keeps Options locked', async () => {
  const engine = await read('../worker/engine.mjs');
  const config = await read('../server/config.js');
  assert.doesNotMatch(engine, /void this\.syncTradetronDeveloperApi\(\)/);
  assert.doesNotMatch(engine, /manageDeltaTestnetGrid/);
  assert.match(engine, /Delta Testnet Grid execution remains hard-locked/);
  assert.match(engine, /CONFIG\.deltaExecutionMode === 'testnet'/);
  assert.doesNotMatch(engine, /async openOptionTrade\(/);
  assert.doesNotMatch(engine, /emitOptionEntry\(|emitOptionSpread\(/);
  assert.match(engine, /getExecutionRouteBlockReason\(CONFIG\.deltaExecutionMode, directTestnetEnabled\)/);
  assert.match(config, /tradetronBridgeEnabled: false/);
  assert.match(config, /tradetronDynamicBridgeEnabled: false/);
  assert.match(config, /tradetronOptionsBridgeEnabled: false/);
  assert.match(config, /tradetronDeveloperApiKey: ''/);
  assert.match(engine, /deltaExecutionMode: CONFIG\.deltaExecutionMode/);
});
