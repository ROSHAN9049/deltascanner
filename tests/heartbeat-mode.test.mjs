import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findWorkerHeartbeatRow, normalizeWorkerExecutionMode, protectEngineState } from '../server/engine-state-privacy.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('heartbeat parser recognizes the worker message after memory diagnostics suffix', () => {
  const heartbeat = {
    id: 12,
    message: 'Worker heartbeat scan RSS=76MB heapUsed=42MB',
    data: { executionMode: 'testnet', deltaExecutionMode: 'testnet' }
  };
  assert.equal(findWorkerHeartbeatRow([{ message: 'older unrelated log' }, heartbeat]), heartbeat);
  assert.equal(normalizeWorkerExecutionMode(heartbeat), 'testnet');
});

test('heartbeat parser accepts the legacy deltaExecutionMode alias', () => {
  assert.equal(normalizeWorkerExecutionMode({
    message: 'Worker heartbeat scan RSS=76MB',
    data: { deltaExecutionMode: 'testnet' }
  }), 'testnet');
  assert.equal(normalizeWorkerExecutionMode({ data: { executionMode: 'other' } }), 'unknown');
});

test('public state retains a normalized heartbeat mode without exposing account data', () => {
  const state = protectEngineState({
    executionCoverage: {
      directDeltaExecutionEnabled: false,
      deltaExecutionMode: 'testnet',
      deltaExecutionModeSource: 'supabase-worker-heartbeat'
    },
    logs: [{
      id: 12,
      level: 'INFO',
      message: 'Worker heartbeat scan RSS=76MB',
      created_at: '2026-10-26T00:00:00.000Z',
      data: { executionMode: 'testnet', deltaExecutionMode: 'testnet', deltaEnvironment: 'testnet' }
    }],
    deltaTestnetPositions: [{ symbol: 'BTCUSD', qty: 1 }],
    settings: { equity: 123 }
  }, false);

  assert.equal(state.executionCoverage.deltaExecutionMode, 'testnet');
  assert.equal(state.logs[0].data.executionMode, 'testnet');
  assert.equal(state.logs[0].data.deltaExecutionMode, 'testnet');
  assert.deepEqual(state.deltaTestnetPositions, []);
  assert.equal(state.settings.equity, null);
});

test('worker heartbeat writes the generic executionMode alias and canonical delta field', async () => {
  const engine = await read('../worker/engine.mjs');
  assert.match(engine, /executionMode: CONFIG\.deltaExecutionMode/);
  assert.match(engine, /deltaExecutionMode: CONFIG\.deltaExecutionMode/);
});
