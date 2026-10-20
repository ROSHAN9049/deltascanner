import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRetentionHealth } from '../src/retention-health.js';

const summary = (created_at, status, rowsDeleted, configDays = 1) => ({
  created_at,
  message: '[Retention] Run summary',
  data: { status, rowsDeleted, configDays }
});

test('retention health reports latest run, last success, deleted rows, and consecutive failures', () => {
  const result = summarizeRetentionHealth([
    summary('2026-10-20T10:00:00.000Z', 'FAILURE', 17, 1),
    summary('2026-10-20T09:30:00.000Z', 'FAILURE', 0, 1),
    summary('2026-10-20T09:00:00.000Z', 'SUCCESS', 4200, 1),
    { created_at: '2026-10-20T10:01:00.000Z', message: '[Disk] DB', data: { status: 'FAILURE' } }
  ]);

  assert.deepEqual(result, {
    lastRun: '2026-10-20T10:00:00.000Z',
    lastSuccess: '2026-10-20T09:00:00.000Z',
    rowsDeleted: 17,
    consecutiveFailures: 2,
    configDays: 1
  });
});

test('a successful latest retention run resets consecutive failures', () => {
  const result = summarizeRetentionHealth([
    summary('2026-10-20T10:00:00.000Z', 'SUCCESS', 0, 1),
    summary('2026-10-20T09:00:00.000Z', 'FAILURE', 0, 1)
  ]);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.lastRun, '2026-10-20T10:00:00.000Z');
  assert.equal(result.lastSuccess, '2026-10-20T10:00:00.000Z');
});

test('missing retention history reports null timestamps and one-day default config', () => {
  assert.deepEqual(summarizeRetentionHealth([]), {
    lastRun: null,
    lastSuccess: null,
    rowsDeleted: 0,
    consecutiveFailures: 0,
    configDays: 1
  });
});
