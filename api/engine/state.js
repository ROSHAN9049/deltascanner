import { CONFIG } from '../../server/config.js';
import { count, select } from '../../server/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    const [settings, positions, signals, signalCache, marketCache, optionCache, trades, logs, ledger, counters, daily, signalOrders, tradetronEvents, signalOrderCount] = await Promise.all([
      select('dd_settings', 'id=eq.1&select=*'),
      CONFIG.signalOnly ? select('dd_positions', 'origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc') : select('dd_positions', 'qty=gt.0&order=updated_at.desc'),
      select('dd_signals', 'order=captured_at.desc&limit=200'),
      select('dd_signal_cache', 'order=score.desc'),
      select('dd_market_cache', 'active=eq.true&order=market_rank.asc'),
      select('dd_option_cache', 'order=score.desc'),
      select('dd_trades', 'order=closed_at.desc&limit=200'),
      select('dd_engine_logs', 'order=created_at.desc&limit=200'),
      select('dd_rotation_ledger', 'order=created_at.desc&limit=200'),
      select('dd_counters', 'id=eq.1&select=*'),
      select('dd_daily_pnl', 'order=trade_date.desc&limit=1'),
      select('dd_orders', 'order_type=eq.tradetron_signal&order=created_at.desc&limit=200'),
      select('dd_tradetron_events', 'order=created_at.desc&limit=200'),
      count('dd_orders', 'order_type=eq.tradetron_signal&select=id').catch(error => {
        console.error('[engine/state] exact Tradetron signal count unavailable:', error.message);
        return null;
      })
    ]);
    // The Vercel API and Railway worker have separate environment variables.
    // Prefer routing status reported by the live worker heartbeat; otherwise a
    // Vercel-side missing token could incorrectly show zero routes while Railway
    // is correctly configured.
    const heartbeatLog = (logs || []).find(row =>
      row?.message === 'Worker heartbeat scan' && row?.data?.tradetronRouting
    );
    const workerRouting = heartbeatLog?.data?.tradetronRouting || null;
    const routeTable = Array.isArray(CONFIG.tradetronBridgeRoutes) ? CONFIG.tradetronBridgeRoutes : [];
    const legacyFuturesConfigured = CONFIG.tradetronBridgeEnabled && !!CONFIG.tradetronAuthToken;
    const localSymbols = routeTable.length
      ? [...new Set(routeTable.filter(route => route.authToken).flatMap(route => route.symbols))]
      : (legacyFuturesConfigured ? [...new Set(CONFIG.tradetronSupportedSymbols)] : []);
    const routedFuturesSymbols = workerRouting && Array.isArray(workerRouting.supportedSymbols)
      ? [...new Set(workerRouting.supportedSymbols.map(symbol => String(symbol || '').toUpperCase()).filter(Boolean))]
      : localSymbols;
    const configuredFuturesRoutes = workerRouting
      ? Number(workerRouting.configuredRoutes) || 0
      : (routeTable.length
        ? routeTable.filter(route => route.authToken).length
        : (legacyFuturesConfigured ? 1 : 0));
    const optionsRouteConfigured = workerRouting
      ? workerRouting.optionsRouteConfigured === true
      : CONFIG.tradetronOptionsBridgeEnabled && !!CONFIG.tradetronOptionsAuthToken;

    return res.status(200).json({
      success: true, environment: CONFIG.environment,
      executionCoverage: {
        routedFuturesSymbols: routedFuturesSymbols.length,
        routedSymbols: routedFuturesSymbols,
        configuredFuturesRoutes,
        optionsUnderlyings: ['BTC', 'ETH', 'XAUT'],
        optionsRouteConfigured,
        webhookSecretConfigured: !!CONFIG.tradetronWebhookSecret,
        routingStatusSource: workerRouting ? 'worker-heartbeat' : 'vercel-config-fallback',
        routingObservedAt: heartbeatLog?.created_at || null,
        directDeltaExecutionEnabled: false
      },
      settings: settings?.[0] || null,
      positions: positions || [], signals: signals || [],
      signalCache: signalCache || [], marketCache: marketCache || [], optionCache: optionCache || [],
      trades: trades || [], logs: logs || [], ledger: ledger || [], counters: counters?.[0] || null,
      daily: daily?.[0] || null, signalOrders: signalOrders || [],
      signalOrderCount: signalOrderCount == null ? null : Number(signalOrderCount),
      tradetronEvents: tradetronEvents || []
    });
  } catch (e) {
    return res.status(503).json({ success: false, environment: CONFIG.environment, error: e.message });
  }
}
