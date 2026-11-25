/**
 * Resolve the stable epoch-minute bucket for a signal candle.
 *
 * analyse() stores signalCandleTs as an epoch-minute integer. Other callers
 * may provide candleTs/timestamp as epoch seconds or milliseconds. Missing
 * timestamps are rejected rather than replaced with Date.now(), because a
 * moving fallback would defeat same-candle order idempotency.
 */
export function resolveSignalCandleMinute(signal = {}) {
  const explicit = Number(signal?.signalCandleTs);
  if (Number.isSafeInteger(explicit) && explicit > 0) {
    if (explicit > 1e12) return Math.floor(explicit / 60_000);
    if (explicit > 1e9) return Math.floor(explicit / 60);
    if (explicit > 1e6) return explicit;
  }

  const raw = Number(signal?.candleTs ?? signal?.timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw > 1e12) return Math.floor(raw / 60_000);
  if (raw > 1e9) return Math.floor(raw / 60);
  if (Number.isSafeInteger(raw) && raw > 1e6) return raw;
  return null;
}
