const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const ALERT_MESSAGE = 'Telegram confirmed signal alert sent';

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPrice(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 12, useGrouping: false }).format(parsed)
    : '—';
}

function formatNotional(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0
    ? parsed.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function alertCandidate(row) {
  const details = parseObject(row?.details);
  const strategy = String(row?.strategy || '').trim().toUpperCase();
  const side = String(row?.side || '').trim().toUpperCase();
  const normalizedScore = finiteNumber(row?.normalizedScore ?? details.normalizedScore);
  const symbol = String(row?.symbol || '').trim().toUpperCase();

  if (!symbol || !['MOMENTUM', 'SCALPING'].includes(strategy) ||
      !['BUY', 'SELL'].includes(side) ||
      String(row?.stage || '').trim().toUpperCase() !== 'CONFIRMED' ||
      row?.ready !== true || normalizedScore === null || normalizedScore < 80) {
    return null;
  }

  return {
    key: [symbol, strategy, side].join(':'),
    symbol,
    strategy,
    side,
    normalizedScore,
    entryPrice: row?.price,
    stopLoss: row?.stop_price,
    takeProfit: row?.tp_price,
    notional: row?.notional
  };
}

export function formatConfirmedSignalTelegramMessage(signal) {
  return [
    '✅ DELTA CONFIRMED SIGNAL',
    'Symbol: ' + signal.symbol,
    'Side: ' + signal.side,
    'Normalized Score: ' + signal.normalizedScore.toFixed(2) + '/100',
    'Entry: ' + formatPrice(signal.entryPrice),
    'SL: ' + formatPrice(signal.stopLoss),
    'TP: ' + formatPrice(signal.takeProfit),
    'Notional: ' + formatNotional(signal.notional),
    'Strategy: ' + signal.strategy
  ].join('\n');
}

export function createConfirmedSignalTelegramNotifier({
  env = process.env,
  database = null,
  log = async () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const token = String(env?.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env?.TELEGRAM_CHAT_ID || '').trim();
  const enabled = Boolean(token && chatId);
  const activeKeys = new Set();
  const lastSentAt = new Map();
  const lastAttemptAt = new Map();
  let historyHydrated = false;
  let historyHydrationPromise = null;

  async function hydrateRecentAlerts() {
    if (historyHydrated) return;
    if (historyHydrationPromise) return historyHydrationPromise;
    historyHydrationPromise = (async () => {
      historyHydrated = true;
      if (!database || typeof database.select !== 'function') return;

      const since = new Date(Number(now()) - ALERT_COOLDOWN_MS).toISOString();
      const query = [
        'select=created_at,data',
        'message=eq.' + encodeURIComponent(ALERT_MESSAGE),
        'created_at=gte.' + encodeURIComponent(since),
        'order=created_at.desc',
        'limit=500'
      ].join('&');

      try {
        const rows = await database.select('dd_engine_logs', query);
        for (const row of Array.isArray(rows) ? rows : []) {
          const data = parseObject(row?.data);
          const key = String(data.alertKey || '');
          const createdAt = Date.parse(row?.created_at || '');
          if (!key || !Number.isFinite(createdAt)) continue;
          if (Number(now()) - createdAt <= ALERT_COOLDOWN_MS) {
            lastSentAt.set(key, createdAt);
          }
        }
      } catch {
        // Alert history is best-effort: notification failure must never stop scanning.
      }
    })();
    try {
      await historyHydrationPromise;
    } finally {
      historyHydrationPromise = null;
    }
  }

  async function writeLog(level, message, data) {
    try {
      await log(level, message, data);
    } catch {
      // Notification diagnostics must not interrupt the worker.
    }
  }

  async function send(signal) {
    if (typeof fetchImpl !== 'function') {
      await writeLog('WARN', 'Telegram confirmed signal alert failed', {
        symbol: signal.symbol, strategy: signal.strategy, side: signal.side,
        alertKey: signal.key, error: 'fetch unavailable'
      });
      return false;
    }

    try {
      const response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatConfirmedSignalTelegramMessage(signal),
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      let body = {};
      try { body = await response.json(); } catch {}
      if (!response.ok || body?.ok !== true) {
        await writeLog('WARN', 'Telegram confirmed signal alert failed', {
          symbol: signal.symbol, strategy: signal.strategy, side: signal.side,
          alertKey: signal.key,
          httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : null,
          telegramError: String(body?.description || 'Telegram API rejected the message').slice(0, 240)
        });
        return false;
      }
      return true;
    } catch (error) {
      const message = String(error?.message || error || 'Telegram request failed').replaceAll(token, '[redacted]');
      await writeLog('WARN', 'Telegram confirmed signal alert failed', {
        symbol: signal.symbol, strategy: signal.strategy, side: signal.side,
        alertKey: signal.key, error: message.slice(0, 240)
      });
      return false;
    }
  }

  async function observe(rows) {
    // Deliberately silent when optional Telegram credentials are absent.
    if (!enabled) return;

    await hydrateRecentAlerts();
    const candidatesByKey = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const candidate = alertCandidate(row);
      if (candidate) candidatesByKey.set(candidate.key, candidate);
    }

    const previouslyActive = new Set(activeKeys);
    activeKeys.clear();
    for (const key of candidatesByKey.keys()) activeKeys.add(key);

    const timestamp = Number(now());
    for (const signal of candidatesByKey.values()) {
      const sentAt = lastSentAt.get(signal.key);
      if (sentAt !== undefined && timestamp - sentAt < ALERT_COOLDOWN_MS) continue;
      // Keep a persistent CONFIRMED state quiet; send again only after it becomes eligible anew.
      if (sentAt !== undefined && previouslyActive.has(signal.key)) continue;

      const attemptedAt = lastAttemptAt.get(signal.key);
      if (attemptedAt !== undefined && timestamp - attemptedAt < RETRY_COOLDOWN_MS) continue;
      lastAttemptAt.set(signal.key, timestamp);

      if (await send(signal)) {
        lastSentAt.set(signal.key, Number(now()));
        await writeLog('INFO', ALERT_MESSAGE, {
          alertKey: signal.key,
          symbol: signal.symbol,
          strategy: signal.strategy,
          side: signal.side,
          normalizedScore: signal.normalizedScore
        });
      }
    }
  }

  return { isConfigured: () => enabled, observe };
}
