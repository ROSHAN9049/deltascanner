import test from 'node:test';
import assert from 'node:assert/strict';
import { getTradetronDiagnosticDetails } from '../src/tradetron-diagnostics.js';

test('extracts current worker bridge keys and payload coverage', () => {
  assert.deepEqual(getTradetronDiagnosticDetails({
    symbol: 'AAPLXUSD',
    side: 'BUY',
    strategy: 'MOMENTUM',
    entryVariableKey: 'AAPLXUSD_el',
    globalTriggerKey: 'api_buy',
    payloadVariableCount: 23,
    payloadVariableKeys: ['AAPLXUSD_el', 'api_buy', 'btc_trend']
  }), {
    symbol: 'AAPLXUSD',
    side: 'BUY',
    strategy: 'MOMENTUM',
    entryVariableKey: 'AAPLXUSD_el',
    globalTriggerKey: 'api_buy',
    payloadVariableCount: 23,
    payloadVariableKeys: ['AAPLXUSD_el', 'api_buy', 'btc_trend']
  });
});

test('supports persisted bridge metadata aliases and nested data objects', () => {
  assert.deepEqual(getTradetronDiagnosticDetails({
    data: {
      bridge_entry_variable_key: 'NEARUSD_es',
      bridge_global_trigger_key: 'api_sell',
      bridge_variable_count: 23,
      bridge_variable_keys: ['NEARUSD_es']
    }
  }), {
    symbol: '',
    side: '',
    strategy: '',
    entryVariableKey: 'NEARUSD_es',
    globalTriggerKey: 'api_sell',
    payloadVariableCount: 23,
    payloadVariableKeys: ['NEARUSD_es']
  });
});

test('does not expose raw payload or secret-like invalid key strings', () => {
  const result = getTradetronDiagnosticDetails({
    entryVariableKey: 'PAXGUSD_el',
    payloadVariableKeys: ['PAXGUSD_el', 'Authorization:Bearer-secret-token', 'bad key']
  });
  assert.deepEqual(result.payloadVariableKeys, ['PAXGUSD_el']);
  assert.equal(JSON.stringify(result).includes('Bearer-secret-token'), false);
});

test('returns null when a log has no bridge diagnostic metadata', () => {
  assert.equal(getTradetronDiagnosticDetails({ symbol: 'BTCUSD', message: 'market refreshed' }), null);
  assert.equal(getTradetronDiagnosticDetails(null), null);
});
