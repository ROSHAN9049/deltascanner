import crypto from 'node:crypto';
import { CONFIG } from '../../server/config.js';
import * as db from '../../server/db.js';

const clean = v => String(v ?? '').trim();

function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {}
  return {};
}

function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = String(req.body ?? '');
  if (!raw) return {};
  const parsedJson = asObject(raw);
  if (Object.keys(parsedJson).length) return parsedJson;
  const contentType = clean(req.headers?.['content-type'] || req.headers?.['Content-Type']).toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return { raw_body: raw };
}

function nested(payload) {
  const root = asObject(payload);
  const out = [];
  const queue = [root];
  const seen = new Set();
  const childKeys = [
    'data','payload','event_data','eventData','trade','position','order','fill','execution',
    'activity','result','details','notification','leg','legs','items','events'
  ];

  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    for (const key of childKeys) {
      const child = value[key];
      if (Array.isArray(child)) queue.push(...child);
      else if (child && typeof child === 'object') queue.push(child);
      else if (typeof child === 'string') {
        const parsed = asObject(child);
        if (parsed && Object.keys(parsed).length) queue.push(parsed);
      }
    }
  }
  return out;
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

function normalizeSide(value) {
  const side = clean(value).toUpperCase();
  if (['BUY','LONG','1'].includes(side)) return 'BUY';
  if (['SELL','SHORT','3'].includes(side)) return 'SELL';
  return side || null;
}

function parseEventTime(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildEventId(payload, rawBody) {
  const candidates = nested(payload);
  const provided = clean(pick(candidates, [
    'event_id','eventId','notification_id','notificationId','execution_id','executionId',
    'id','uuid','event_uuid','eventUuid'
  ], ''));
  if (provided) return provided.slice(0, 180);
  return 'ttweb-' + crypto.createHash('sha256').update(rawBody || JSON.stringify(payload)).digest('hex').slice(0, 48);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      endpoint: '/api/tradetron/webhook',
      mode: CONFIG.signalOnly ? 'production-market / signal-only' : CONFIG.environment,
      accepts: 'Tradetron outbound activity/fill/error/kill-switch webhooks',
      storage: 'dd_tradetron_events',
      note: 'Configure Tradetron outbound webhooks to POST activity to this endpoint.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const payload = parseRequestBody(req);
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(payload);
    const candidates = nested(payload);

    const eventType = clean(pick(candidates, [
      'event_type','eventType','type','event','action','activity_type','activityType','status'
    ], 'UNKNOWN')).toUpperCase().slice(0, 80);

    const eventId = buildEventId(payload, rawBody);
    const deploymentId = clean(pick(candidates, [
      'deployment_id','deploymentId','sid','strategy_id','strategyId','strategy'
    ], '')) || null;
    const executionId = clean(pick(candidates, [
      'execution_id','executionId','tt_exec_id','client_order_id','clientOrderId',
      'trade_id','tradeId','order_id','orderId'
    ], '')) || null;
    const symbol = clean(pick(candidates, [
      'symbol','instrument','instrument_name','instrumentName','traded_instrument',
      'tradedInstrument','contract','contract_symbol','contractSymbol'
    ], '')) || null;
    const side = normalizeSide(pick(candidates, [
      'side','direction','position_side','positionSide','order_side','orderSide',
      'transaction_type','transactionType'
    ], ''));
    const qty = numberValue(candidates, [
      'qty','quantity','size','filled_qty','filledQty','filled_size','filledSize',
      'position_size','positionSize'
    ]);
    const price = numberValue(candidates, [
      'price','fill_price','fillPrice','entry_price','entryPrice','avg_price','avgPrice',
      'average_price','averagePrice','fillPriceAvg'
    ]);
    const pnl = numberValue(candidates, [
      'pnl','pnl_amount','pnlAmount','net_pnl','netPnl','realized_pnl','realizedPnl',
      'realized_profit','realizedProfit'
    ]);
    const status = clean(pick(candidates, [
      'status','order_status','orderStatus','state','execution_status','executionStatus'
    ], '')) || null;
    const eventAt = parseEventTime(pick(candidates, [
      'event_at','eventAt','timestamp','time','created_at','createdAt','updated_at','updatedAt'
    ], null));

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

    return res.status(200).json({
      success: true,
      event_id: eventId,
      stored: true
    });
  } catch (e) {
    await db.log('ERROR', 'Tradetron webhook ingest failed', { error: e.message }).catch(() => {});
    return res.status(400).json({ success: false, error: e.message });
  }
}
