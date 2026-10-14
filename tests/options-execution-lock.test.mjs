import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONS_EXECUTION_ALLOWED,
  OPTIONS_EXECUTION_LOCK_REASON,
  isOptionsExecutionAllowed
} from '../worker/options-execution-lock.mjs';

test('Options entry execution remains locked independently of route configuration', () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  assert.equal(isOptionsExecutionAllowed(), false);
  assert.match(OPTIONS_EXECUTION_LOCK_REASON, /maximum loss/i);
});
