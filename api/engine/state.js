import { CONFIG } from '../../server/config.js';
import { count, select } from '../../server/db.js';
import { findWorkerHeartbeatRow, normalizeWorkerExecutionMode, normalizeEmergencyStopValue, resolveWorkerGridAutoRangeStatus, protectEngineState } from '../../server/engine-state-privacy.js';
import { indiaDateKey } from '../../src/date-utils.js';
import { summarizeVerifiedDeltaClosedPnl } from '../../server/delta-closed-pnl.js';
import { createEngineSessionCookie, hasEngineAccess, isEngineSessionValid } from '../../server/engine-session.js';
import { createTtlSingleFlightCache } from '../../server/request-cache.js';

// Coalesce frequent dashboard state refreshes without sharing private account data.
const engineStateCache = createTtlSingleFlightCache({ ttlMs: 15_000 });


async function readDashboardRows(table, query) {
  try {
    const rows = await select(table, query);
    return { rows: Array.isArray(rows) ? rows : [], available: true };
  } catch (error) {
    // Non-safety dashboard datasets are independent: one timed-out history or
    // telemetry query must not turn every otherwise-readable panel into HTTP 500.
    // Heartbeat failure still resolves to an empty set, so execution mode remains UNKNOWN.
    console.error('[engine/state] Dashboard dataset unavailable: ' + table + ': ' + error.message);
    return { rows: [], available: false };
  }
}

function normalizedScoreFromSignalRow(row) {
  let details = row?.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  const value = row?.normalizedScore ?? details?.normalizedScore;
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}


