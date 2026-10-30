import * as defaultDatabase from '../../server/db.js';

const INTENTS = new Set(['ENTRY', 'EXIT', 'UNWIND']);
const ROLES = new Set(['LONG_PREMIUM', 'PROTECTIVE_WING', 'SHORT_OPTION']);
const SIDES = new Set(['BUY', 'SELL']);
const finite = value => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const textValue = value => String(value ?? '').trim();
const upper = value => textValue(value).toUpperCase();
const isoNow = now => new Date(now()).toISOString();

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return parsed;
}

function normalizedState(state) {
  const value = textValue(state).toLowerCase();
  if (value === 'open') return 'OPEN';
  if (value === 'pending') return 'SUBMITTED';
  if (value === 'closed') return 'SUBMITTED'; // Fills, not the order response, confirm quantity and VWAP.
  if (value === 'cancelled' || value === 'canceled') return 'CANCELLED';
  if (value === 'rejected') return 'REJECTED';
  return 'UNKNOWN';
}

function exactAttempt(row, expected) {
  return String(row?.group_id) === String(expected.group_id) &&
    String(row?.leg_id) === String(expected.leg_id) &&
    upper(row?.leg_role) === expected.leg_role &&
    upper(row?.intent) === expected.intent &&
    Number(row?.attempt_no) === expected.attempt_no &&
    Number(row?.product_id) === expected.product_id &&
    upper(row?.symbol) === expected.symbol &&
    upper(row?.side) === expected.side &&
    Number(row?.requested_qty) === expected.requested_qty &&
    Number(row?.limit_price) === expected.limit_price &&
    Boolean(row?.reduce_only) === expected.reduce_only &&
    String(row?.client_order_id) === expected.client_order_id;
}

function normalizeFill(fill) {
  const product = fill?.product && typeof fill.product === 'object' ? fill.product : {};
  return {
    id: textValue(fill?.id),
    orderId: textValue(fill?.order_id ?? fill?.orderId),
    productId: finite(fill?.product_id ?? fill?.productId ?? product?.id),
    symbol: upper(fill?.product_symbol ?? fill?.symbol ?? product?.symbol),
    side: upper(fill?.side),
    size: finite(fill?.size),
    price: finite(fill?.price),
    commission: finite(fill?.commission),
    commissionCurrency: upper(
      fill?.settling_asset_symbol ?? fill?.commission_currency ??
      fill?.settling_asset?.symbol
    )
  };
}

