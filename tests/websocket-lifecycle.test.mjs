import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cleanupWebSocketListeners } from '../worker/websocket-lifecycle.mjs';

test('teardown removes old websocket callbacks and safely absorbs late errors', () => {
  const socket = new EventEmitter();
  let messages = 0;
  socket.on('message', () => { messages += 1; });
  socket.on('close', () => { messages += 10; });
  socket.on('error', () => { messages += 100; });
  assert.equal(socket.listenerCount('message'), 1);
  assert.equal(cleanupWebSocketListeners(socket), true);
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), 1);
  socket.emit('message');
  socket.emit('close');
  assert.doesNotThrow(() => socket.emit('error', new Error('late socket teardown error')));
  assert.equal(messages, 0);
});

test('teardown is safe for null and non-event-emitter inputs', () => {
  assert.equal(cleanupWebSocketListeners(null), false);
  assert.equal(cleanupWebSocketListeners({}), false);
});
