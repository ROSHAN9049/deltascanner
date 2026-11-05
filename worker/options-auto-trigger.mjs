const DEFAULT_API_ORIGIN = 'https://deltascanner-api-v2.hostless.app';
export const OPTIONS_AUTO_TRIGGER_INTERVAL_MS = 60_000;
const MAX_CANDIDATE_AGE_MS = 5 * 60_000;
const OPTION_STRATEGIES = new Set(['OPTIONS_BUY', 'OPTIONS_SELL']);
const ACTIVE_ORDER_STATES = 'PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED';

const clean = value => String(value ?? '').trim();
const upper = value => clean(value).toUpperCase();
const finite = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const isEnabled = value => String(value ?? '').trim().toLowerCase() === 'true';

function parseDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function resolvePreviewUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_API_ORIGIN);
  } catch {
    throw new Error('Options auto-trigger API URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Options auto-trigger API URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin + '/api/options/preview';
}

function safeError(error, secret) {
  let message = clean(error?.message || error || 'Unknown auto-trigger error');
  if (secret) message = message.split(secret).join('[REDACTED]');
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

export function createOptionsAutoTrigger({
  env = process.env,
  database,
  fetchImpl = (...args) => fetch(...args),
  logger = async () => {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (typeof database?.select !== 'function') {
    throw new Error('Options auto-trigger requires the database select function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Options auto-trigger requires fetch');
  }

  const enabled = isEnabled(env.AUTO_EXECUTE_OPTIONS);
  let timer = null;
  let started = false;
  let inFlight = null;

  async function writeHeartbeat(status, extra = {}) {
    await logger('INFO', '[AUTO-TRIGGER] Worker heartbeat', {
      enabled,
      mode: 'PREVIEW_ONLY',
      status,
      candidateReady: false,
      lastScanAt: new Date(now()).toISOString(),
      ...extra
    });
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const engineSecret = clean(env.ENGINE_SECRET);
      if (!enabled) {
        await writeHeartbeat('DISABLED');
        return { status: 'DISABLED', previewRequested: false };
      }

      try {
        if (clean(env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet') {
          await writeHeartbeat('BLOCKED_NOT_TESTNET', { reason: 'Worker execution profile is not Delta Testnet' });
          return { status: 'BLOCKED_NOT_TESTNET', previewRequested: false };
        }
        if (!engineSecret) throw new Error('ENGINE_SECRET is unavailable');
        const previewUrl = resolvePreviewUrl(env.OPTIONS_AUTO_TRIGGER_API_URL);

        const settingsRows = await database.select(
          'dd_settings',
          'id=eq.1&select=enabled,auto_trade,emergency_stop,max_options_positions'
        );
        if (!Array.isArray(settingsRows) || settingsRows.length !== 1) {
          throw new Error('Options auto-trigger settings are missing or ambiguous');
        }
        const settings = settingsRows[0];
        if (settings.enabled !== true) {
          await writeHeartbeat('BLOCKED_ENGINE_DISABLED');
          return { status: 'BLOCKED_ENGINE_DISABLED', previewRequested: false };
        }
        if (settings.auto_trade !== true) {
          await writeHeartbeat('BLOCKED_AUTO_TRADE', { reason: 'auto_trade is not true' });
          return { status: 'BLOCKED_AUTO_TRADE', previewRequested: false };
        }
        if (settings.emergency_stop !== false) {
          await writeHeartbeat('BLOCKED_ESTOP', { reason: 'emergency_stop is active or unknown' });
          return { status: 'BLOCKED_ESTOP', previewRequested: false };
        }

        const maxPositions = finite(settings.max_options_positions);
        if (!Number.isSafeInteger(maxPositions) || maxPositions < 1) {
          throw new Error('max_options_positions is missing or invalid');
        }

        const scanAt = now();
        const recentFilledAfter = encodeURIComponent(new Date(scanAt - 120_000).toISOString());
        const [cacheRows, openPositions, activeOrders, recentFilledOrders] = await Promise.all([
          database.select(
            'dd_option_cache',
            'stage=eq.CONFIRMED&select=symbol,strategy,score,stage,cached_at,details&order=score.desc&limit=100'
          ),
          database.select(
            'dd_delta_positions',
            'strategy=in.(OPTIONS_BUY,OPTIONS_SELL,OPTIONS)&status=eq.OPEN&select=symbol&limit=500'
          ),
          database.select(
            'dd_orders',
            'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&state=in.(' + ACTIVE_ORDER_STATES + ')&select=symbol,state&limit=500'
          ),
          database.select(
            'dd_orders',
            'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&state=eq.FILLED&created_at=gte.' +
              recentFilledAfter + '&select=symbol,state&limit=500'
          )
        ]);
        if (!Array.isArray(cacheRows) || !Array.isArray(openPositions) ||
            !Array.isArray(activeOrders) || !Array.isArray(recentFilledOrders)) {
          throw new Error('Options cache or position/reservation snapshot is incomplete');
        }

        const occupied = new Set([
          ...openPositions.map(row => upper(row?.symbol)),
          ...activeOrders.map(row => upper(row?.symbol)),
          ...recentFilledOrders.map(row => upper(row?.symbol))
        ].filter(Boolean));
        if (occupied.size >= maxPositions) {
          await writeHeartbeat('BLOCKED_POSITION_CAP', {
            occupiedPositions: occupied.size,
            maxOptionsPositions: maxPositions
          });
          return { status: 'BLOCKED_POSITION_CAP', previewRequested: false };
        }

        const candidates = cacheRows.filter(row => {
          const symbol = upper(row?.symbol);
          const strategy = upper(row?.strategy);
          const cachedAt = Date.parse(row?.cached_at || '');
          const details = parseDetails(row?.details);
          return symbol &&
            OPTION_STRATEGIES.has(strategy) &&
            upper(row?.stage) === 'CONFIRMED' &&
            finite(row?.score) >= 80 &&
            details.analysisReady === true &&
            Number.isFinite(cachedAt) &&
            cachedAt <= scanAt + 5000 &&
            scanAt - cachedAt <= MAX_CANDIDATE_AGE_MS;
        }).sort((a, b) => (finite(b.score) || 0) - (finite(a.score) || 0));

        const candidate = candidates.find(row => !occupied.has(upper(row.symbol)));
        if (!candidate) {
          await writeHeartbeat('READY', {
            candidateReady: false,
            candidateCount: candidates.length,
            duplicateCount: candidates.length
          });
          return { status: 'READY', previewRequested: false, candidateCount: candidates.length };
        }

        const response = await fetchImpl(previewUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-engine-secret': engineSecret
          },
          body: JSON.stringify({
            symbol: upper(candidate.symbol),
            strategy: upper(candidate.strategy),
            qty: 1,
            manualOverride: false
          })
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error('Options preview API returned a non-JSON response');
        }
        if (!response.ok || payload?.success !== true || !payload?.preview) {
          throw new Error(payload?.error || 'Options preview API rejected the candidate');
        }

        const preview = payload.preview;
        if (typeof preview.quoteToken !== 'string' || !preview.quoteToken.trim()) {
          throw new Error('Options preview did not return a confirmation token');
        }
        if (preview.executionAllowed !== true) {
          await writeHeartbeat('BLOCKED_PREVIEW', {
            symbol: upper(candidate.symbol),
            strategy: upper(candidate.strategy),
            reason: clean(preview.executionLockReason || 'Options preview safety checks blocked this candidate')
          });
          return { status: 'BLOCKED_PREVIEW', previewRequested: true, candidate: upper(candidate.symbol) };
        }

        await logger(
          'INFO',
          '[AUTO-TRIGGER] Candidate ready for execution. Token acquired. Waiting for manual execution.',
          {
            symbol: upper(candidate.symbol),
            strategy: upper(candidate.strategy),
            mode: 'PREVIEW_ONLY',
            tokenAcquired: true,
            orderSubmitted: false
          }
        );
        await writeHeartbeat('CANDIDATE_READY', {
          candidateReady: true,
          symbol: upper(candidate.symbol),
          strategy: upper(candidate.strategy),
          orderSubmitted: false
        });
        // The short-lived quote token is intentionally not persisted or logged.
        return { status: 'CANDIDATE_READY', previewRequested: true, candidate: upper(candidate.symbol) };
      } catch (error) {
        const message = safeError(error, engineSecret);
        await writeHeartbeat('ERROR', { error: message });
        return { status: 'ERROR', previewRequested: false, error: message };
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (started) return Promise.resolve();
    started = true;
    if (enabled) {
      timer = setIntervalFn(() => {
        void runOnce();
      }, OPTIONS_AUTO_TRIGGER_INTERVAL_MS);
      timer?.unref?.();
    }
    return runOnce();
  }

  async function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    started = false;
    if (inFlight) await inFlight;
  }

  return {
    enabled,
    runOnce,
    start,
    stop
  };
}
