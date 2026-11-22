import {
  getOptionsDatabaseExecutionGate,
  getOptionsExecutionGate,
  getOptionsExecutionMode,
  getOptionsManualTestOverrideGate,
  OPTIONS_DATABASE_EXECUTION_LOCK_REASON,
  OPTIONS_EXECUTION_LOCK_REASON
} from './options-execution-lock.mjs';
import { runOptionsDemoCredentialDiagnostic } from './options-demo-diagnostics.mjs';

const DEFAULT_API_ORIGIN = 'https://deltascanner-api-v2.hostless.app';
export const OPTIONS_AUTO_TRIGGER_INTERVAL_MS = 60_000;
const MAX_CANDIDATE_AGE_MS = 5 * 60_000;
const OPTION_STRATEGIES = new Set(['OPTIONS_BUY', 'OPTIONS_SELL']);
const ACTIVE_ORDER_STATES = 'PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED';

const clean = value => String(value ?? '').trim();
const upper = value => clean(value).toUpperCase();
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
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
  // Demo Options automation has a separate opt-in. Keep the global Futures
  // FULL_AUTO_EXECUTE telemetry truthful even when Demo Options auto execution is enabled.
  const demoExecutionConfigured = getOptionsExecutionMode(env) === 'demo';
  const fullAutoExecuteConfigured = isEnabled(env.FULL_AUTO_EXECUTE);
  const optionsDemoAutoExecuteConfigured =
    demoExecutionConfigured && isEnabled(env.OPTIONS_DEMO_AUTO_EXECUTE);
  const executionAutoExecuteConfigured = demoExecutionConfigured
    ? optionsDemoAutoExecuteConfigured
    : fullAutoExecuteConfigured;
  const oneShotSymbol = demoExecutionConfigured
    ? upper(env.OPTIONS_DEMO_ONE_SHOT_SYMBOL)
    : '';
  let timer = null;
  let started = false;
  let inFlight = null;

  async function writeHeartbeat(status, extra = {}) {
    await logger('INFO', '[AUTO-TRIGGER] Worker heartbeat', {
      enabled,
      mode: executionAutoExecuteConfigured
        ? (demoExecutionConfigured ? 'DEMO_AUTO_EXECUTE' : 'AUTO_EXECUTE')
        : 'PREVIEW_ONLY',
      fullAutoExecute: fullAutoExecuteConfigured,
      optionsDemoAutoExecuteEnabled: optionsDemoAutoExecuteConfigured,
      optionsDemoOneShotSymbol: oneShotSymbol || null,
      executionAutoEnabled: executionAutoExecuteConfigured,
      executionAutoSource: demoExecutionConfigured ? 'OPTIONS_DEMO_AUTO_EXECUTE' : 'FULL_AUTO_EXECUTE',
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
      const demoMode = getOptionsExecutionMode(env) === 'demo';
      const executionGate = getOptionsExecutionGate(env);
      const demoOverrideGate = getOptionsManualTestOverrideGate(env);
      const demoQualityOverride = demoMode && demoOverrideGate.allowed;
      if (!enabled) {
        await writeHeartbeat('DISABLED');
        return { status: 'DISABLED', previewRequested: false };
      }

      try {
        if (clean(env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet' ||
            upper(env.DELTA_ENVIRONMENT) !== 'TESTNET') {
          await writeHeartbeat('BLOCKED_NOT_TESTNET', {
            reason: 'Worker Options auto-trigger requires DELTA_EXECUTION_MODE=testnet and DELTA_ENVIRONMENT=TESTNET'
          });
          return { status: 'BLOCKED_NOT_TESTNET', previewRequested: false };
        }
        if (executionAutoExecuteConfigured) {
          if (!executionGate.allowed) {
            await writeHeartbeat('BLOCKED_OPTIONS_ENV_EXECUTION_DISABLED', {
              executionGateReason: executionGate.reason || OPTIONS_EXECUTION_LOCK_REASON,
              optionsExecutionMode: executionGate.mode,
              deltaMode: executionGate.deltaMode,
              environment: executionGate.environment,
              flagEnabled: executionGate.flagEnabled,
              credentialsConfigured: executionGate.credentialsConfigured,
              demoApiKeyConfigured: executionGate.demoApiKeyConfigured,
              demoApiSecretConfigured: executionGate.demoApiSecretConfigured,
              restBaseMatched: executionGate.restBaseMatched,
              exitMonitorEnabled: executionGate.exitMonitorEnabled,
              manualTestOverrideAllowed: demoOverrideGate.allowed,
              manualTestOverrideReason: demoOverrideGate.reason,
              optionsDemoAutoExecuteEnabled: optionsDemoAutoExecuteConfigured,
              optionsExitMonitorEnvEnabled: isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED),
              optionsRegimeStrategyEnvEnabled: isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED)
            });
            return { status: 'BLOCKED_OPTIONS_ENV_EXECUTION_DISABLED', previewRequested: false };
          }
        }
        if (!engineSecret) throw new Error('ENGINE_SECRET is unavailable');
        const previewUrl = resolvePreviewUrl(env.OPTIONS_AUTO_TRIGGER_API_URL);

        const settingsRows = await database.select(
          'dd_settings',
          'id=eq.1&select=enabled,auto_trade,emergency_stop,options_enabled,options_buy_enabled,options_sell_enabled,options_execution_enabled,max_options_positions,options_max_open_positions,options_min_oi,options_min_volume,options_max_spread_pct,options_min_days_to_expiry,options_max_days_to_expiry,options_buy_min_delta,options_buy_max_delta,options_sell_min_delta,options_sell_max_delta'
        );
        if (!Array.isArray(settingsRows) || settingsRows.length !== 1) {
          throw new Error('Options auto-trigger settings are missing or ambiguous');
        }
        const settings = settingsRows[0];
        if ((!isEnabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) && !demoMode) ||
            !isEnabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
          await writeHeartbeat('BLOCKED_REGIME_OR_EXIT_MONITOR_DISABLED', {
            reason: 'Regime strategy or explicit Demo mode, plus the 60-second Options exit monitor, is required',
            demoMode
          });
          return { status: 'BLOCKED_REGIME_OR_EXIT_MONITOR_DISABLED', previewRequested: false };
        }
        if (demoMode && !demoOverrideGate.allowed) {
          await writeHeartbeat('BLOCKED_DEMO_QUALITY_OVERRIDE_DISABLED', {
            reason: demoOverrideGate.reason,
            demoMode: true,
            manualOverrideEnabled: false
          });
          return { status: 'BLOCKED_DEMO_QUALITY_OVERRIDE_DISABLED', previewRequested: false };
        }
        if (settings.enabled !== true) {
          await writeHeartbeat('BLOCKED_ENGINE_DISABLED');
          return { status: 'BLOCKED_ENGINE_DISABLED', previewRequested: false };
        }
        if (settings.auto_trade !== true) {
          await writeHeartbeat('BLOCKED_AUTO_TRADE', { reason: 'auto_trade is not true' });
          return { status: 'BLOCKED_AUTO_TRADE', previewRequested: false };
        }
        if (settings.options_enabled !== true) {
          await writeHeartbeat('BLOCKED_OPTIONS_DISABLED', { reason: 'options_enabled is false or unknown' });
          return { status: 'BLOCKED_OPTIONS_DISABLED', previewRequested: false };
        }
        if (settings.emergency_stop !== false) {
          await writeHeartbeat('BLOCKED_ESTOP', { reason: 'emergency_stop is active or unknown' });
          return { status: 'BLOCKED_ESTOP', previewRequested: false };
        }

        const databaseExecutionGate = getOptionsDatabaseExecutionGate(settings);
        if (!databaseExecutionGate.allowed) {
          await writeHeartbeat('BLOCKED_OPTIONS_EXECUTION_DISABLED', {
            reason: OPTIONS_DATABASE_EXECUTION_LOCK_REASON
          });
          return { status: 'BLOCKED_OPTIONS_EXECUTION_DISABLED', previewRequested: false };
        }

        const globalMaxPositions = finite(settings.max_options_positions);
        const strategyMaxPositions = finite(settings.options_max_open_positions);
        if (!Number.isSafeInteger(globalMaxPositions) || globalMaxPositions < 1 ||
            !Number.isSafeInteger(strategyMaxPositions) || strategyMaxPositions < 1) {
          throw new Error('Options position caps are missing or invalid');
        }
        const maxPositions = Math.min(globalMaxPositions, strategyMaxPositions);

        const scanAt = now();
        const recentFilledAfter = encodeURIComponent(new Date(scanAt - 120_000).toISOString());
        const [cacheRows, openPositions, optionPositions, activeOrders, recentFilledOrders] = await Promise.all([
          database.select(
            'dd_option_cache',
            'select=symbol,strategy,score,stage,cached_at,details,market_regime,iv_rank,iv_percentile,oi,volume,delta,spread_pct&order=score.desc&limit=100'
          ),
          database.select(
            'dd_delta_positions',
            'strategy=in.(OPTIONS_BUY,OPTIONS_SELL,OPTIONS)&status=eq.OPEN&select=symbol&limit=500'
          ),
          database.select(
            'dd_option_positions',
            'status=in.(ENTRY_PENDING,OPEN,HEDGE_CLOSE_PENDING,RECONCILIATION_REQUIRED)&select=symbol,status&limit=500'
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
        if (!Array.isArray(cacheRows) || !Array.isArray(openPositions) || !Array.isArray(optionPositions) ||
            !Array.isArray(activeOrders) || !Array.isArray(recentFilledOrders)) {
          throw new Error('Options cache or position/reservation snapshot is incomplete');
        }

        const occupied = new Set([
          ...openPositions.map(row => upper(row?.symbol)),
          ...optionPositions.map(row => upper(row?.symbol)),
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

        const configuredSpreadLimit = finite(settings.options_max_spread_pct) ?? 1.5;
        const configuredMinOi = finite(settings.options_min_oi) ?? 50;
        const configuredMinVolume = finite(settings.options_min_volume) ?? 1;
        const configuredMinDte = finite(settings.options_min_days_to_expiry) ?? 2;
        const configuredMaxDte = finite(settings.options_max_days_to_expiry) ?? 14;
        const candidates = cacheRows.filter(row => {
          const symbol = upper(row?.symbol);
          const strategy = upper(row?.strategy);
          if (oneShotSymbol && symbol !== oneShotSymbol) return false;
          if (strategy === 'OPTIONS_BUY' && settings.options_buy_enabled !== true) return false;
          if (strategy === 'OPTIONS_SELL' && settings.options_sell_enabled !== true) return false;
          const cachedAt = Date.parse(row?.cached_at || '');
          const details = parseDetails(row?.details);
          const marketRegime = upper(row?.market_regime || details.marketRegime);
          const ivRank = finite(row?.iv_rank ?? details.ivRank);
          const ivPercentile = finite(row?.iv_percentile ?? details.ivPercentile);
          const oi = finite(row?.oi ?? details.openInterest);
          const volume = finite(row?.volume ?? details.volume);
          const spreadPct = finite(row?.spread_pct ?? details.spreadPct ?? details.spread_pct);
          const delta = finite(row?.delta ?? details.delta);
          const dte = finite(row?.dte ?? details.dte);
          const regimeRouteOk = strategy === 'OPTIONS_BUY'
            ? marketRegime === 'TRENDING'
            : marketRegime === 'SIDEWAYS';
          const ivRankOk = ivRank !== null && ivRank >= 0 && ivRank <= 100 &&
            (strategy === 'OPTIONS_BUY' ? ivRank < 40 : ivRank > 50);
          const ivPercentileOk = ivPercentile !== null && ivPercentile >= 0 && ivPercentile <= 100 &&
            (strategy === 'OPTIONS_BUY' ? ivPercentile < 20 : ivPercentile > 80);
          const exactIndiaUniverse = /^([CP])-(BTC|ETH)-/.test(symbol);
          const hedgeDelta = finite(details.hedgeDelta);
          const hardDemoChecks = exactIndiaUniverse &&
            spreadPct !== null && spreadPct >= 0 && spreadPct <= configuredSpreadLimit &&
            delta !== null && Math.abs(delta) >= 0.05 && Math.abs(delta) <= 0.95 &&
            dte !== null && dte >= configuredMinDte && dte <= configuredMaxDte &&
            (strategy !== 'OPTIONS_SELL' ||
              (Boolean(clean(details.hedgeSymbol)) && hedgeDelta !== null &&
                Math.abs(hedgeDelta) >= 0.05 && Math.abs(hedgeDelta) <= 0.15));
          const timestampOk = Number.isFinite(cachedAt) &&
            cachedAt <= scanAt + 5000 &&
            scanAt - cachedAt <= MAX_CANDIDATE_AGE_MS;
          const baseChecks = OPTION_STRATEGIES.has(strategy) &&
            finite(row?.score) !== null && finite(row?.score) >= 80 &&
            timestampOk;
          if (demoMode && demoQualityOverride) {
            if (!hardDemoChecks || !baseChecks) return false;
            const observed = [];
            const stage = upper(row?.stage);
            const ivHistoryDays = finite(details.ivHistoryDays ?? details.ivPercentileDays);
            const ivPercentileDays = finite(details.ivPercentileDays);
            if (oi === null || oi < configuredMinOi) observed.push({
              code: 'OI_BELOW_MIN_DEMO_LOG_ONLY', actual: oi, expected: '>=' + configuredMinOi
            });
            if (stage !== 'CONFIRMED') observed.push({
              code: 'STAGE_NOT_CONFIRMED_DEMO_LOG_ONLY', actual: stage || null, expected: 'CONFIRMED'
            });
            if (ivPercentile === null) observed.push({
              code: 'IV_PCTL_UNAVAILABLE_DEMO_LOG_ONLY', actual: null, expected: 'strategy-qualified IV percentile'
            });
            if (ivHistoryDays === null || ivHistoryDays < 20) observed.push({
              code: 'IV_HISTORY_SHORT_DEMO_LOG_ONLY', actual: ivHistoryDays, expected: '>=20 completed days',
              ivPercentileDays
            });
            if (marketRegime === 'UNKNOWN' || !marketRegime) observed.push({
              code: 'REGIME_UNKNOWN_DEMO_LOG_ONLY', actual: marketRegime || null, expected: strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS'
            });
            else if (!regimeRouteOk) observed.push({
              code: 'REGIME_STRATEGY_MISMATCH_DEMO_LOG_ONLY', actual: marketRegime, expected: strategy === 'OPTIONS_BUY' ? 'TRENDING' : 'SIDEWAYS'
            });
            if (details.analysisReady !== true) observed.push({
              code: 'ANALYSIS_NOT_READY_DEMO_LOG_ONLY', actual: details.analysisReady ?? false, expected: true
            });
            if (volume === null || volume < configuredMinVolume) observed.push({
              code: 'VOLUME_BELOW_MIN_DEMO_LOG_ONLY', actual: volume, expected: '>=' + configuredMinVolume
            });
            if (!ivRankOk) observed.push({
              code: 'IV_RANK_QUALITY_FILTER_DEMO_LOG_ONLY', actual: ivRank,
              expected: strategy === 'OPTIONS_BUY' ? '<40' : '>50'
            });
            if (ivPercentile !== null && !ivPercentileOk) observed.push({
              code: 'IV_PERCENTILE_STRATEGY_FILTER_DEMO_LOG_ONLY', actual: ivPercentile,
              expected: strategy === 'OPTIONS_BUY' ? '<20' : '>80'
            });
            const buyMin = finite(settings.options_buy_min_delta) ?? 0.45;
            const buyMax = finite(settings.options_buy_max_delta) ?? 0.65;
            const sellMin = finite(settings.options_sell_min_delta) ?? 0.20;
            const sellMax = finite(settings.options_sell_max_delta) ?? 0.35;
            const targetDelta = strategy === 'OPTIONS_BUY'
              ? Math.abs(delta) >= buyMin && Math.abs(delta) <= buyMax
              : Math.abs(delta) >= sellMin && Math.abs(delta) <= sellMax;
            if (!targetDelta) observed.push({
              code: 'DELTA_TARGET_BAND_DEMO_LOG_ONLY', actual: delta,
              expected: strategy === 'OPTIONS_BUY' ? buyMin + '–' + buyMax : sellMin + '–' + sellMax
            });
            if (observed.length) {
              void logger('WARN', '[AUTO-TRIGGER] Demo-only quality filters are LOG-ONLY; hard safety checks remain blocking', {
                environment: 'DELTA_DEMO',
                symbol,
                strategy,
                score: finite(row?.score),
                stage,
                oi, volume, spreadPct, delta, ivRank, ivPercentile,
                ivHistoryDays,
                ivPercentileDays,
                analysisReady: details.analysisReady === true,
                marketRegime,
                relaxedFilters: observed
              });
            }
            return true;
          }
          return baseChecks &&
            regimeRouteOk && ivRankOk && ivPercentileOk &&
            upper(row?.stage) === 'CONFIRMED' &&
            details.analysisReady === true &&
            spreadPct !== null && spreadPct <= configuredSpreadLimit;
        }).sort((a, b) => (finite(b.score) || 0) - (finite(a.score) || 0));

        const candidate = candidates.find(row => !occupied.has(upper(row.symbol)));
        if (!candidate) {
          const status = oneShotSymbol ? 'DEMO_ONE_SHOT_SYMBOL_NOT_READY' : 'READY';
          await writeHeartbeat(status, {
            candidateReady: false,
            candidateCount: candidates.length,
            duplicateCount: candidates.length,
            ...(oneShotSymbol ? { targetSymbol: oneShotSymbol, reason: 'Exact one-shot target is not present as a fresh, hard-check-passing candidate or is already occupied' } : {})
          });
          return { status, previewRequested: false, candidateCount: candidates.length };
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
            manualOverride: demoQualityOverride
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

        const fullAutoExecute = executionAutoExecuteConfigured;
        await logger(
          'INFO',
          fullAutoExecute
            ? '[AUTO-TRIGGER] Executing automatically...'
            : '[AUTO-TRIGGER] Candidate ready for execution. Token acquired. Waiting for manual execution.',
          {
            symbol: upper(candidate.symbol),
            strategy: upper(candidate.strategy),
            mode: fullAutoExecute ? 'AUTO_EXECUTE' : 'PREVIEW_ONLY',
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
        // ==========================================
// FULL AUTO EXECUTE LOGIC
// ==========================================
if (fullAutoExecute) {
  const executeUrl = previewUrl.replace('/preview', '/execute');
  await logger('INFO', '[AUTO-TRIGGER] FULL_AUTO_EXECUTE is ON. Submitting order...', { symbol: upper(candidate.symbol) });
  
  try {
    const execResponse = await fetchImpl(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-engine-secret': engineSecret
      },
      body: JSON.stringify({
        symbol: upper(candidate.symbol),
        strategy: upper(candidate.strategy),
        qty: 1,
        quoteToken: preview.quoteToken,
        manualOverride: demoQualityOverride
      })
    });
    
    const execPayload = await execResponse.json();
    if (!execResponse.ok || execPayload?.success !== true) {
      throw new Error(execPayload?.error || 'Execute API rejected the order');
    }
    
    await logger('INFO', `[AUTO-TRIGGER] ✅ ORDER EXECUTED SUCCESSFULLY: ${upper(candidate.symbol)}`, {
      environment: demoMode ? 'DELTA_DEMO' : 'TESTNET',
      symbol: upper(candidate.symbol),
      side: execPayload?.result?.side || (upper(candidate.strategy) === 'OPTIONS_BUY' ? 'BUY' : 'SELL'),
      size: execPayload?.result?.size ?? candidate.qty ?? 1,
      orderId: execPayload?.result?.order_id || execPayload?.result?.order?.id ||
        execPayload?.result?.shortOrder?.id || execPayload?.result?.hedge_order_id ||
        execPayload?.order?.id || execPayload?.orderId || 'unknown',
      fill: execPayload?.result?.fill || execPayload?.result?.shortOrder?._shortFill || null,
      entry: execPayload?.result?.entry ?? null,
      sl: execPayload?.result?.sl ?? null,
      tp: execPayload?.result?.tp ?? null,
      status: execPayload?.result?.status || execPayload?.result?.state || 'UNKNOWN'
    });
    await writeHeartbeat('ORDER_EXECUTED', { candidateReady: false, orderSubmitted: true, symbol: upper(candidate.symbol) });
    return { status: 'ORDER_EXECUTED', previewRequested: true, orderSubmitted: true, candidate: upper(candidate.symbol) };
  } catch (execError) {
    const execMsg = safeError(execError, engineSecret);
    await logger('ERROR', `[AUTO-TRIGGER] ❌ EXECUTION FAILED: ${execMsg}`, { symbol: upper(candidate.symbol) });
    await writeHeartbeat('EXECUTION_ERROR', { error: execMsg });
    return { status: 'EXECUTION_ERROR', previewRequested: true, orderSubmitted: false, error: execMsg };
  }
}
// ==========================================
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

  async function start() {
    if (started) return;
    started = true;
    if (demoExecutionConfigured) {
      try {
        await runOptionsDemoCredentialDiagnostic({ env, fetchImpl, logger, now });
      } catch (error) {
        await logger('ERROR', '[OptionsDemoDiagnostics] Startup diagnostic failed safely', {
          error: safeError(error, clean(env.DELTA_DEMO_API_SECRET))
        });
      }
    }
    if (enabled && !oneShotSymbol) {
      timer = setIntervalFn(() => {
        void runOnce();
      }, OPTIONS_AUTO_TRIGGER_INTERVAL_MS);
      timer?.unref?.();
    } else if (enabled && oneShotSymbol) {
      await logger('INFO', '[AUTO-TRIGGER] Exact Demo one-shot mode is active; no recurring execution timer will be created', {
        environment: 'DELTA_DEMO',
        symbol: oneShotSymbol,
        recurringTimerEnabled: false
      });
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
