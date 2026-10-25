export const WS_ERROR_LOG_COOLDOWN_MS = 60_000;
export const WS_RECONNECT_MAX_MS = 5 * 60_000;
export const WS_RATE_LIMIT_RECONNECT_MS = 5 * 60_000;

/**
 * Exponential WebSocket reconnect with a conservative cap. Delta documents a
 * 5–10 minute cool-off after connection-rate limiting; do not retry a 429 in
 * the ordinary fast reconnect loop.
 */
export function websocketReconnectDelay(
  retryCount,
  { baseMs = 5_000, maxMs = WS_RECONNECT_MAX_MS, rateLimited = false } = {}
) {
  const base = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : 5_000;
  const max = Number.isFinite(Number(maxMs)) && Number(maxMs) >= base
    ? Number(maxMs) : WS_RECONNECT_MAX_MS;
  if (rateLimited) return Math.min(max, Math.max(base, WS_RATE_LIMIT_RECONNECT_MS));
  const attempt = Math.max(0, Math.min(16, Math.floor(Number(retryCount) || 0)));
  return Math.min(max, base * (2 ** attempt));
}

export function shouldEmitThrottledLog(lastLoggedAt, now = Date.now(), cooldownMs = WS_ERROR_LOG_COOLDOWN_MS) {
  const last = Number(lastLoggedAt);
  const current = Number(now);
  const cooldown = Math.max(0, Number(cooldownMs) || 0);
  return !Number.isFinite(last) || last <= 0 ||
    !Number.isFinite(current) || current - last >= cooldown;
}