export function createDeltaOptionsOrderLedger({
  database = defaultDatabase,
  now = () => Date.now(),
  maxFillPages = 20
} = {}) {
  async function getAttempt(clientOrderId) {
    const id = textValue(clientOrderId);
    if (!id || id.length > 32) throw new Error('Options client order ID is invalid');
    if (typeof database?.select !== 'function') throw new Error('Options order ledger reader is unavailable');
    const rows = await database.select(
      'dd_options_execution_orders',
      'client_order_id=eq.' + encodeURIComponent(id) + '&select=*&limit=2'
    );
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error('Options order-attempt lookup returned an invalid snapshot');
    }
    return rows[0] || null;
  }

  async function persistAttempt(input = {}) {
    const expected = {
      group_id: textValue(input.groupId),
      leg_id: requirePositiveInteger(input.legId, 'Options leg ID'),
      leg_role: upper(input.legRole),
      intent: upper(input.intent),
      attempt_no: requirePositiveInteger(input.attemptNo, 'Options attempt number'),
      product_id: requirePositiveInteger(input.productId, 'Options product ID'),
      symbol: upper(input.symbol),
      side: upper(input.side),
      requested_qty: requirePositiveInteger(input.requestedQty, 'Options requested quantity'),
      limit_price: finite(input.limitPrice),
      reduce_only: input.reduceOnly === true,
      client_order_id: textValue(input.clientOrderId)
    };
    if (!expected.group_id || expected.group_id.length > 80) throw new Error('Options group ID is invalid');
    if (!ROLES.has(expected.leg_role)) throw new Error('Options leg role is invalid');
    if (!INTENTS.has(expected.intent)) throw new Error('Options order intent is invalid');
    if (!SIDES.has(expected.side)) throw new Error('Options order side is invalid');
    if (!/^[CP]-(BTC|ETH)-[0-9]+(?:\\.[0-9]+)?-[0-9]{6}$/.test(expected.symbol)) {
      throw new Error('Options order symbol is outside the automated BTC/ETH contract format');
    }
    if (!(expected.limit_price > 0)) throw new Error('Options limit price must be positive');
    if (!expected.client_order_id || expected.client_order_id.length > 32) {
      throw new Error('Options client order ID must contain 1–32 characters');
    }
    if (typeof input.reduceOnly !== 'boolean') throw new Error('Options reduce-only intent must be explicit');

    const existing = await getAttempt(expected.client_order_id);
    if (existing) {
      if (!exactAttempt(existing, expected)) {
        throw new Error('Options client order ID already belongs to a different immutable order attempt');
      }
      return { ...existing, idempotent: true };
    }

    const row = {
      group_id: expected.group_id,
      leg_id: expected.leg_id,
      leg_role: expected.leg_role,
      intent: expected.intent,
      attempt_no: expected.attempt_no,
      product_id: expected.product_id,
      symbol: expected.symbol,
      side: expected.side,
      requested_qty: expected.requested_qty,
      filled_qty: 0,
      limit_price: expected.limit_price,
      reduce_only: expected.reduce_only,
      order_state: 'RESERVED',
      exchange_order_id: null,
      client_order_id: expected.client_order_id,
      average_fill_price: null,
      commission: null,
      commission_currency: null,
      raw: {
        source: 'delta_options_order_ledger',
        persistence_state: 'RESERVED_BEFORE_SUBMIT'
      },
      created_at: isoNow(now),
      updated_at: isoNow(now)
    };

    if (typeof database?.insert !== 'function') throw new Error('Options order ledger writer is unavailable');
    try {
      await database.insert('dd_options_execution_orders', row);
    } catch (insertError) {
      // A timeout may happen after PostgREST committed the row. Recover only by
      // the unique client ID and only when every immutable field matches.
      const recovered = await getAttempt(expected.client_order_id).catch(() => null);
      if (recovered && exactAttempt(recovered, expected)) {
        return { ...recovered, idempotent: true, recoveredAfterAmbiguousInsert: true };
      }
      throw insertError;
    }

    const persisted = await getAttempt(expected.client_order_id);
    if (!persisted || !exactAttempt(persisted, expected) || upper(persisted.order_state) !== 'RESERVED') {
      throw new Error('Options order attempt could not be verified in the durable ledger; exchange submission is prohibited');
    }
    return { ...persisted, idempotent: false };
  }

  async function updateAttempt(clientOrderId, expectedExchangeOrderId, patch, expectedState = null) {
    if (typeof database?.updateReturning !== 'function') {
      throw new Error('Options order ledger conditional updater is unavailable');
    }
    const id = textValue(clientOrderId);
    const query = 'client_order_id=eq.' + encodeURIComponent(id) +
      (expectedExchangeOrderId ? '&exchange_order_id=eq.' + encodeURIComponent(String(expectedExchangeOrderId)) : '') +
      (expectedState ? '&order_state=eq.' + encodeURIComponent(expectedState) : '');
    const updated = await database.updateReturning('dd_options_execution_orders', query, {
      ...patch,
      updated_at: isoNow(now)
    });
    if (!Array.isArray(updated) || updated.length !== 1) {
      throw new Error('Options order ledger update was not confirmed as exactly one row');
    }
    return updated[0];
  }

  async function recordAcknowledgement(clientOrderId, acknowledgement) {
    const row = await getAttempt(clientOrderId);
    if (!row) throw new Error('Cannot record an Options acknowledgement without a persisted order attempt');
    const ack = acknowledgement && typeof acknowledgement === 'object' ? acknowledgement : {};
    const ackClientId = textValue(ack.client_order_id ?? ack.clientOrderId);
    const exchangeOrderId = textValue(ack.id ?? ack.order_id ?? ack.orderId);
    const ackSymbol = upper(ack.product_symbol ?? ack.symbol);
    const ackProductId = finite(ack.product_id ?? ack.productId);
    const ackSide = upper(ack.side);
    const ackSize = finite(ack.size);
    const exchangeState = textValue(ack.state).toLowerCase();

    if (ackClientId !== String(row.client_order_id) ||
        !exchangeOrderId ||
        ackSymbol !== upper(row.symbol) ||
        ackProductId !== Number(row.product_id) ||
        ackSide !== upper(row.side) ||
        ackSize !== Number(row.requested_qty)) {
      await updateAttempt(row.client_order_id, null, {
        order_state: 'RECONCILIATION_REQUIRED',
        raw: {
          ...(row.raw && typeof row.raw === 'object' ? row.raw : {}),
          acknowledgement_error: 'Exchange acknowledgement did not match persisted client ID, product, side and size',
          acknowledgement_received_at: isoNow(now)
        }
      }, 'RESERVED').catch(() => {});
      throw new Error('Delta Options acknowledgement did not match the durable order attempt; reconciliation required');
    }

    const nextState = normalizedState(exchangeState);
    const safeAck = {
      id: exchangeOrderId,
      client_order_id: ackClientId,
      product_id: ackProductId,
      product_symbol: ackSymbol,
      side: ackSide,
      size: ackSize,
      state: exchangeState,
      unfilled_size: finite(ack.unfilled_size),
      created_at: textValue(ack.created_at),
      updated_at: textValue(ack.updated_at)
    };

    if (upper(row.order_state) !== 'RESERVED') {
      if (String(row.exchange_order_id || '') === exchangeOrderId &&
          ['OPEN', 'SUBMITTED', 'UNKNOWN', 'CANCELLED', 'REJECTED', 'PARTIALLY_FILLED', 'FILLED'].includes(upper(row.order_state))) {
        return { ...row, idempotent: true };
      }
      throw new Error('Options acknowledgement cannot overwrite a non-RESERVED order attempt');
    }

    return updateAttempt(row.client_order_id, null, {
      order_state: nextState,
      exchange_order_id: exchangeOrderId,
      raw: {
        ...(row.raw && typeof row.raw === 'object' ? row.raw : {}),
        exchange_acknowledgement: safeAck,
        exchange_state: exchangeState,
        acknowledgement_received_at: isoNow(now)
      }
    }, 'RESERVED');
  }

  async function markSubmissionUnknown(clientOrderId, error) {
    const row = await getAttempt(clientOrderId);
    if (!row) throw new Error('Cannot mark an Options submission unknown without a persisted attempt');
    if (upper(row.order_state) !== 'RESERVED') {
      throw new Error('Options submission can only be marked unknown while its exchange outcome is ambiguous');
    }
    if (upper(row.order_state) === 'UNKNOWN') return { ...row, idempotent: true };
    return updateAttempt(row.client_order_id, null, {
      order_state: 'UNKNOWN',
      raw: {
        ...(row.raw && typeof row.raw === 'object' ? row.raw : {}),
        submission_outcome: 'UNKNOWN',
        submission_error: textValue(error?.message || error).slice(0, 240),
        submission_error_at: isoNow(now),
        blind_retry_prohibited: true
      }
    }, 'RESERVED');
  }

  async function reconcileFills(clientOrderId, {
    executor,
    startTimeUs,
    endTimeUs,
    pageSize = 50
  } = {}) {
    const row = await getAttempt(clientOrderId);
    if (!row) throw new Error('Options fill reconciliation requires a persisted order attempt');
    if (!textValue(row.exchange_order_id)) {
      throw new Error('Options fill reconciliation requires a verified exchange order ID');
    }
    if (!executor || typeof executor.getOptionFillsPage !== 'function') {
      throw new Error('Dedicated Options exchange fill reader is unavailable');
    }
    const start = Number(startTimeUs);
    const end = Number(endTimeUs);
    const size = Number(pageSize);
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end <= start ||
        !Number.isSafeInteger(size) || size < 1 || size > 50) {
      throw new Error('Options fill reconciliation requires a valid microsecond window and page size 1–50');
    }

    const matchingFills = [];
    const seenFillIds = new Set();
    const seenCursors = new Set();
    let after = null;
    let pageCount = 0;
    do {
      const page = await executor.getOptionFillsPage({
        startTime: start,
        endTime: end,
        after,
        pageSize: size
      });
      if (!page || !Array.isArray(page.rows)) {
        throw new Error('Options fills endpoint returned a malformed page; no fill totals were persisted');
      }
      pageCount += 1;
      for (const inputFill of page.rows) {
        const fill = normalizeFill(inputFill);
        if (fill.orderId !== String(row.exchange_order_id)) continue;
        if (!fill.id || !Number.isSafeInteger(fill.productId) ||
            fill.productId !== Number(row.product_id) ||
            fill.symbol !== upper(row.symbol) ||
            fill.side !== upper(row.side) ||
            !Number.isSafeInteger(fill.size) || fill.size <= 0 ||
            !(fill.price > 0)) {
          throw new Error('Matching Delta option fill is malformed or conflicts with the persisted order; reconciliation required');
        }
        if (seenFillIds.has(fill.id)) continue;
        seenFillIds.add(fill.id);
        matchingFills.push(fill);
      }
      const next = textValue(page.after);
      if (!next) {
        after = null;
      } else {
        if (next === after || seenCursors.has(next)) {
          throw new Error('Options fills pagination repeated a cursor; reconciliation is incomplete');
        }
        seenCursors.add(next);
        after = next;
      }
      if (after && pageCount >= maxFillPages) {
        throw new Error('Options fills pagination exceeded the configured page bound; totals were not persisted');
      }
    } while (after);

    const filledQty = matchingFills.reduce((sum, fill) => sum + fill.size, 0);
    if (filledQty > Number(row.requested_qty)) {
      return updateAttempt(row.client_order_id, row.exchange_order_id, {
        order_state: 'RECONCILIATION_REQUIRED',
        raw: {
          ...(row.raw && typeof row.raw === 'object' ? row.raw : {}),
          fill_reconciliation: {
            status: 'RECONCILIATION_REQUIRED',
            reason: 'Exchange fill quantity exceeded requested quantity',
            fill_ids: [...seenFillIds],
            filled_qty: filledQty
          }
        }
      });
    }

    const notional = matchingFills.reduce((sum, fill) => sum + fill.size * fill.price, 0);
    const allCommissionsKnown = matchingFills.length > 0 &&
      matchingFills.every(fill => fill.commission !== null);
    const currencies = [...new Set(matchingFills.map(fill => fill.commissionCurrency).filter(Boolean))];
    const currencyConsistent = currencies.length === 1 &&
      matchingFills.every(fill => Boolean(fill.commissionCurrency));
    const commission = allCommissionsKnown
      ? matchingFills.reduce((sum, fill) => sum + fill.commission, 0)
      : null;
    const commissionCurrency = currencyConsistent ? currencies[0] : null;
    if (currencies.length > 1) {
      throw new Error('Options fills contain mixed commission currencies; reconciliation is blocked');
    }

    const requestedQty = Number(row.requested_qty);
    const exchangeState = textValue(row.raw?.exchange_state).toLowerCase();
    const nextState = filledQty === requestedQty
      ? 'FILLED'
      : filledQty > 0
        ? 'PARTIALLY_FILLED'
        : normalizedState(exchangeState);
    const averageFillPrice = filledQty > 0 ? notional / filledQty : null;
    return updateAttempt(row.client_order_id, row.exchange_order_id, {
      order_state: nextState,
      filled_qty: filledQty,
      average_fill_price: averageFillPrice,
      commission,
      commission_currency: commissionCurrency,
      raw: {
        ...(row.raw && typeof row.raw === 'object' ? row.raw : {}),
        fill_reconciliation: {
          status: 'COMPLETE',
          start_time_us: start,
          end_time_us: end,
          page_count: pageCount,
          fill_ids: [...seenFillIds],
          filled_qty: filledQty,
          average_fill_price: averageFillPrice,
          commission,
          commission_currency: commissionCurrency,
          all_commissions_known: allCommissionsKnown,
          reconciled_at: isoNow(now)
        }
      }
    });
  }

  async function listGroupAttempts(groupId) {
    const id = textValue(groupId);
    if (!id || id.length > 80) throw new Error('Options group ID is invalid');
    if (typeof database?.select !== 'function') throw new Error('Options order ledger reader is unavailable');
    const rows = await database.select(
      'dd_options_execution_orders',
      'group_id=eq.' + encodeURIComponent(id) + '&select=*&order=id.asc&limit=100'
    );
    if (!Array.isArray(rows) || rows.length > 100) {
      throw new Error('Options group order-attempt snapshot is malformed');
    }
    return rows;
  }

  return Object.freeze({
    getAttempt,
    persistAttempt,
    recordAcknowledgement,
    markSubmissionUnknown,
    reconcileFills,
    listGroupAttempts
  });
}
