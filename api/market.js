import { publicGet } from '../server/public.js';

export default async function handler(req, res) {
  try {
    const type = String(req.query?.type || 'tickers');
    if (type === 'products') {
      const out = await publicGet('/v2/products', { contract_types: 'perpetual_futures', states: 'live', page_size: 100 });
      const rows = Array.isArray(out.result) ? out.result.filter(p =>
        p.contract_type === 'perpetual_futures' &&
        p.state === 'live' &&
        (p.trading_status === undefined || p.trading_status === null || p.trading_status === 'operational') &&
        p.only_reduce_only_orders_allowed !== true
      ) : [];
      return res.status(200).json({ success: true, environment: 'TESTNET', result: rows });
    }
    if (type === 'candles') {
      const out = await publicGet('/v2/history/candles', req.query || {});
      return res.status(200).json({ success: true, environment: 'TESTNET', result: out.result || [] });
    }
    const out = await publicGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const rows = [];
    for (const x of Array.isArray(out.result) ? out.result : []) {
      if (x.contract_type !== 'perpetual_futures') continue;
      const symbol = String(x.symbol || '');
      const turnover = Number(x.turnover_usd || x.turnover || 0);
      const change = Number(x.ltp_change_24h || 0);
      const bid = Number(x.quotes?.best_bid || 0);
      const ask = Number(x.quotes?.best_ask || 0);
      const spread = bid > 0 && ask > 0 ? (ask - bid) / ((ask + bid) / 2) * 100 : 99;
      if (symbol !== 'BTCUSD' && (turnover < CONFIG.minTurnoverUsd || Math.abs(change) > CONFIG.maxAbsChange24h || spread > CONFIG.maxSpreadPct)) continue;
      rows.push({ ...x, spread_pct: spread });
    }
    rows.sort((a, b) => Number(b.turnover_usd || b.turnover || 0) - Number(a.turnover_usd || a.turnover || 0));
    return res.status(200).json({ success: true, environment: 'TESTNET', result: rows.slice(0, 50), serverDate: out.date });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'TESTNET', error: e.message });
  }
}