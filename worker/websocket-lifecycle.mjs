/**
 * Detach application callbacks before a websocket is discarded. Keep one inert
 * error listener so a late socket-level error during close/terminate cannot
 * become an unhandled EventEmitter "error" and crash the worker.
 */
export function cleanupWebSocketListeners(socket) {
  if (!socket || typeof socket.removeAllListeners !== 'function') return false;
  socket.removeAllListeners();
  if (typeof socket.on === 'function') socket.on('error', () => {});
  return true;
}
