import * as defaultDb from '../../server/db.js';
import { deltaExecutor } from './delta-executor.mjs';

export const DELTA_POSITION_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const QTY_EPSILON = 1e-8;

const stringValue = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const nowIso = now => new Date(now()).toISOString();

function normalizeExchangePosition(position) {
  const symbol = stringValue(position?.symbol || position?.product_symbol).toUpperCase();
  const signed = numberOrNull(position?.signedSize ?? position?.size);
  const qtyValue = numberOrNull(position?.qty ?? position?.quantity);
  const qty = qtyValue === null ? (signed === null ? null : Math.abs(signed)) : Math.abs(qtyValue);
  const explicitSide = stringValue(position?.side).toUpperCase();
  const side = explicitSide === 'BUY' || explicitSide === 'SELL'
    ? explicitSide
    : signed !== null && signed < 0 ? 'SELL' : signed !== null ? 'BUY' : null;

  if (!symbol || qty === null || !side) {
    throw new Error('Delta Testnet positions response contained a malformed position row; reconciliation aborted without DB changes');
  }

  return { ...position, symbol, qty, side };
}

function strategyFromPosition(position) {
  const clientOrderId = stringValue(position?.client_order_id).toUpperCase();
  if (clientOrderId.startsWith('DDG-')) return 'GRID';
  if (clientOrderId.startsWith('DDS-')) return 'SCALPING';
  return 'MOMENTUM';
}

function positionDbRow(position, timestamp) {
  const row = {
    symbol: position.symbol,
    side: position.side,
    qty: position.qty,
    status: 'OPEN',
    strategy: strategyFromPosition(position),
    opened_at: position.opened_at || timestamp,
    closed_at: null,
    updated_at: timestamp
  };
  for (const [column, value] of Object.entries({
    order_id: position.order_id,
    client_order_id: position.client_order_id,
    product_id: position.product_id,
    entry_price: position.entry_price,
    current_price: position.current_price,
    unrealized_pnl: position.unrealized_pnl,
    realized_pnl: position.realized_pnl,
    sl_price: position.sl_price,
    tp_price: position.tp_price
  })) {
    if (value !== null && value !== undefined && value !== '') {
      row[column] = column === 'order_id' || column === 'client_order_id' ? String(value) : value;
    }
  }
  return row;
}

