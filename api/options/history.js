import { select } from '../../server/db.js';
import { CONFIG } from '../../server/config.js';
import { hasEngineAccess, isEngineSessionValid, createEngineSessionCookie } from '../../server/engine-session.js';

const clean = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const objectValue = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (CONFIG.engineSecret && isEngineSessionValid(req, CONFIG.engineSecret)) {
    res.setHeader('Set-Cookie', createEngineSessionCookie(CONFIG.engineSecret));
  }
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'GET only' });
  if (!CONFIG.engineSecret || !hasEngineAccess(req, CONFIG.engineSecret)) {
    return res.status(401).json({ success: false, error: 'Unlock the private dashboard session to view Options trade history.' });
  }

  try {
    const [positions, orders] = await Promise.all([
      select('dd_option_positions', 'select=*&order=opened_at.desc&limit=2000'),
      select('dd_orders', 'strategy=in.(OPTIONS_BUY,OPTIONS_SELL)&order=created_at.desc&limit=4000')
    ]);
    if (!Array.isArray(positions) || !Array.isArray(orders)) {
      throw new Error('Options history returned an incomplete database response');
    }

    const orderGroups = new Map();
    for (const order of orders) {
      const raw = objectValue(order.raw);
      const key = clean(raw.options_execution_key);
      if (!key) continue;
      if (!orderGroups.has(key)) orderGroups.set(key, []);
      orderGroups.get(key).push(order);
    }

    const rows = positions.map(position => {
      const key = clean(position.position_key);
      const related = orderGroups.get(key) || [];
      const entryOrder = related.find(order => clean(order.role).toUpperCase() === 'ENTRY') || null;
      const exitOrders = related.filter(order => clean(order.role).toUpperCase() === 'EXIT');
      const successfulExit = exitOrders.find(order => {
        const state = clean(order.state).toLowerCase();
        return ['closed', 'filled', 'exited'].includes(state);
      }) || null;
      const entryRaw = objectValue(entryOrder?.raw);
      const exitRaw = objectValue(successfulExit?.raw);
      const raw = objectValue(position.raw);
      const realizedPnl = position.realized_pnl_verified === true
        ? numberOrNull(position.realized_pnl) : null;
      return {
        positionKey: key,
        dateTime: position.opened_at || entryOrder?.created_at || null,
        symbol: position.symbol || entryOrder?.symbol || '—',
        side: position.side || entryOrder?.side || '—',
        entryPrice: numberOrNull(position.entry_premium ?? entryRaw.average_fill_price),
        exitPrice: numberOrNull(exitRaw.average_fill_price ?? exitRaw.fill_price ?? successfulExit?.average_fill_price),
        quantity: numberOrNull(position.qty ?? entryOrder?.size),
        stopLoss: numberOrNull(raw.stop_premium ?? raw.bracket_stop_loss_price ?? entryRaw.bracket_stop_loss_price),
        takeProfit: numberOrNull(raw.take_profit_premium ?? raw.bracket_take_profit_price ?? entryRaw.bracket_take_profit_price),
        status: clean(position.status).toUpperCase(),
        realizedPnl,
        realizedPnlVerified: position.realized_pnl_verified === true && realizedPnl !== null,
        orderId: clean(entryRaw.exchange_order_id || position.entry_order_id || entryOrder?.client_order_id) || '—',
        exitOrderId: clean(exitRaw.exchange_order_id || successfulExit?.client_order_id) || null,
        exitReason: position.exit_reason || null
      };
    }).sort((a, b) => Date.parse(b.dateTime || 0) - Date.parse(a.dateTime || 0));

    return res.status(200).json({
      success: true,
      complete: positions.length < 2000 && orders.length < 4000,
      rowCount: rows.length,
      rows
    });
  } catch (error) {
    const message = String(error?.message || 'Options history unavailable').replace(/[\r\n\t]+/g, ' ').slice(0, 220);
    return res.status(503).json({ success: false, error: message });
  }
}