export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (CONFIG.engineSecret && isEngineSessionValid(req, CONFIG.engineSecret)) {
    res.setHeader('Set-Cookie', createEngineSessionCookie(CONFIG.engineSecret));
  }

  try {
    const privateDataAuthorized = Boolean(CONFIG.engineSecret) && hasEngineAccess(req, CONFIG.engineSecret);
    const cacheKey = privateDataAuthorized ? 'private' : 'public';
    const payload = await engineStateCache.get(cacheKey, async () => {
    const todayStart = indiaDateKey(new Date()) + 'T00:00:00+05:30';
    const todayStartQuery = encodeURIComponent(todayStart);
    const last24HoursQuery = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const [
      signalsResult,
      signalCacheResult,
      marketCacheResult,
      optionCacheResult,
      rawLogsResult,
      heartbeatResult,
      ledgerResult,
      ledgerRowCount
    ] = await Promise.all([
      readDashboardRows('dd_signals', 'order=captured_at.desc&limit=200'),
      readDashboardRows('dd_signal_cache', 'order=score.desc'),
      readDashboardRows('dd_market_cache', 'active=eq.true&order=market_rank.asc'),
      readDashboardRows('dd_option_cache', 'order=score.desc'),
      // General activity logs are best-effort and never determine worker mode.
      readDashboardRows('dd_engine_logs', 'order=created_at.desc&limit=200'),
      // Keep the worker-mode safety check independent from the general log list.
      // A large/failed history read must not hide a fresh heartbeat; this one-row
      // query still fails closed when the heartbeat itself cannot be verified.
      readDashboardRows('dd_engine_logs', 'message=like.Worker%20heartbeat%20scan*&select=id,level,message,created_at,data&order=created_at.desc&limit=1'),
      readDashboardRows('dd_rotation_ledger', 'order=created_at.desc&limit=200'),
      count('dd_rotation_ledger', 'select=execution_id').catch(() => null)
    ]);
    const signals = signalsResult.rows;
    const signalCache = signalCacheResult.rows;
    const marketCache = marketCacheResult.rows;
    const optionCache = optionCacheResult.rows;
    const rawLogs = rawLogsResult.rows;
    const ledger = ledgerResult.rows;
    const dataAvailability = {
      signals: signalsResult.available,
      signalCache: signalCacheResult.available,
      marketCache: marketCacheResult.available,
      optionCache: optionCacheResult.available,
      workerHeartbeat: heartbeatResult.available && heartbeatResult.rows.some(row =>
        String(row?.message || '').startsWith('Worker heartbeat scan')
      ),
      logs: rawLogsResult.available,
      rotationLedger: ledgerResult.available,
      rotationLedgerCount: ledgerRowCount !== null
    };

    // The heartbeat's environment mode is shared with the dashboard through
    // Supabase. It no longer depends on any legacy bridge or mirror metadata.
    const heartbeatLog = findWorkerHeartbeatRow(heartbeatResult.rows);
    // Retain the independently verified heartbeat in the payload even when the
    // best-effort 200-row activity log query fails or returns a truncated window.
    const rawLogsWithHeartbeat = heartbeatLog
      ? [heartbeatLog, ...(rawLogs || []).filter(row => String(row?.id ?? '') !== String(heartbeatLog.id ?? ''))]
      : rawLogs;
    const workerGridAutoRangeStatus = resolveWorkerGridAutoRangeStatus(heartbeatLog);
    const deltaExecutionMode = normalizeWorkerExecutionMode(heartbeatLog);
    const deltaExecutionModeSource = deltaExecutionMode === 'unknown' ? 'unavailable' : 'supabase-worker-heartbeat';
    // Hide legacy bridge records from dashboard logs even if they remain in the
    // historical database. Current Delta Testnet telemetry and errors remain visible.
    const legacyBridgeMarker = ['trade', 'tron'].join('');
    const containsLegacyBridgeMarker = value =>
      new RegExp(legacyBridgeMarker, 'i').test(String(value || ''));
    const logs = (rawLogsWithHeartbeat || []).filter(row =>
      !containsLegacyBridgeMarker(row?.message) &&
      !containsLegacyBridgeMarker(JSON.stringify(row?.data || {}))
    );

    const [
      deltaTestnetPositionRows,
      optionsPositionResult,
      optionsOrderResult,
      deltaTestnetOpenPositionCount,
      deltaTestnetOrderRows,
      deltaTestnetOrderCount,
      deltaTestnetTradeRows,
      deltaTestnetTradeRowCount,
      deltaTestnetClosedTodayRows,
      deltaTestnetClosedTodayCount,
      deltaTestnetFillSyncStateRows,
      deltaTestnetFillCount,
      deltaTestnetWalletSyncStateRows,
      deltaTestnetWalletTransactionCount
    ] = privateDataAuthorized
      ? await Promise.all([
          select('dd_delta_positions', 'order=opened_at.desc&limit=500').catch(() => []),
          readDashboardRows('dd_option_positions', 'order=opened_at.desc&limit=1000'),
          readDashboardRows('dd_orders', 'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&order=created_at.desc&limit=2000'),
          count('dd_delta_positions', 'status=eq.OPEN&select=id').catch(() => null),
          select('dd_orders', 'order_type=eq.delta_testnet_order&order=created_at.desc&limit=1000').catch(() => []),
          count('dd_orders', 'order_type=eq.delta_testnet_order&select=id').catch(() => null),
          select('dd_trades', 'or=(result.is.null,result.neq.SUPERSEDED)&order=closed_at.desc&limit=500').catch(() => []),
          count('dd_trades', 'or=(result.is.null,result.neq.SUPERSEDED)&select=id').catch(() => null),
          select('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&closed_at=gte.' + todayStartQuery + '&select=status,realized_pnl,realized_pnl_verified&order=closed_at.desc&limit=1000').catch(() => []),
          count('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&closed_at=gte.' + todayStartQuery + '&select=id').catch(() => null),
          select('dd_delta_fill_sync_state', 'id=eq.1&limit=1').catch(() => []),
          count('dd_fills', 'select=id').catch(() => null),
          select('dd_wallet_transaction_sync_state', 'id=eq.1&limit=1').catch(() => []),
          count('dd_wallet_transactions', 'select=id').catch(() => null)
        ])
      : [[], { rows: [], available: false }, { rows: [], available: false }, null, [], null, [], null, [], null, [], null, [], null];

    const [lastConfirmedSignalResult, signalsTodayCount] = await Promise.all([
      select(
        'dd_signals',
        'stage=eq.CONFIRMED&ready=eq.true&captured_at=gte.' + last24HoursQuery +
          '&select=captured_at,details&order=captured_at.desc&limit=1000'
      ).then(rows => ({ ok: true, rows: Array.isArray(rows) ? rows : [] }))
        .catch(() => ({ ok: false, rows: [] })),
      count('dd_signals', 'captured_at=gte.' + todayStartQuery + '&select=id').catch(() => null)
    ]);
    const lastConfirmedSignal = lastConfirmedSignalResult.ok
      ? lastConfirmedSignalResult.rows.find(row => {
          const score = normalizedScoreFromSignalRow(row);
          return score !== null && score >= 80;
        }) || null
      : null;

    const [lastExecutedTradeResult, executedTradesTodayCount] = privateDataAuthorized
      ? await Promise.all([
          select(
            'dd_delta_positions',
            'status=in.(OPEN,CLOSED,CLOSED_EXTERNALLY)&select=opened_at&order=opened_at.desc&limit=1'
          ).then(rows => ({ ok: true, row: Array.isArray(rows) ? rows[0] || null : null }))
            .catch(() => ({ ok: false, row: null })),
          count(
            'dd_delta_positions',
            'status=in.(OPEN,CLOSED,CLOSED_EXTERNALLY)&opened_at=gte.' + todayStartQuery + '&select=id'
          ).catch(() => null)
        ])
      : [{ ok: false, row: null }, null];

    const deltaTestnetPositions = deltaTestnetPositionRows || [];
    const deltaTestnetOrders = deltaTestnetOrderRows || [];
    const deltaTestnetTrades = deltaTestnetTradeRows || [];
    const closedTodayCount = deltaTestnetClosedTodayCount == null ? null : Number(deltaTestnetClosedTodayCount);
    const closedTodayPnl = summarizeVerifiedDeltaClosedPnl(
      deltaTestnetClosedTodayRows,
      closedTodayCount
    );
    const deltaTestnetClosedTodayPnlComplete = closedTodayPnl.complete;
    const deltaTestnetClosedTodayPnl = closedTodayPnl.pnl;
    const activity = {
      lastConfirmedSignalAt: lastConfirmedSignal?.captured_at || null,
      lastConfirmedSignalAvailable: lastConfirmedSignalResult.ok,
      signalsTodayCount: signalsTodayCount == null ? null : Number(signalsTodayCount),
      lastExecutedTradeAt: lastExecutedTradeResult.ok ? lastExecutedTradeResult.row?.opened_at || null : null,
      lastExecutedTradeAvailable: privateDataAuthorized && lastExecutedTradeResult.ok === true,
      executedTradesTodayCount: privateDataAuthorized && executedTradesTodayCount != null
        ? Number(executedTradesTodayCount) : null
    };

    return {
      success: true,
      environment: CONFIG.environment,
      executionCoverage: {
        directDeltaExecutionEnabled: false,
        // Expose only the API service's explicit Delta Testnet route profile; this is status, not an execution override.
        optionsRouteConfigured: CONFIG.environment === 'TESTNET' &&
          CONFIG.deltaExecutionMode === 'testnet' && CONFIG.directDeltaExecutionEnabled === true,
        deltaExecutionMode,
        gridExecutionAllowed: CONFIG.gridExecutionAllowed === true,
        gridTrailingEnvironmentEnabled: CONFIG.gridTrailingEnabled === true,
        // Use the Worker heartbeat as the source of truth, not the API service env.
        gridAutoRangeEnvironmentEnabled: workerGridAutoRangeStatus.enabled,
        workerGridAutoRangeEnvironmentEnabled: workerGridAutoRangeStatus.enabled,
        workerGridAutoRangeHeartbeatFresh: workerGridAutoRangeStatus.heartbeatFresh,
        workerGridAutoRangeHeartbeatAt: workerGridAutoRangeStatus.heartbeatAt,
        gridSymbols: CONFIG.gridSymbols || [],
        gridRequestedSymbolPool: CONFIG.gridRequestedSymbolPool || CONFIG.gridSymbols || [],
        gridRejectedPoolSymbols: CONFIG.gridRejectedPoolSymbols || [],
        gridMaxConcurrentSymbols: CONFIG.gridMaxConcurrentSymbols || 2,
        deltaExecutionModeSource,
        gridEntrySafety: privateDataAuthorized ? heartbeatLog?.data?.gridEntrySafety || null : null,
        gridTestnetDiagnostics: heartbeatLog?.data?.gridTestnetDiagnostics || null,
        optionsTestnetDiagnostics: heartbeatLog?.data?.optionsTestnetDiagnostics || null
      },
      settings: null,
      dataAvailability,
      activity,
      signals: signals || [],
      signalCache: signalCache || [],
      marketCache: marketCache || [],
      optionCache: optionCache || [],
      logs,
      ledger: ledger || [],
      ledgerRowCount: ledgerRowCount == null ? null : Number(ledgerRowCount),
      deltaTestnetPositions,
      optionsTradePositions: optionsPositionResult?.rows || [],
      optionsTradeOrders: optionsOrderResult?.rows || [],
      optionsTradeHistoryComplete: privateDataAuthorized === true && optionsPositionResult?.available === true && optionsOrderResult?.available === true,
      deltaTestnetOpenPositionCount: deltaTestnetOpenPositionCount == null ? null : Number(deltaTestnetOpenPositionCount),
      deltaTestnetOrders,
      deltaTestnetOrderCount: deltaTestnetOrderCount == null ? null : Number(deltaTestnetOrderCount),
      deltaTestnetTrades,
      deltaTestnetTradeRowCount: deltaTestnetTradeRowCount == null ? null : Number(deltaTestnetTradeRowCount),
      deltaTestnetFillSyncState: Array.isArray(deltaTestnetFillSyncStateRows) ? deltaTestnetFillSyncStateRows[0] || null : null,
      deltaTestnetFillCount: deltaTestnetFillCount == null ? null : Number(deltaTestnetFillCount),
      deltaTestnetWalletTransactionSyncState: Array.isArray(deltaTestnetWalletSyncStateRows)
        ? deltaTestnetWalletSyncStateRows[0] || null : null,
      deltaTestnetWalletTransactionCount: deltaTestnetWalletTransactionCount == null
        ? null : Number(deltaTestnetWalletTransactionCount),
      deltaTestnetClosedTodayCount: closedTodayCount,
      deltaTestnetClosedTodayPnl,
      deltaTestnetClosedTodayPnlComplete
    };
    }, { staleIfErrorMs: 120_000 });

    // Settings contain emergency-stop and automatic-entry interlocks. Read
    // this single small row fresh on every request; the large dashboard
    // snapshots remain cached and auth-separated for 15 seconds.
    let rawSettings = null;
    let settingsAvailable = false;
    try {
      const settingsRows = await select('dd_settings', 'id=eq.1&select=*');
      rawSettings = Array.isArray(settingsRows) ? settingsRows[0] || null : null;
      settingsAvailable = Boolean(rawSettings);
    } catch (error) {
      // Do not reuse cached auto-trade or E-STOP flags. Public market/signal data
      // may be served from the short stale cache, while settings remain UNKNOWN.
      console.error('[engine/state] Fresh safety-settings read unavailable:', error.message);
    }
    const settings = rawSettings ? {
      ...rawSettings,
      emergency_stop: normalizeEmergencyStopValue(rawSettings.emergency_stop)
    } : null;

    return res.status(200).json(protectEngineState({
      ...payload,
      settings,
      settingsAvailable
    }, privateDataAuthorized));
  } catch (error) {
    return res.status(503).json({
      success: false,
      environment: CONFIG.environment,
      error: error.message
    });
  }
}