export function createDeltaPositionReconciler({
  env = process.env,
  database = defaultDb,
  executor = deltaExecutor,
  intervalMs = DELTA_POSITION_RECONCILE_INTERVAL_MS,
  now = () => Date.now()
} = {}) {
  let timer = null;
  let inFlight = null;
  let started = false;

  function assertTestnetOnly() {
    if (stringValue(env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet') {
      throw new Error('Delta position reconciler is locked: DELTA_EXECUTION_MODE must be testnet');
    }
  }

  async function writeLog(level, message, data = {}) {
    try {
      if (typeof database.log === 'function') await database.log(level, message, data);
    } catch (error) {
      console.warn('[Reconciler] Could not persist log:', String(error?.message || error));
    }
  }

  async function updateOpenRow(id, patch) {
    const query = 'id=eq.' + encodeURIComponent(String(id)) + '&status=eq.OPEN';
    if (typeof database.updateReturning === 'function') {
      const changed = await database.updateReturning('dd_delta_positions', query, patch);
      return Array.isArray(changed) ? changed.length > 0 : Boolean(changed);
    }
    await database.update('dd_delta_positions', query, patch);
    return true;
  }

  async function insertOrUpdateHydratedPosition(position, timestamp) {
    const row = positionDbRow(position, timestamp);
    try {
      await database.insert('dd_delta_positions', row);
      return 'inserted';
    } catch (error) {
      // A private WebSocket position snapshot can race the REST reconciler.
      // Recover only if a matching OPEN row now exists; otherwise retain the error.
      const concurrent = await database.select(
        'dd_delta_positions',
        'symbol=eq.' + encodeURIComponent(position.symbol) + '&status=eq.OPEN&select=id&limit=1'
      );
      if (!Array.isArray(concurrent) || !concurrent[0]?.id) throw error;
      await updateOpenRow(concurrent[0].id, {
        qty: position.qty,
        side: position.side,
        ...(position.current_price !== null && position.current_price !== undefined
          ? { current_price: position.current_price } : {}),
        ...(position.unrealized_pnl !== null && position.unrealized_pnl !== undefined
          ? { unrealized_pnl: position.unrealized_pnl } : {}),
        updated_at: timestamp
      });
      return 'updated';
    }
  }

  async function reconcile() {
    assertTestnetOnly();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      // The exchange snapshot must succeed and be structurally valid before any
      // local row is changed. This prevents an API outage from closing every DB row.
      const exchangeRows = await executor.getOpenPositions();
      if (!Array.isArray(exchangeRows)) {
        throw new Error('Delta Testnet positions snapshot was not an array; DB state left unchanged');
      }
      const exchangePositions = exchangeRows.map(normalizeExchangePosition).filter(position => position.qty > 0);
      const exchangeBySymbol = new Map(exchangePositions.map(position => [position.symbol, position]));

      const openRows = await database.select(
        'dd_delta_positions',
        'status=eq.OPEN&select=id,symbol,qty,side,realized_pnl&limit=1000'
      );
      if (!Array.isArray(openRows)) {
        throw new Error('Could not read dd_delta_positions OPEN rows; DB state left unchanged');
      }

      const timestamp = nowIso(now);
      const dbOpenSymbols = new Set(openRows.map(row => stringValue(row?.symbol).toUpperCase()).filter(Boolean));
      let zombiePositions = 0;
      let markedClosedExternally = 0;
      let quantityMismatches = 0;
      let hydratedPositions = 0;

      for (const row of openRows) {
        const symbol = stringValue(row?.symbol).toUpperCase();
        if (!symbol || row?.id === undefined || row?.id === null) {
          throw new Error('An OPEN dd_delta_positions row is missing its symbol or id; reconciliation aborted safely');
        }
        const exchangePosition = exchangeBySymbol.get(symbol);
        if (!exchangePosition) {
          zombiePositions += 1;
          const changed = await updateOpenRow(row.id, {
            status: 'CLOSED_EXTERNALLY',
            closed_at: timestamp,
            updated_at: timestamp,
            unrealized_pnl: 0
          });
          if (changed) markedClosedExternally += 1;
          await writeLog('WARN', '[Reconciler] Local OPEN position missing from Delta Testnet; marked CLOSED_EXTERNALLY', {
            id: row.id,
            symbol,
            dbQty: numberOrNull(row.qty),
            closedAt: timestamp,
            realizedPnlPreserved: row.realized_pnl ?? null
          });
          continue;
        }

        const dbQty = numberOrNull(row.qty);
        const dbSide = stringValue(row.side).toUpperCase();
        const qtyMismatch = dbQty === null ||
          Math.abs(Math.abs(dbQty) - exchangePosition.qty) > Math.max(QTY_EPSILON, exchangePosition.qty * QTY_EPSILON);
        const sideMismatch = dbSide !== exchangePosition.side;
        if (qtyMismatch || sideMismatch) {
          quantityMismatches += 1;
          console.warn('[Reconciler] Position quantity/side mismatch; syncing local DB to Delta Testnet', JSON.stringify({
            id: row.id, symbol, dbQty, exchangeQty: exchangePosition.qty,
            dbSide: dbSide || null, exchangeSide: exchangePosition.side
          }));
          await writeLog('WARN', '[Reconciler] Delta Testnet position quantity/side mismatch; local DB updated', {
            id: row.id, symbol, dbQty, exchangeQty: exchangePosition.qty,
            dbSide: dbSide || null, exchangeSide: exchangePosition.side
          });
          await updateOpenRow(row.id, {
            qty: exchangePosition.qty,
            side: exchangePosition.side,
            ...(exchangePosition.current_price !== null && exchangePosition.current_price !== undefined
              ? { current_price: exchangePosition.current_price } : {}),
            ...(exchangePosition.unrealized_pnl !== null && exchangePosition.unrealized_pnl !== undefined
              ? { unrealized_pnl: exchangePosition.unrealized_pnl } : {}),
            updated_at: timestamp
          });
        }
      }

      // Hydrate an exchange-open position if the DB has no OPEN row for it.
      // This restores the dashboard's persisted position view after process restarts.
      for (const position of exchangePositions) {
        if (dbOpenSymbols.has(position.symbol)) continue;
        await insertOrUpdateHydratedPosition(position, timestamp);
        hydratedPositions += 1;
        await writeLog('INFO', '[Reconciler] Hydrated missing local OPEN position from Delta Testnet', {
          symbol: position.symbol, qty: position.qty, side: position.side
        });
      }

      const summary = {
        zombiePositions,
        markedClosedExternally,
        quantityMismatches,
        hydratedPositions,
        exchangeOpenPositions: exchangePositions.length,
        databaseOpenPositions: openRows.length,
        reconciledAt: timestamp
      };
      const message = '[Reconciler] Found ' + zombiePositions +
        ' zombie positions. Marked ' + markedClosedExternally + ' as CLOSED_EXTERNALLY.';
      console.log(message, JSON.stringify({
        quantityMismatches,
        hydratedPositions,
        exchangeOpenPositions: exchangePositions.length,
        databaseOpenPositions: openRows.length
      }));
      await writeLog('INFO', message, summary);
      return summary;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  async function start() {
    assertTestnetOnly();
    if (started) return;
    started = true;
    console.log('[Reconciler] Starting delta position reconciliation...');
    try {
      await reconcile();
    } catch (error) {
      const message = String(error?.message || error);
      console.warn('[Reconciler] Startup reconciliation failed safely; will retry on schedule:', message);
      await writeLog('ERROR', '[Reconciler] Startup reconciliation failed safely; will retry on schedule', {
        error: message.slice(0, 300)
      });
    }
    if (!started) return;
    timer = setInterval(() => {
      void reconcile().catch(async error => {
        const message = String(error?.message || error);
        console.warn('[Reconciler] Scheduled reconciliation failed safely:', message);
        await writeLog('ERROR', '[Reconciler] Scheduled reconciliation failed safely', {
          error: message.slice(0, 300)
        });
      });
    }, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (inFlight) await inFlight.catch(() => {});
  }

  return Object.freeze({ start, stop, reconcile });
}
