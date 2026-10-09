import { publicGet } from '../server/public.js';

const PAGE_SIZE = 100;
const MAX_PRODUCT_PAGES = 20;

async function allLivePerpetualProducts() {
  const all = [];
  let after = '';
  let previousAfter = '';

  for (let page = 0; page < MAX_PRODUCT_PAGES; page++) {
    const out = await publicGet('/v2/products', {
      contract_types: 'perpetual_futures',
      states: 'live',
      page_size: PAGE_SIZE,
      after
    });
    const rows = Array.isArray(out.result) ? out.result : [];
    all.push(...rows);

    const nextAfter = String(out.meta?.after || '');
    if (!nextAfter || nextAfter === previousAfter || nextAfter === after || rows.length === 0) break;
    previousAfter = after;
    after = nextAfter;
  }

  const unique = new Map();
  for (const product of all) {
    if (!product?.symbol) continue;
    if (product.contract_type !== 'perpetual_futures' ||
        product.state !== 'live' ||
        product.trading_status !== 'operational' ||
        product.only_reduce_only_orders_allowed === true) continue;
    unique.set(String(product.symbol).toUpperCase(), product);
  }
  return [...unique.values()];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    const type = String(req.query?.type || 'tickers');
    if (type === 'products') {
      const rows = await allLivePerpetualProducts();
      return res.status(200).json({
        success: true,
        environment: 'SIGNAL_ONLY',
        result: rows,
        count: rows.length,
        pagination: { pageSize: PAGE_SIZE, maxPages: MAX_PRODUCT_PAGES, completeUntilCursorExhausted: true }
      });
    }
    if (type === 'candles') {
      const out = await publicGet('/v2/history/candles', req.query || {});
      return res.status(200).json({ success: true, environment: 'SIGNAL_ONLY', result: out.result || [] });
    }
    const out = await publicGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const rows = Array.isArray(out.result) ? out.result.filter(x => x.contract_type === 'perpetual_futures') : [];
    rows.sort((a, b) => Number(b.turnover_usd || b.turnover || 0) - Number(a.turnover_usd || a.turnover || 0));
    return res.status(200).json({
      success: true,
      environment: 'SIGNAL_ONLY',
      result: rows,
      count: rows.length,
      serverDate: out.date
    });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'SIGNAL_ONLY', error: e.message });
  }
}
