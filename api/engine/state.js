import { CONFIG } from '../../server/config.js';
import { select } from '../../server/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    const [settings, positions, signals, signalCache, marketCache, optionCache, trades, logs, ledger, counters, daily] = await Promise.all([
      select('dd_settings', 'id=eq.1&select=*'),
      select('dd_positions', 'qty=gt.0&order=updated_at.desc'),
      select('dd_signals', 'order=captured_at.desc&limit=200'),
      select('dd_signal_cache', 'order=score.desc'),
      select('dd_market_cache', 'active=eq.true&order=market_rank.asc'),
      select('dd_option_cache', 'order=score.desc'),
      select('dd_trades', 'order=closed_at.desc&limit=200'),
      select('dd_engine_logs', 'order=created_at.desc&limit=200'),
      select('dd_rotation_ledger', 'order=created_at.desc&limit=200'),
      select('dd_counters', 'id=eq.1&select=*'),
      select('dd_daily_pnl', 'order=trade_date.desc&limit=1')
    ]);
    return res.status(200).json({
      success: true, environment: CONFIG.environment,
      settings: settings?.[0] || null,
      positions: positions || [], signals: signals || [],
      signalCache: signalCache || [], marketCache: marketCache || [], optionCache: optionCache || [],
      trades: trades || [], logs: logs || [], ledger: ledger || [], counters: counters?.[0] || null,
      daily: daily?.[0] || null
    });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'TESTNET', error: e.message });
  }
}
