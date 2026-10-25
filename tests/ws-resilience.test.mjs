import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldEmitThrottledLog,
  websocketReconnectDelay,
  WS_ERROR_LOG_COOLDOWN_MS,
  WS_RECONNECT_MAX_MS,
  WS_RATE_LIMIT_RECONNECT_MS
} from '../worker/ws-resilience.mjs';

test('WebSocket reconnect delay grows exponentially and stays bounded', () => {
  assert.equal(websocketReconnectDelay(0, { baseMs: 1_000 }), 1_000);
  assert.equal(websocketReconnectDelay(1, { baseMs: 1_000 }), 2_000);
  assert.equal(websocketReconnectDelay(4, { baseMs: 1_000 }), 16_000);
  assert.equal(websocketReconnectDelay(16, { baseMs: 1_000 }), WS_RECONNECT_MAX_MS);
});

test('rate-limited WebSocket connections use a long cool-off', () => {
  assert.equal(
    websocketReconnectDelay(0, { baseMs: 1_000, rateLimited: true }),
    WS_RATE_LIMIT_RECONNECT_MS
  );
  assert.ok(WS_RATE_LIMIT_RECONNECT_MS >= 5 * 60_000);
});

test('WebSocket warnings can be throttled without suppressing the next cooldown window', () => {
  const now = 10_000_000;
  assert.equal(shouldEmitThrottledLog(0, now, WS_ERROR_LOG_COOLDOWN_MS), true);
  assert.equal(shouldEmitThrottledLog(now, now + WS_ERROR_LOG_COOLDOWN_MS - 1, WS_ERROR_LOG_COOLDOWN_MS), false);
  assert.equal(shouldEmitThrottledLog(now, now + WS_ERROR_LOG_COOLDOWN_MS, WS_ERROR_LOG_COOLDOWN_MS), true);
});
