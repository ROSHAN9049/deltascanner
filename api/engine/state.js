import { CONFIG } from '../../server/config.js';
import { count, select } from '../../server/db.js';
import { findWorkerHeartbeatRow, normalizeWorkerExecutionMode, protectEngineState } from '../../server/engine-state-privacy.js';
import { indiaDateKey } from '../../src/date-utils.js';
import { createEngineSessionCookie, hasEngineAccess, isEngineSessionValid } from '../../server/engine-session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (CONFIG.engineSecret && isEngineSessionValid(req, CONFIG.engineSecret)) {
    res.setHeader('Set-Cookie', createEngineSessionCookie(CONFIG.engineSecret));
  }

  try {
    const todayStart = indiaDateKey(new Date()) + 'T00:00:00+05:30';
    const todayStartQuery = encodeURIComponent(todayStart);
    const [settingsRows, signals, signalCache, marketCache, optionCache, rawLogs, ledger, ledgerRowCount] = await Promise.all([
      select('dd_settings', 'id=eq.1&select=*'),
      select('dd_signals', 'order=captured_at.desc&limit=200'),
      select('dd_signal_cache', 'order=score.desc'),
      select('dd_market_cache', 'active=eq.true&order=market_rank.asc'),
      select('dd_option_cache', 'order=score.desc'),
      select('dd_engine_logs', 'order=created_at.desc&limit=200'),
      select('dd_rotation_ledger', 'order=created_at.desc&limit=200'),
      count('dd_rotation_ledger', 'select=execution_id').catch(() => null)
    ]);

    // The heartbeat's environment mode is shared with the dashboard through
    // Supabase. It no longer depends on any legacy bridge or mirror metadata.
    const heartbeatLog = findWorkerHeartbeatRow(rawLogs);
    const deltaExecutionMode = normalizeWorkerExecutionMode(heartbeatLog);
    const deltaExecutionModeSource = deltaExecutionMode === 'unknown' ? 'unavailable' : 'supabase-worker-heartbeat';
    const privateDataAuthorized = Boolean(CONFIG.engineSecret) && hasEngineAccess(req, CONFIG.engineSecret);

    // Hide legacy bridge records from dashboard logs even if they remain in the
    // historical database. Current Delta Testnet telemetry and errors remain visible.
    const legacyBridgeMarker = ['trade', 'tron'].join('');
    const containsLegacyBridgeMarker = value =>
      new RegExp(legacyBridgeMarker, 'i').test(String(value || ''));
    const logs = (rawLogs || []).filter(row =>
      !containsLegacyBridgeMarker(row?.message) &&
      !containsLegacyBridgeMarker(JSON.stringify(row?.data || {}))
    );

    const [
      deltaTestnetPositionRows,
      deltaTestnetOpenPositionCount,
      deltaTestnetOrderRows,
      deltaTestnetOrderCount,
      deltaTestnetTradeRows,
      deltaTestnetTradeRowCount,
      deltaTestnetClosedTodayRows,
      deltaTestnetClosedTodayCount
    ] = privateDataAuthorized
      ? await Promise.all([
          select('dd_delta_positions', 'order=opened_at.desc&limit=500').catch(() => []),
          count('dd_delta_positions', 'status=eq.OPEN&select=id').catch(() => null),
          select('dd_orders', 'order_type=eq.delta_testnet_order&order=created_at.desc&limit=1000').catch(() => []),
          count('dd_orders', 'order_type=eq.delta_testnet_order&select=id').catch(() => null),
          select('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&order=closed_at.desc&limit=200').catch(() => []),
          count('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&select=id').catch(() => null),
          select('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&closed_at=gte.' + todayStartQuery + '&order=closed_at.desc&limit=1000').catch(() => []),
          count('dd_delta_positions', 'status=in.(CLOSED,CLOSED_EXTERNALLY)&closed_at=gte.' + todayStartQuery + '&select=id').catch(() => null)
        ])
      : [[], null, [], null, [], null, [], null];

    const deltaTestnetPositions = deltaTestnetPositionRows || [];
    const deltaTestnetOrders = deltaTestnetOrderRows || [];
    const deltaTestnetTrades = deltaTestnetTradeRows || [];
    const closedTodayCount = deltaTestnetClosedTodayCount == null ? null : Number(deltaTestnetClosedTodayCount);
    const closedTodayValues = (deltaTestnetClosedTodayRows || []).map(row =>
      row?.realized_pnl === null || row?.realized_pnl === undefined || row?.realized_pnl === ''
        ? null : Number(row.realized_pnl)
    );
    const deltaTestnetClosedTodayPnlComplete = closedTodayCount !== null &&
      closedTodayCount === (deltaTestnetClosedTodayRows || []).length &&
      closedTodayValues.every(value => Number.isFinite(value));
    const deltaTestnetClosedTodayPnl = deltaTestnetClosedTodayPnlComplete
      ? closedTodayValues.reduce((sum, value) => sum + value, 0)
      : null;

    return res.status(200).json(protectEngineState({
      success: true,
      environment: CONFIG.environment,
      executionCoverage: {
        directDeltaExecutionEnabled: false,
        deltaExecutionMode,
        deltaExecutionModeSource,
        gridEntrySafety: privateDataAuthorized ? heartbeatLog?.data?.gridEntrySafety || null : null
      },
      settings: settingsRows?.[0] || null,
      signals: signals || [],
      signalCache: signalCache || [],
      marketCache: marketCache || [],
      optionCache: optionCache || [],
      logs,
      ledger: ledger || [],
      ledgerRowCount: ledgerRowCount == null ? null : Number(ledgerRowCount),
      deltaTestnetPositions,
      deltaTestnetOpenPositionCount: deltaTestnetOpenPositionCount == null ? null : Number(deltaTestnetOpenPositionCount),
      deltaTestnetOrders,
      deltaTestnetOrderCount: deltaTestnetOrderCount == null ? null : Number(deltaTestnetOrderCount),
      deltaTestnetTrades,
      deltaTestnetTradeRowCount: deltaTestnetTradeRowCount == null ? null : Number(deltaTestnetTradeRowCount),
      deltaTestnetClosedTodayCount: closedTodayCount,
      deltaTestnetClosedTodayPnl,
      deltaTestnetClosedTodayPnlComplete
    }, privateDataAuthorized));
  } catch (error) {
    return res.status(503).json({
      success: false,
      environment: CONFIG.environment,
      error: error.message
    });
  }
}
