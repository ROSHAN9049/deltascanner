import { publicGet } from '../server/public.js';

export default async function handler(req, res) {
  try {
    const type = String(req.query?.type || 'tickers');
    if (type === 'products') {
      const out = await publicGet('/v2/products', { contract_types: 'perpetual_futures', states: 'live', page_size: 100 });
      const rows = Array.isArray(out.result) ? out.result.filter(p => p.contract_type === 'perpetual_futures' && p.state === 'live' && p.trading_status === 'operational') : [];
      return res.status(200).json({ success: true, environment: 'TESTNET', result: rows });
    }
    if (type === 'candles') {
      const out = await publicGet('/v2/history/candles', req.query || {});
      return res.status(200).json({ success: true, environment: 'TESTNET', result: out.result || [] });
    }
    const out = await publicGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const rows = Array.isArray(out.result) ? out.result.filter(x => x.contract_type === 'perpetual_futures') : [];
    rows.sort((a, b) => Number(b.turnover_usd || 0) - Number(a.turnover_usd || 0));
    return res.status(200).json({ success: true, environment: 'TESTNET', result: rows.slice(0, 50), serverDate: out.date });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'TESTNET', error: e.message });
  }
}