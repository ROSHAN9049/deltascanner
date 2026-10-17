import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTradetronSignalFailure,
  sanitizeTradetronFailureDetail
} from '../worker/signal-failure-diagnostics.mjs';

test('classifies global position cap blocks explicitly', () => {
  assert.equal(classifyTradetronSignalFailure({
    positionSafetyBlocked: true,
    globalPositionCapBlocked: true,
    reason: 'Global open-position limit reached (20/20)'
  }), 'position_cap_block');
});

test('classifies API response and connection errors', () => {
  assert.equal(classifyTradetronSignalFailure({ message: 'Tradetron API 502: Bad Gateway' }), 'api_error');
  assert.equal(classifyTradetronSignalFailure(new TypeError('fetch failed')), 'api_error');
});

test('does not mislabel untrusted snapshot or position-cap lookup failures as cap reached', () => {
  assert.equal(classifyTradetronSignalFailure({
    positionSafetyBlocked: true,
    globalPositionCapBlocked: false,
    reason: 'POSITION_SNAPSHOT_UNTRUSTED:OPEN_POSITION_COUNT_UNRECONCILED'
  }), 'unknown');
  assert.equal(classifyTradetronSignalFailure({
    reason: 'POSITION_CAP_LOOKUP_FAILED:Supabase 502: Bad Gateway'
  }), 'api_error');
});

test('classifies routing and signal expiry outcomes', () => {
  assert.equal(classifyTradetronSignalFailure({ reason: 'No configured bridge route for symbol' }), 'routing_error');
  assert.equal(classifyTradetronSignalFailure({ reason: 'Signal reservation expired before confirmation' }), 'signal_expired');
});

test('unknown is the safe fallback for incomplete diagnostics', () => {
  assert.equal(classifyTradetronSignalFailure({}), 'unknown');
});

test('sanitizes credentials and bounds detail length', () => {
  const value = sanitizeTradetronFailureDetail(
    'Tradetron API 401: Authorization: Bearer abc.def.ghi\n token=my-secret password="super secret"'
  );
  assert.match(value, /Authorization:.*REDACTED/i);
  assert.match(value, /token=\[REDACTED\]/i);
  assert.match(value, /password=\[REDACTED\]/i);
  assert.doesNotMatch(value, /abc\.def|my-secret|super secret/);
  assert.equal(sanitizeTradetronFailureDetail('x'.repeat(500)).length, 240);
});
