import test from 'node:test';
import assert from 'node:assert/strict';
import { runCleanupThenStartWorker } from '../scripts/hostless-testnet-cleanup-runner.mjs';

test('runner explicitly confirms cleanup and starts the normal worker after verified close', async () => {
  let cleanupArgs;
  let workerStarted = false;
  const logs = [];
  await runCleanupThenStartWorker({
    runCleanup: async options => {
      cleanupArgs = options.argv;
      return {
        initialOpenPositions: 2,
        closeOrdersSubmitted: 2,
        failures: [],
        remainingPositions: [],
        verifiedFlat: true
      };
    },
    startWorker: async () => { workerStarted = true; },
    log: message => logs.push(message),
    warn: message => logs.push(message)
  });

  assert.deepEqual(cleanupArgs, ['--confirm']);
  assert.equal(workerStarted, true);
  assert.ok(logs.some(message => message.includes('"verifiedFlat":true')));
});

test('runner starts the normal worker after cleanup error without retrying cleanup', async () => {
  let workerStarted = false;
  const warnings = [];
  let attempts = 0;
  await runCleanupThenStartWorker({
    runCleanup: async () => {
      attempts += 1;
      throw new Error('simulated Testnet API failure');
    },
    startWorker: async () => { workerStarted = true; },
    log: () => {},
    warn: message => warnings.push(message)
  });

  assert.equal(attempts, 1);
  assert.equal(workerStarted, true);
  assert.ok(warnings.some(message => message.includes('simulated Testnet API failure')));
});
