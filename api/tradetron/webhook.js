import crypto from 'node:crypto';
import { CONFIG } from '../../server/config.js';
import * as db from '../../server/db.js';

const clean = v => String(v ?? '').trim();

function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch {}
  }
  return {};
}

function nested(payload) {
  const root = asObject(payload);
  const candidates = [root, asObject(root.data), asObject(root.payload), asObject(root.event_data), asObject(root.trade), asObject(root.position)];
  return candidates.filter(Boolean);
}

function pick(candidates, keys, fallback = null) {
  for (const obj of candidates) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return obj[key];
    }
  }
  return fallback;
}

function numberValue(candidates, keys) {
  const value = pick(candidates, keys, null);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildEventId(payload, rawBody) {
  const candidates = nested(payload);
  const provided = clean(pick(candidates, ['event_id','eventId','id','uuid','notification_id','notificationId'], ''));
  if (provided) return provided.slice(0, 180);
  return 'ttweb-' + crypto.createHash('sha256').update(rawBody || JSON.stringify(payload)).digest('hex').slice(0, 48);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      endpoint: '/api/tradetron/webhook',
      mode: CONFIG.signalOnly ? 'production-market / signal-only' : CONFIG.environment,
      accepts: 'Tradetron outbound activity/fill/error webhooks'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const payload = asObject(req.body);
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(payload);
    const candidates = nested(payload);
    const eventType = clean(pick(candidates, ['event_type','eventType','type','event','action','status'], 'UNKNOWN')).toUpperCase().slice(0, 80);
    const eventId = buildEventId(payload, rawBody);
    const deploymentId = clean(pick(candidates, ['deployment_id','deploymentId','sid','strategy_id','strategyId'], '')) || null;
    const executionId = clean(pick(candidates, ['execution_id','executionId','tt_exec_id','client_order_id','clientOrderId','trade_id','tradeId'], '')) || null;
    const symbol = clean(pick(candidates, ['symbol','instrument','instrument_name','traded_instrument','contract','contract_symbol'], '')) || null;
    const side = clean(pick(candidates, ['side','direction','transaction_type','transactionType'], '')) || null;
    const qty = numberValue(candidates, ['qty','quantity','size','filled_qty','filledQty']);
    const price = numberValue(candidates, ['price','fill_price','fillPrice','entry_price','entryPrice','avg_price','avgPrice']);
    const pnl = numberValue(candidates, ['pnl','pnl_amount','net_pnl','netPnl','realized_pnl','realizedPnl']);
    const status = clean(pick(candidates, ['status','order_status','orderStatus','state'], '')) || null;
    const eventAtRaw = pick(candidates, ['event_at','eventAt','timestamp','time','created_at','createdAt'], null);
    const eventAt = eventAtRaw && !Number.isNaN(new Date(eventAtRaw).getTime()) ? new Date(eventAtRaw).toISOString() : null;

    await db.upsert('dd_tradetron_events', {
      event_id: eventId,
      event_type: eventType,
      deployment_id: deploymentId,
      execution_id: executionId,
      symbol,
      side,
      qty,
      price,
      pnl,
      status,
      event_at: eventAt,
      raw: payload
    }, 'event_id');

    await db.log('INFO', 'Tradetron outbound event received', {
      eventType, deploymentId, executionId, symbol, side, qty, price, pnl, status
    });

    return res.status(200).json({ success: true, event_id: eventId });
  } catch (e) {
    await db.log('ERROR', 'Tradetron webhook ingest failed', { error: e.message }).catch(() => {});
    return res.status(400).json({ success: false, error: e.message });
  }
}
