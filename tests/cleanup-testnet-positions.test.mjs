import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/cleanup-testnet-positions.mjs', import.meta.url));

function run(args, overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DELTA_EXECUTION_MODE: 'disabled',
      DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org',
      DELTA_TESTNET_API_KEY: '',
      DELTA_TESTNET_API_SECRET: '',
      GITHUB_STEP_SUMMARY: '',
      ...overrides
    },
    timeout: 5000
  });
}

test('audit default refuses to run unless Testnet mode is explicit', () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELTA_EXECUTION_MODE must be exactly "testnet"/);
});

test('close without --confirm is blocked before credentials or network are used', () => {
  const result = run(['--close']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--close requires --confirm/);
  assert.doesNotMatch(result.stderr, /API_KEY|fetch failed|ENOTFOUND/);
});

test('--action audit syntax is parsed and still requires Testnet mode', () => {
  const result = run(['--action', 'audit']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELTA_EXECUTION_MODE must be exactly "testnet"/);
  assert.doesNotMatch(result.stderr, /Unknown argument: audit/);
});

test('production REST endpoint is rejected before any API request', () => {
  const result = run(['--audit'], {
    DELTA_EXECUTION_MODE: 'testnet',
    DELTA_TESTNET_API_KEY: 'test-key-not-used',
    DELTA_TESTNET_API_SECRET: 'test-secret-not-used',
    DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hardcoded Delta India Testnet URL/);
});
