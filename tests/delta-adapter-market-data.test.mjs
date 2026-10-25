import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { resolveDeltaRequestBase } from '../worker/delta-adapter.mjs';

const PRODUCTION_REST = 'https://api.india.delta.exchange';
const TESTNET_REST = 'https://cdn-ind.testnet.deltaex.org';
const PRODUCTION_WS = 'wss://public-socket.india.delta.exchange';
const TESTNET_PRIVATE_WS = 'wss://socket-ind.testnet.deltaex.org';

test('scanner market data stays on the production public feed in Testnet execution mode', () => {
  assert.equal(CONFIG.marketDataRestBase, PRODUCTION_REST);
  assert.equal(CONFIG.publicWs, PRODUCTION_WS);
});

test('public ticker/candle requests use the production feed when execution REST is Testnet', () => {
  const config = { base: TESTNET_REST, marketDataBase: PRODUCTION_REST };
  assert.equal(resolveDeltaRequestBase({ marketData: true }, config), PRODUCTION_REST);
  assert.equal(resolveDeltaRequestBase({ marketData: true, auth: false }, config), PRODUCTION_REST);
});

test('Testnet product catalogue and private requests stay on the Testnet REST base', () => {
  const config = { base: TESTNET_REST, marketDataBase: PRODUCTION_REST };
  assert.equal(resolveDeltaRequestBase({}, config), TESTNET_REST);
  assert.equal(resolveDeltaRequestBase({ auth: true }, config), TESTNET_REST);
  // Authenticated account/order operations can never be switched to production
  // by accidentally passing the public market-data option.
  assert.equal(resolveDeltaRequestBase({ auth: true, marketData: true }, config), TESTNET_REST);
  assert.equal(CONFIG.privateWs, CONFIG.signalOnly ? '' : TESTNET_PRIVATE_WS);
});

test('production signal-only mode continues to use production REST for both bases', () => {
  const config = { base: PRODUCTION_REST, marketDataBase: PRODUCTION_REST };
  assert.equal(resolveDeltaRequestBase({}, config), PRODUCTION_REST);
  assert.equal(resolveDeltaRequestBase({ marketData: true }, config), PRODUCTION_REST);
});
