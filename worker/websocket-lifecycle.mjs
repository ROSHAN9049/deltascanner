/**
 * Detach all callbacks owned by a websocket before it is discarded.
 * The worker creates a fresh socket for each reconnect, so callbacks must not
 * remain attached to sockets that have already entered teardown.
 */
export function cleanupWebSocketListeners(socket) {
  if (!socket || typeof socket.removeAllListeners !== 'function') return false;
  socket.removeAllListeners();
  return true;
}
