import { CONFIG } from '../../server/config.js';
import { select, update } from '../../server/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });
  if (!CONFIG.engineSecret || req.headers['x-engine-secret'] !== CONFIG.engineSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body);
    const current = (await select('dd_settings', 'id=eq.1&select=*'))?.[0] || {};
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.autoTrade !== undefined) patch.auto_trade = !!body.autoTrade;
    if (body.emergencyStop !== undefined) patch.emergency_stop = !!body.emergencyStop;
    if (body.continuousMode !== undefined) patch.continuous_mode = !!body.continuousMode;
    if (body.maxOpenPositions !== undefined) patch.max_open_positions = Math.max(1, Math.min(100, Math.round(Number(body.maxOpenPositions))));
    if (body.riskPct !== undefined) patch.risk_pct = Math.max(0.1, Math.min(5, Number(body.riskPct)));
    if (body.momentumRr !== undefined) patch.momentum_rr = Math.max(1, Math.min(5, Number(body.momentumRr)));
    if (body.scalpingRr !== undefined) patch.scalping_rr = Math.max(1, Math.min(5, Number(body.scalpingRr)));
    if (body.tp1Pct !== undefined) patch.tp1_pct = Math.max(1, Math.min(99, Number(body.tp1Pct)));
    if (body.maxHoldMinutes !== undefined) patch.max_hold_minutes = Math.max(1, Math.min(1440, Math.round(Number(body.maxHoldMinutes))));
    if (body.optionsEnabled !== undefined) patch.options_enabled = !!body.optionsEnabled;
    if (body.optionsBuyEnabled !== undefined) patch.options_buy_enabled = !!body.optionsBuyEnabled;
    if (body.optionsSellEnabled !== undefined) patch.options_sell_enabled = !!body.optionsSellEnabled;
    if (body.optionsBuyMinDelta !== undefined) patch.options_buy_min_delta = Math.max(0.30, Math.min(0.80, Number(body.optionsBuyMinDelta)));
    if (body.optionsBuyMaxDelta !== undefined) patch.options_buy_max_delta = Math.max(0.40, Math.min(0.90, Number(body.optionsBuyMaxDelta)));
    if (body.optionsSellMinDelta !== undefined) patch.options_sell_min_delta = Math.max(0.05, Math.min(0.50, Number(body.optionsSellMinDelta)));
    if (body.optionsSellMaxDelta !== undefined) patch.options_sell_max_delta = Math.max(0.10, Math.min(0.60, Number(body.optionsSellMaxDelta)));
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'No supported setting supplied' });
    await update('dd_settings', 'id=eq.1', { ...patch, updated_at: new Date().toISOString() });
    return res.status(200).json({ success: true, changed: patch, previous: current });
  } catch (e) {
    return res.status(503).json({ success: false, error: e.message });
  }
}