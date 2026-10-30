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
  if (value === 'closed' || value === 'filled') return 'SUBMITTED'; // Actual fill records, not the order response, prove quantity and VWAP.
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

function normalizeFilledAt(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e14) {
    const date = new Date(numeric / 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (Number.isFinite(numeric) && numeric > 1e11) {
    const date = new Date(numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(textValue(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function unwrapRpcResult(value) {
  return Array.isArray(value) ? value[0] : value;
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
    ),
    filledAt: normalizeFilledAt(fill?.created_at ?? fill?.filled_at ?? fill?.timestamp),
    raw: fill && typeof fill === 'object' ? fill : {}
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
    if (!/^[CP]-(BTC|ETH)-[0-9]+(?:\.[0-9]+)?-[0-9]{6}$/.test(expected.symbol)) {
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
      if (upper(existing.order_state) !== 'RESERVED') {
        throw new Error('Options client order ID already has a non-RESERVED outcome; reconciliation is required and resubmission is prohibited');
      }
      return { ...existing, idempotent: true };
    }

    if (typeof database?.select !== 'function' || typeof database?.rpc !== 'function') {
      throw new Error('Atomic Options order-attempt reservation RPC is unavailable');
    }
    const legRows = await database.select(
      'dd_options_execution_legs',
      'id=eq.' + encodeURIComponent(String(expected.leg_id)) +
        '&group_id=eq.' + encodeURIComponent(expected.group_id) +
        '&select=id,group_id,leg_role,product_id,symbol,side,requested_qty&limit=2'
    );
    if (!Array.isArray(legRows) || legRows.length !== 1) {
      throw new Error('Options order attempt must reference exactly one persisted leg in the same group');
    }
    const leg = legRows[0];
    const expectedSide = expected.intent === 'ENTRY'
      ? upper(leg.side)
      : upper(leg.side) === 'BUY' ? 'SELL' : 'BUY';
    if (upper(leg.leg_role) !== expected.leg_role ||
        Number(leg.product_id) !== expected.product_id ||
        upper(leg.symbol) !== expected.symbol ||
        expected.side !== expectedSide ||
        expected.requested_qty > Number(leg.requested_qty) ||
        (expected.intent === 'ENTRY' && expected.reduce_only) ||
        (expected.intent !== 'ENTRY' && !expected.reduce_only)) {
      throw new Error('Options order attempt conflicts with its persisted leg role, product, side, quantity or reduce-only intent');
    }

    const rpcArgs = {
      p_group_id: expected.group_id,
      p_leg_role: expected.leg_role,
      p_intent: expected.intent,
      p_attempt_no: expected.attempt_no,
      p_client_order_id: expected.client_order_id,
      p_limit_price: expected.limit_price
    };
    let reservation;
    try {
      reservation = unwrapRpcResult(
        await database.rpc('reserve_dd_options_order_attempt', rpcArgs)
      );
    } catch (rpcError) {
      // The transaction may have committed even if its HTTP response was lost.
      // Recover only by exact client ID + immutable field verification.
      const recovered = await getAttempt(expected.client_order_id).catch(() => null);
      if (recovered && exactAttempt(recovered, expected) &&
          upper(recovered.order_state) === 'RESERVED') {
        return { ...recovered, idempotent: true, recoveredAfterAmbiguousReservation: true };
      }
      throw rpcError;
    }

    if (!reservation || typeof reservation !== 'object' ||
        !reservation.order_attempt_id ||
        String(reservation.client_order_id) !== expected.client_order_id) {
      const recovered = await getAttempt(expected.client_order_id).catch(() => null);
      if (recovered && exactAttempt(recovered, expected) &&
          upper(recovered.order_state) === 'RESERVED') {
        return { ...recovered, idempotent: true, recoveredAfterAmbiguousReservation: true };
      }
      throw new Error('Atomic Options order-attempt reservation could not be confirmed; exchange submission is prohibited');
    }

    const persisted = await getAttempt(expected.client_order_id);
    if (!persisted ||
        String(persisted.id) !== String(reservation.order_attempt_id) ||
        !exactAttempt(persisted, expected) ||
        upper(persisted.order_state) !== 'RESERVED' ||
        Boolean(persisted.reduce_only) !== expected.reduce_only) {
      throw new Error('Reserved Options order attempt does not exactly match the persisted request; reconciliation required');
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
    if (typeof database?.rpc !== 'function') throw new Error('Options acknowledgement RPC is unavailable');
    const ack = acknowledgement && typeof acknowledgement === 'object' ? acknowledgement : {};
    const ackClientId = textValue(ack.client_order_id ?? ack.clientOrderId);
    const exchangeOrderId = textValue(ack.id ?? ack.order_id ?? ack.orderId);
    const ackSymbol = upper(ack.product_symbol ?? ack.symbol);
    const ackProductId = finite(ack.product_id ?? ack.productId);
    const ackSide = upper(ack.side);
    const ackSize = finite(ack.size);
    const unfilled = finite(ack.unfilled_size);
    const exchangeState = textValue(ack.state).toLowerCase();
    const identityMatches = ackClientId === String(row.client_order_id) &&
      Boolean(exchangeOrderId) &&
      ackSymbol === upper(row.symbol) &&
      ackProductId === Number(row.product_id) &&
      ackSide === upper(row.side) &&
      ackSize === Number(row.requested_qty);

    const ackFilledQty = unfilled === null
      ? 0
      : Math.max(0, Number(row.requested_qty) - unfilled);
    const safeAck = {
      id: exchangeOrderId || null,
      client_order_id: ackClientId || null,
      product_id: ackProductId,
      product_symbol: ackSymbol || null,
      side: ackSide || null,
      size: ackSize,
      state: exchangeState || 'unknown',
      unfilled_size: unfilled,
      created_at: textValue(ack.created_at),
      updated_at: textValue(ack.updated_at)
    };

    if (identityMatches &&
        String(row.exchange_order_id || '') === exchangeOrderId &&
        upper(row.order_state) !== 'RECONCILIATION_REQUIRED') {
      return { ...row, idempotent: true };
    }

    if (!identityMatches) {
      await database.rpc('record_dd_options_order_ack', {
        p_order_attempt_id: Number(row.id),
        p_exchange_order_id: null,
        p_order_state: 'RECONCILIATION_REQUIRED',
        p_ack_filled_qty: finite(row.acknowledged_filled_qty) ?? 0,
        p_ack_average_fill_price: null,
        p_raw: {
          acknowledgement_error: 'Exchange acknowledgement did not match persisted client ID, product, side and size',
          acknowledgement_received_at: isoNow(now),
          received_acknowledgement: safeAck
        }
      }).catch(() => {});
      throw new Error('Delta Options acknowledgement did not match the durable order attempt; reconciliation required');
    }

    const stateWithFillEvidence = unfilled === null
      ? 'UNKNOWN'
      : exchangeState === 'closed' && ackFilledQty < Number(row.requested_qty)
        ? 'CANCELLED'
        : normalizedState(exchangeState);
    const ackAverageFillPrice = finite(
      ack.average_fill_price ?? ack.avg_fill_price ?? ack.average_fill_price_with_fees
    );
    const response = unwrapRpcResult(await database.rpc('record_dd_options_order_ack', {
      p_order_attempt_id: Number(row.id),
      p_exchange_order_id: exchangeOrderId,
      p_order_state: stateWithFillEvidence,
      p_ack_filled_qty: ackFilledQty,
      p_ack_average_fill_price: ackAverageFillPrice,
      p_raw: {
        exchange_acknowledgement: safeAck,
        exchange_state: exchangeState,
        acknowledgement_received_at: isoNow(now)
      }
    }));
    const persisted = await getAttempt(row.client_order_id);
    if (!persisted || String(persisted.exchange_order_id || '') !== exchangeOrderId) {
      throw new Error('Delta Options acknowledgement RPC was not confirmed in the durable ledger');
    }
    if (response?.reconciliation_required === true ||
        upper(persisted.order_state) === 'RECONCILIATION_REQUIRED') {
      return { ...persisted, reconciliationRequired: true };
    }
    return persisted;
  }
  async function markSubmissionUnknown(clientOrderId, error) {
    const row = await getAttempt(clientOrderId);
    if (!row) throw new Error('Cannot mark an Options submission unknown without a persisted attempt');
    if (upper(row.order_state) === 'RECONCILIATION_REQUIRED') {
      return { ...row, idempotent: true };
    }
    if (upper(row.order_state) === 'UNKNOWN') {
      return { ...row, idempotent: true };
    }
    if (upper(row.order_state) !== 'RESERVED') {
      throw new Error('Options submission can only be marked unknown while its exchange outcome is ambiguous');
    }
    if (typeof database?.rpc !== 'function') throw new Error('Options acknowledgement RPC is unavailable');
    const response = unwrapRpcResult(await database.rpc('record_dd_options_order_ack', {
      p_order_attempt_id: Number(row.id),
      p_exchange_order_id: null,
      p_order_state: 'UNKNOWN',
      p_ack_filled_qty: 0,
      p_ack_average_fill_price: null,
      p_raw: {
        submission_outcome: 'UNKNOWN',
        submission_error: textValue(error?.message || error).slice(0, 240),
        submission_error_at: isoNow(now),
        blind_retry_prohibited: true
      }
    }));
    const persisted = await getAttempt(row.client_order_id);
    if (!persisted || upper(persisted.order_state) !== 'RECONCILIATION_REQUIRED' ||
        response?.reconciliation_required !== true) {
      throw new Error('Ambiguous Options submission was not durably locked for reconciliation');
    }
    return persisted;
  }
  async function markFillReconciliationRequired(row, reason, extra = {}) {
    if (typeof database?.rpc !== 'function') {
      throw new Error('Options acknowledgement RPC is unavailable to mark reconciliation state');
    }
    await database.rpc('record_dd_options_order_ack', {
      p_order_attempt_id: Number(row.id),
      p_exchange_order_id: textValue(row.exchange_order_id) || null,
      p_order_state: 'RECONCILIATION_REQUIRED',
      p_ack_filled_qty: finite(row.acknowledged_filled_qty) ?? 0,
      p_ack_average_fill_price: finite(row.average_fill_price),
      p_raw: {
        reconciliation_reason: textValue(reason),
        reconciliation_marked_at: isoNow(now),
        ...extra
      }
    });
    const latest = await getAttempt(row.client_order_id);
    if (!latest || upper(latest.order_state) !== 'RECONCILIATION_REQUIRED') {
      throw new Error('Options order could not be durably marked RECONCILIATION_REQUIRED');
    }
    return latest;
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
    if (typeof database?.rpc !== 'function') {
      throw new Error('Durable Options fill-recording RPC is unavailable');
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
            !(fill.price > 0) || !fill.filledAt ||
            (fill.commission !== null && !fill.commissionCurrency)) {
          return markFillReconciliationRequired(
            row,
            'Matching Delta option fill is malformed or conflicts with the persisted order',
            { fill_id: fill.id || null }
          );
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
          return markFillReconciliationRequired(row, 'Options fills pagination repeated a cursor');
        }
        seenCursors.add(next);
        after = next;
      }
      if (after && pageCount >= maxFillPages) {
        return markFillReconciliationRequired(row, 'Options fills pagination exceeded the configured page bound', {
          max_fill_pages: maxFillPages
        });
      }
    } while (after);

    for (const fill of matchingFills) {
      const rpcResult = unwrapRpcResult(await database.rpc('record_dd_options_execution_fill', {
        p_order_attempt_id: Number(row.id),
        p_exchange_fill_id: fill.id,
        p_fill_qty: fill.size,
        p_fill_price: fill.price,
        p_commission: fill.commission,
        p_commission_currency: fill.commissionCurrency || null,
        p_filled_at: fill.filledAt,
        p_raw: fill.raw
      }));
      if (rpcResult?.collision === true || rpcResult?.reconciliation_required === true) {
        const latest = await getAttempt(row.client_order_id);
        if (latest && upper(latest.order_state) === 'RECONCILIATION_REQUIRED') return latest;
        return markFillReconciliationRequired(row, 'Durable fill RPC reported a collision or risk mismatch', {
          fill_id: fill.id,
          rpc_result: rpcResult || null
        });
      }
      if (!rpcResult || String(rpcResult.order_attempt_id) !== String(row.id)) {
        return markFillReconciliationRequired(row, 'Durable fill RPC did not confirm the target order attempt', {
          fill_id: fill.id
        });
      }
    }

    const persisted = await getAttempt(row.client_order_id);
    if (!persisted) throw new Error('Options order disappeared during durable fill reconciliation');
    if (upper(persisted.order_state) === 'RECONCILIATION_REQUIRED') return persisted;

    const allCommissionsKnown = matchingFills.length > 0 &&
      matchingFills.every(fill => fill.commission !== null && Boolean(fill.commissionCurrency));
    const fillIds = [...seenFillIds];
    return updateAttempt(row.client_order_id, row.exchange_order_id, {
      raw: {
        ...(persisted.raw && typeof persisted.raw === 'object' ? persisted.raw : {}),
        fill_reconciliation: {
          status: 'COMPLETE',
          source: 'dd_options_execution_fills',
          start_time_us: start,
          end_time_us: end,
          page_count: pageCount,
          fill_ids: fillIds,
          filled_qty: finite(persisted.filled_qty) ?? 0,
          average_fill_price: finite(persisted.average_fill_price),
          commission: finite(persisted.commission),
          commission_currency: textValue(persisted.commission_currency) || null,
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
