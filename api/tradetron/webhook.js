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
  const json = asObject(raw);
  if (Object.keys(json).length) return json;
  const contentType = clean(req.headers?.['content-type'] || req.headers?.['Content-Type']).toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return { raw_body: raw };
}

function nested(payload) {
  const out = [];
  const queue = [asObject(payload)];
  const seen = new Set();
  const childKeys = ['data','payload','event_data','eventData','trade','position','order','fill','execution','activity','result','details','notification','items','events'];
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
        if (Object.keys(parsed).length) queue.push(parsed);
      }
    }
  }
  return out;
}

function pick(candidates, keys, fallback = null) {
  for (const obj of candidates) for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return obj[key];
  }
  return fallback;
}

function numberValue(candidates, keys, fallback = null) {
  const num = Number(pick(candidates, keys, null));
  return Number.isFinite(num) ? num : fallback;
}

function boolValue(candidates, keys) {
  const value = pick(candidates, keys, null);
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  const s = clean(value).toLowerCase();
  if (['true','1','yes','y'].includes(s)) return true;
  if (['false','0','no','n'].includes(s)) return false;
  return null;
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
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildEventId(payload, rawBody) {
  const provided = clean(pick(nested(payload), [
    'event_id','eventId','notification_id','notificationId','webhook_event_id','webhookEventId','id','uuid','event_uuid','eventUuid'
  ], ''));
  if (provided) return provided.slice(0, 180);
  return 'ttweb-' + crypto.createHash('sha256').update(rawBody || JSON.stringify(payload)).digest('hex').slice(0, 48);
}

function eventText(candidates, keys) {
  return clean(pick(candidates, keys, '')).toUpperCase();
}

function classifyExit(candidates, eventType, status) {
  const text = [
    eventType, status,
    eventText(candidates, ['action','event_action','activity_type','activityType','role','order_role','position_role']),
    eventText(candidates, ['fill_type','fillType','execution_type','executionType','order_type','orderType','stop_order_type','stopOrderType'])
  ].join(' ');
  const reduceOnly = boolValue(candidates, ['reduce_only','reduceOnly','is_reduce_only','isReduceOnly','close_only','closeOnly']) === true;
  if (/(TP1|TAKE[ _-]?PROFIT)/.test(text)) return 'TP1';
  if (/(BREAKEVEN|BREAK[ _-]?EVEN)/.test(text)) return 'BREAKEVEN';
  if (/TRAIL/.test(text)) return 'TRAIL';
  if (/(STOP|SL)/.test(text)) return 'SL';
  if (reduceOnly || /(EXIT|CLOSE|CLOSED|SQUARE[ _-]?OFF)/.test(text)) return 'MANUAL';
  return null;
}

function isFillEvent(eventType, status, candidates) {
  const text = [
    eventType, status,
    eventText(candidates, ['event','event_type','eventType','action','activity_type','activityType','type']),
    eventText(candidates, ['fill_type','fillType','execution_type','executionType','order_status','orderStatus'])
  ].join(' ');
  return /(FILL|FILLED|EXECUT|EXECUTION|TRADE|DEAL)/.test(text);
}

function snapshotSize(candidates, side) {
  const signed = numberValue(candidates, [
    'net_position_size','netPositionSize','signed_position_size','signedPositionSize','net_size','netSize'
  ]);
  if (signed !== null) return signed;
  const absolute = numberValue(candidates, [
    'position_size','positionSize','open_position_size','openPositionSize','open_qty','openQty','open_quantity','openQuantity'
  ]);
  if (absolute === null) return null;
  const positionSide = normalizeSide(pick(candidates, [
    'position_side','positionSide','net_side','netSide','position_direction','positionDirection'
  ], side));
  return positionSide === 'SELL' ? -Math.abs(absolute) : Math.abs(absolute);
}

function hasSnapshot(candidates, eventType) {
  const signed = numberValue(candidates, ['net_position_size','netPositionSize','signed_position_size','signedPositionSize','net_size','netSize']);
  if (signed !== null) return true;
  const absolute = numberValue(candidates, ['position_size','positionSize','open_position_size','openPositionSize','open_qty','openQty','open_quantity','openQuantity']);
  return absolute !== null && /(POSITION|PORTFOLIO)/.test(eventType);
}

async function findContext(symbol, executionId) {
  let order = null;
  let signal = null;
  let market = null;

  if (executionId) {
    const rows = await db.select('dd_orders',
      'execution_id=eq.' + encodeURIComponent(executionId) + '&order=created_at.desc&limit=1'
    ).catch(() => []);
    order = rows?.[0] || null;
  }
  if (!order && symbol) {
    const rows = await db.select('dd_orders',
      'order_type=eq.tradetron_signal&symbol=eq.' + encodeURIComponent(symbol) + '&order=created_at.desc&limit=1'
    ).catch(() => []);
    order = rows?.[0] || null;
  }
  if (symbol) {
    const signals = await db.select('dd_signals',
      'symbol=eq.' + encodeURIComponent(symbol) + '&order=captured_at.desc&limit=20'
    ).catch(() => []);
    signal = signals?.find(x => x.strategy === order?.strategy) || signals?.[0] || null;
    const markets = await db.select('dd_market_cache',
      'symbol=eq.' + encodeURIComponent(symbol) + '&limit=1'
    ).catch(() => []);
    market = markets?.[0] || null;
  }
  return { order, signal, market };
}

function rawNumber(order, keys) {
  const raw = order?.raw && typeof order.raw === 'object' ? order.raw : {};
  const value = pick([raw], keys, null);
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

async function recordClosedTrade(row, context, exitPrice, pnl, fees, reason) {
  const executionId = clean(row.execution_id);
  if (!executionId) return;
  const exists = await db.select('dd_trades',
    'execution_id=eq.' + encodeURIComponent(executionId) + '&select=execution_id&limit=1'
  ).catch(() => []);
  if (exists?.length) return;

  const qty = Math.max(1, Number(row.initial_qty || row.qty) || 1);
  const contractValue = Number(context.market?.contract_value) || 1;
  const entry = Number(row.entry_price) || 0;
  const exit = Number(exitPrice) || entry;
  const entryNotional = qty * entry * contractValue;
  const exitNotional = qty * exit * contractValue;
  const calculatedGross = row.side === 'BUY'
    ? exitNotional - entryNotional
    : entryNotional - exitNotional;
  const gross = Number.isFinite(Number(pnl)) ? Number(pnl) : calculatedGross;
  const feeValue = Math.max(0, Number(fees) || 0);
  const net = gross - feeValue;
  const riskValue = Math.abs(entry - Number(row.stop_price || 0)) * contractValue * qty;

  await db.insert('dd_trades', {
    execution_id: executionId,
    symbol: row.symbol,
    strategy: row.strategy,
    side: row.side,
    entry_price: entry,
    exit_price: exit,
    qty,
    entry_notional: entryNotional,
    exit_notional: exitNotional,
    fees: feeValue,
    gross_pnl: gross,
    net_pnl: net,
    pnl_pct: entryNotional ? net / entryNotional * 100 : 0,
    r_multiple: riskValue ? net / riskValue : 0,
    exit_reason: reason || 'MANUAL',
    result: net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT',
    opened_at: row.opened_at || null,
    closed_at: new Date().toISOString()
  }).catch(() => {});
}

async function syncPosition({ symbol, side, qty, price, pnl, fees, eventType, status, executionId, candidates, exitReason, snapshot, context, eventId }) {
  if (!symbol) return { synced: false, reason: 'symbol_missing' };

  const currentRows = await db.select('dd_positions',
    'symbol=eq.' + encodeURIComponent(symbol) + '&qty=gt.0&order=updated_at.desc&limit=1'
  ).catch(() => []);
  const current = currentRows?.[0] || null;
  const productId = Number(
    numberValue(candidates, ['product_id','productId','instrument_id','instrumentId']) ||
    context.order?.product_id || context.signal?.product_id || context.market?.product_id
  ) || 0;
  const strategy = clean(pick(candidates,
    ['strategy','strategy_name','strategyName','engine','engine_name','engineName'], ''
  )) || clean(context.order?.strategy) || clean(context.signal?.strategy) || 'TRADETRON';
  const raw = context.order?.raw && typeof context.order.raw === 'object' ? context.order.raw : {};
  const stop = Number(context.signal?.stop_price || raw.stop_price || raw.stopPrice || 0);
  const tp1 = Number(context.signal?.tp1_price || raw.tp1_price || raw.tp1 || 0);
  const tp = Number(context.signal?.tp_price || raw.tp_price || raw.tp || 0);
  const mark = Number(numberValue(candidates, ['mark_price','markPrice','ltp','last_price','lastPrice']) || price || context.market?.mark_price || context.market?.price || 0);
  const eventQty = Math.abs(Number(qty) || 0);
  const entry = Number(price || raw.entry_price || raw.entryPrice || context.signal?.price || mark || 0);

  if (snapshot) {
    const signed = Number(snapshot);
    if (!signed) {
      if (!current) return { synced: false, reason: 'flat_snapshot_no_open_row' };
      await recordClosedTrade(current, context, mark || current.current_price, pnl, fees, exitReason || 'MANUAL');
      await db.update('dd_positions',
        'execution_id=eq.' + encodeURIComponent(current.execution_id),
        { qty: 0, current_price: mark || current.current_price, requested_exit_reason: exitReason || 'MANUAL', updated_at: new Date().toISOString() }
      );
      return { synced: true, action: 'closed', executionId: current.execution_id };
    }

    const nextSide = signed > 0 ? 'BUY' : 'SELL';
    const nextQty = Math.abs(signed);
    if (current && current.side === nextSide) {
      await db.update('dd_positions',
        'execution_id=eq.' + encodeURIComponent(current.execution_id),
        { qty: nextQty, initial_qty: Math.max(Number(current.initial_qty) || 0, nextQty), current_price: mark || current.current_price, updated_at: new Date().toISOString() }
      );
      return { synced: true, action: 'updated', executionId: current.execution_id };
    }
    if (current) {
      await recordClosedTrade(current, context, mark || current.current_price, pnl, fees, exitReason || 'MANUAL');
      await db.update('dd_positions',
        'execution_id=eq.' + encodeURIComponent(current.execution_id),
        { qty: 0, current_price: mark || current.current_price, requested_exit_reason: exitReason || 'MANUAL', updated_at: new Date().toISOString() }
      );
    }
    if (!productId) return { synced: false, reason: 'product_id_missing' };
    const exec = clean(executionId) || ('TT-POS-' + symbol + '-' + Date.now().toString(36));
    await db.insert('dd_positions', {
      symbol, product_id: productId, side: nextSide, qty: nextQty,
      entry_price: entry, current_price: mark,
      stop_price: stop, tp1_price: tp1, tp_price: tp,
      initial_qty: nextQty, protection_verified: false,
      entry_order_id: context.order?.id ? String(context.order.id) : null,
      client_order_id: context.order?.client_order_id || exec,
      execution_id: exec, strategy, origin: 'TRADETRON',
      opened_at: context.order?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    return { synced: true, action: 'created', executionId: exec };
  }

  if (!isFillEvent(eventType, status, candidates) || eventQty <= 0 || !side) {
    return { synced: false, reason: 'not_fill' };
  }

  if (!current) {
    if (exitReason) return { synced: false, reason: 'exit_without_open_position' };
    if (!productId) return { synced: false, reason: 'product_id_missing' };
    const exec = clean(executionId) || ('TT-FILL-' + eventId.slice(0, 40));
    await db.insert('dd_positions', {
      symbol, product_id: productId, side, qty: eventQty,
      entry_price: entry, current_price: mark || entry,
      stop_price: stop, tp1_price: tp1, tp_price: tp,
      initial_qty: eventQty, protection_verified: false,
      entry_order_id: context.order?.id ? String(context.order.id) : null,
      client_order_id: context.order?.client_order_id || exec,
      execution_id: exec, strategy, origin: 'TRADETRON',
      opened_at: context.order?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    return { synced: true, action: 'created_from_fill', executionId: exec };
  }

  if (current.side === side) {
    const nextQty = Math.abs(Number(current.qty) || 0) + eventQty;
    await db.update('dd_positions',
      'execution_id=eq.' + encodeURIComponent(current.execution_id),
      { qty: nextQty, initial_qty: Math.max(Number(current.initial_qty) || 0, nextQty), current_price: mark || current.current_price, updated_at: new Date().toISOString() }
    );
    return { synced: true, action: 'increased', executionId: current.execution_id };
  }

  const remaining = Math.abs(Number(current.qty) || 0) - eventQty;
  if (remaining > 0) {
    await db.update('dd_positions',
      'execution_id=eq.' + encodeURIComponent(current.execution_id),
      { qty: remaining, current_price: mark || current.current_price, requested_exit_reason: exitReason || current.requested_exit_reason || null, updated_at: new Date().toISOString() }
    );
    return { synced: true, action: 'reduced', executionId: current.execution_id };
  }

  await recordClosedTrade(current, context, mark || current.current_price, pnl, fees, exitReason || 'MANUAL');
  await db.update('dd_positions',
    'execution_id=eq.' + encodeURIComponent(current.execution_id),
    { qty: 0, current_price: mark || current.current_price, requested_exit_reason: exitReason || 'MANUAL', updated_at: new Date().toISOString() }
  );
  return { synced: true, action: 'closed', executionId: current.execution_id };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      endpoint: '/api/tradetron/webhook',
      mode: CONFIG.signalOnly ? 'production-market / signal-only' : CONFIG.environment,
      accepts: 'Tradetron outbound activity/fill/error/kill-switch/position webhooks',
      storage: 'dd_tradetron_events',
      sync: 'fill/position events materialize origin=TRADETRON rows in dd_positions'
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const payload = parseRequestBody(req);
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(payload);
    const candidates = nested(payload);

    const eventType = clean(pick(candidates, [
      'event_type','eventType','type','event','action','activity_type','activityType','status'
    ], 'UNKNOWN')).toUpperCase().slice(0, 80);
    const eventId = buildEventId(payload, rawBody);
    const deploymentId = clean(pick(candidates, [
      'deployment_id','deploymentId','sid','strategy_id','strategyId'
    ], '')) || null;
    const executionId = clean(pick(candidates, [
      'execution_id','executionId','tt_exec_id','client_order_id','clientOrderId',
      'trade_id','tradeId','order_id','orderId'
    ], '')) || null;
    const symbol = clean(pick(candidates, [
      'symbol','instrument','instrument_name','instrumentName','traded_instrument',
      'tradedInstrument','contract','contract_symbol','contractSymbol','product_symbol','productSymbol'
    ], '')) || null;
    const side = normalizeSide(pick(candidates, [
      'side','direction','position_side','positionSide','order_side','orderSide',
      'transaction_type','transactionType'
    ], ''));
    const qty = numberValue(candidates, [
      'qty','quantity','size','filled_qty','filledQty','filled_size','filledSize',
      'position_size','positionSize','position_qty','positionQty'
    ]);
    const price = numberValue(candidates, [
      'price','fill_price','fillPrice','entry_price','entryPrice','avg_price','avgPrice',
      'average_price','averagePrice','fillPriceAvg','mark_price','markPrice','ltp','last_price','lastPrice'
    ]);
    const pnl = numberValue(candidates, [
      'pnl','pnl_amount','pnlAmount','net_pnl','netPnl','realized_pnl','realizedPnl',
      'realized_profit','realizedProfit'
    ]);
    const fees = numberValue(candidates, [
      'commission','fee','fees','transaction_fee','transactionFee','total_fees','totalFees'
    ], 0);
    const status = clean(pick(candidates, [
      'status','order_status','orderStatus','state','execution_status','executionStatus'
    ], '')) || null;
    const eventAt = parseEventTime(pick(candidates, [
      'event_at','eventAt','timestamp','time','created_at','createdAt','updated_at','updatedAt'
    ], null));

    await db.upsert('dd_tradetron_events', {
      event_id: eventId, event_type: eventType, deployment_id: deploymentId,
      execution_id: executionId, symbol, side, qty, price, pnl, status,
      event_at: eventAt, raw: payload
    }, 'event_id');

    let sync = { synced: false, reason: 'no_symbol' };
    if (symbol) {
      const context = await findContext(symbol, executionId);
      const snapshot = hasSnapshot(candidates, eventType) ? snapshotSize(candidates, side) : null;
      const exitReason = classifyExit(candidates, eventType, status);
      sync = await syncPosition({
        symbol, side, qty, price, pnl, fees, eventType, status, executionId, candidates,
        exitReason, snapshot, context, eventId
      });
    }

    await db.log('INFO', 'Tradetron outbound event received', {
      eventType, deploymentId, executionId, symbol, side, qty, price, pnl, status, sync
    });

    return res.status(200).json({ success: true, event_id: eventId, stored: true, position_sync: sync });
  } catch (e) {
    await db.log('ERROR', 'Tradetron webhook ingest failed', { error: e.message }).catch(() => {});
    return res.status(400).json({ success: false, error: e.message });
  }
}
