function parseData(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

export function summarizeOptionsAutoTriggerHealth(rows, {
  now = Date.now(),
  freshnessMs = 150_000
} = {}) {
  const row = Array.isArray(rows) ? rows[0] : null;
  const data = parseData(row?.data);
  const timestamp = Date.parse(row?.created_at || '');
  const heartbeatFresh = Number.isFinite(timestamp) &&
    timestamp <= now + 5000 &&
    Math.max(0, now - timestamp) <= freshnessMs;
  const mode = ['PREVIEW_ONLY', 'AUTO_EXECUTE'].includes(data.mode) ? data.mode : 'UNKNOWN';
  const fullAutoExecute = heartbeatFresh && typeof data.fullAutoExecute === 'boolean'
    ? data.fullAutoExecute
    : null;

  return {
    enabled: heartbeatFresh && data.enabled === true,
    mode,
    fullAutoExecute,
    status: heartbeatFresh && typeof data.status === 'string' ? data.status : 'STALE',
    candidateReady: heartbeatFresh && data.candidateReady === true,
    heartbeatAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    heartbeatFresh
  };
}
