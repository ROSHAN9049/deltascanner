import {
  makeOptionsClientOrderId,
  getOptionsOrderClientIdRole
} from './delta-options-execution-policy.mjs';

const ROLES = new Set(['LONG_PREMIUM', 'PROTECTIVE_WING', 'SHORT_OPTION']);
const INTENTS = new Set(['ENTRY', 'EXIT', 'UNWIND']);
const upper = value => String(value ?? '').trim().toUpperCase();
const text = value => String(value ?? '').trim();
const positive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const safeInteger = value => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

function clientIdRole(intent, role) {
  return getOptionsOrderClientIdRole(intent, role);
}

function validateInput(input = {}) {
  const groupId = text(input.groupId);
  const legRole = upper(input.legRole);
  const intent = upper(input.intent);
  const attemptNo = safeInteger(input.attemptNo);
  const limitPrice = positive(input.limitPrice);
  if (!groupId || groupId.length > 80 ||
      !ROLES.has(legRole) || !INTENTS.has(intent) ||
      !attemptNo || !limitPrice) {
    throw new Error('Options coordinator requires a valid group, role, intent, attempt number and limit price');
  }
  return { groupId, legRole, intent, attemptNo, limitPrice };
}

function matchesReservation(reservation, attempt, expected, clientOrderId) {
  return Boolean(reservation && attempt &&
    String(reservation.client_order_id) === clientOrderId &&
    upper(reservation.order_state) === 'RESERVED' &&
    String(attempt.client_order_id) === clientOrderId &&
    String(reservation.group_id) === expected.groupId &&
    String(attempt.group_id) === expected.groupId &&
    String(reservation.order_attempt_id) === String(attempt.id) &&
    String(reservation.leg_id) === String(attempt.leg_id) &&
    upper(reservation.leg_role) === expected.legRole &&
    upper(attempt.leg_role) === expected.legRole &&
    upper(reservation.intent) === expected.intent &&
    upper(attempt.intent) === expected.intent &&
    Number(reservation.attempt_no) === expected.attemptNo &&
    Number(attempt.attempt_no) === expected.attemptNo &&
    Number(reservation.product_id) === Number(attempt.product_id) &&
    upper(reservation.symbol) === upper(attempt.symbol) &&
    upper(reservation.side) === upper(attempt.side) &&
    Number(reservation.qty) === Number(attempt.requested_qty) &&
    Number(reservation.limit_price) === Number(attempt.limit_price) &&
    Number(reservation.limit_price) === expected.limitPrice &&
    Boolean(reservation.reduce_only) === Boolean(attempt.reduce_only));
}

function fillWindow(attempt, now) {
  const createdAt = Date.parse(String(attempt?.created_at ?? ''));
  const endMs = Number(now);
  if (!Number.isFinite(endMs) || endMs <= 0) {
    throw new Error('Options fill reconciliation clock is invalid');
  }
  const startMs = Number.isFinite(createdAt)
    ? Math.max(1, createdAt - 60_000)
    : Math.max(1, endMs - 10 * 60_000);
  const endTimeUs = Math.floor(Math.max(endMs, startMs + 1) * 1000);
  const startTimeUs = Math.floor(startMs * 1000);
  if (!Number.isSafeInteger(startTimeUs) || !Number.isSafeInteger(endTimeUs) ||
      endTimeUs <= startTimeUs) {
    throw new Error('Options fill reconciliation window is invalid');
  }
  return { startTimeUs, endTimeUs };
}

function resultFor(row, extra = {}) {
  const state = upper(row?.order_state || 'UNKNOWN');
  const status = ['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED'].includes(state)
    ? 'ORDER_PENDING'
    : state;
  return {
    status,
    orderState: state,
    orderAttemptId: row?.id ?? extra.orderAttemptId ?? null,
    clientOrderId: row?.client_order_id ?? extra.clientOrderId ?? null,
    exchangeOrderId: row?.exchange_order_id ?? null,
    requestedQty: positive(row?.requested_qty),
    filledQty: Number(row?.filled_qty ?? 0),
    averageFillPrice: positive(row?.average_fill_price),
    ...extra
  };
}

export function createDeltaOptionsOrderCoordinator({
  manager,
  executor,
  ledger,
  now = () => Date.now(),
} = {}) {
  if (!manager || typeof manager.assertExecutionAllowed !== 'function' ||
      typeof manager.reserveOrderAttempt !== 'function' ||
      typeof manager.recordOrderAcknowledgement !== 'function') {
    throw new Error('Delta Options coordinator requires the durable execution manager');
  }
  if (!executor || typeof executor.placeOptionOrder !== 'function' ||
      typeof executor.getOptionOrderByClientId !== 'function' ||
      typeof executor.assertConfigured !== 'function') {
    throw new Error('Delta Options coordinator requires the dedicated Testnet order executor');
  }
  if (!ledger || typeof ledger.getAttempt !== 'function' ||
      typeof ledger.recordAcknowledgement !== 'function' ||
      typeof ledger.markSubmissionUnknown !== 'function' ||
      typeof ledger.reconcileFills !== 'function') {
    throw new Error('Delta Options coordinator requires the durable order/fill ledger');
  }

  const inFlightGroups = new Map();

  async function markReconciliationRequired(attempt, reason, extra = {}) {
    const response = await manager.recordOrderAcknowledgement({
      orderAttemptId: Number(attempt.id),
      exchangeOrderId: text(attempt.exchange_order_id) || null,
      orderState: 'RECONCILIATION_REQUIRED',
      acknowledgedFilledQty: Number(attempt.acknowledged_filled_qty ?? 0),
      averageFillPrice: positive(attempt.average_fill_price),
      raw: {
        source: 'delta_options_order_coordinator',
        reconciliation_reason: text(reason).slice(0, 240),
        reconciliation_required_at: new Date(now()).toISOString(),
        ...extra
      }
    });
    if (!response || Number(response.order_attempt_id) !== Number(attempt.id)) {
      throw new Error('Options order reconciliation lock was not confirmed by the database');
    }
    return ledger.getAttempt(attempt.client_order_id);
  }

  async function reconcileAcknowledgement(clientOrderId, acknowledgement, extra = {}) {
    let acknowledged;
    try {
      acknowledged = await ledger.recordAcknowledgement(clientOrderId, acknowledgement);
    } catch (error) {
      const latest = await ledger.getAttempt(clientOrderId).catch(() => null);
      if (!latest || upper(latest.order_state) !== 'RECONCILIATION_REQUIRED') throw error;
      acknowledged = latest;
    }

    if (!text(acknowledged?.exchange_order_id)) {
      const latest = await markReconciliationRequired(
        acknowledged,
        'Exchange acknowledgement has no verified exchange order ID',
        { acknowledgement_received: true }
      );
      return resultFor(latest, extra);
    }

    try {
      const window = fillWindow(acknowledged, now());
      const reconciled = await ledger.reconcileFills(clientOrderId, {
        executor,
        ...window,
        pageSize: 50
      });
      return resultFor(reconciled, extra);
    } catch (error) {
      const latest = await ledger.getAttempt(clientOrderId);
      const parked = await markReconciliationRequired(latest, error?.message || error, {
        fill_reconciliation_failed: true
      });
      return resultFor(parked, {
        ...extra,
        fillReconciliationError: text(error?.message || error).slice(0, 240)
      });
    }
  }

  async function recoverAmbiguousSubmission(clientOrderId, submitError) {
    let acknowledgement;
    try {
      // A failed POST is ambiguous. Only an exact client-order lookup can
      // establish whether Delta accepted it; never submit a replacement.
      acknowledgement = await executor.getOptionOrderByClientId(clientOrderId);
    } catch (lookupError) {
      const parked = await ledger.markSubmissionUnknown(clientOrderId, new Error(
        'POST outcome unknown; exact client-order lookup unresolved: ' +
        text(lookupError?.message || lookupError).slice(0, 180)
      ));
      return resultFor(parked, {
        ambiguousSubmission: true,
        blindRetryProhibited: true,
        submissionError: text(submitError?.message || submitError).slice(0, 180)
      });
    }
    return reconcileAcknowledgement(clientOrderId, acknowledgement, {
      recoveredByExactClientOrderLookup: true,
      submissionError: text(submitError?.message || submitError).slice(0, 180)
    });
  }

  async function submitOnce(expected, clientOrderId) {
    // The source-code lock is checked before any reservation or network write.
    // The manager and exchange executor independently enforce the same lock.
    manager.assertExecutionAllowed();
    executor.assertConfigured();

    const reservation = await manager.reserveOrderAttempt({
      groupId: expected.groupId,
      legRole: expected.legRole,
      intent: expected.intent,
      attemptNo: expected.attemptNo,
      limitPrice: expected.limitPrice
    });

    if (reservation?.recoveredAfterAmbiguousRpc === true ||
        reservation?.recoveredAfterAmbiguousReservation === true) {
      return {
        status: 'RECOVERED_RESERVATION_NOT_RESUBMITTED',
        clientOrderId,
        blindRetryProhibited: true,
        reason: 'A prior reservation already exists; use exact exchange lookup/reconciliation before any further action'
      };
    }

    const attempt = await ledger.getAttempt(clientOrderId);
    if (!matchesReservation(reservation, attempt, expected, clientOrderId)) {
      if (attempt?.id) {
        const parked = await markReconciliationRequired(
          attempt,
          'Database reservation and persisted order attempt did not match exactly'
        );
        return resultFor(parked, { clientOrderId, reservationMismatch: true });
      }
      throw new Error('Options durable order reservation could not be verified; exchange submission was not attempted');
    }

    if (upper(attempt.order_state) !== 'RESERVED') {
      return resultFor(attempt, {
        blindRetryProhibited: true,
        reason: 'Order attempt is not a fresh RESERVED row; no exchange request was sent'
      });
    }

    let acknowledgement;
    try {
      acknowledgement = await executor.placeOptionOrder({
        symbol: attempt.symbol,
        side: attempt.side,
        qty: Number(attempt.requested_qty),
        limitPrice: Number(attempt.limit_price),
        clientOrderId: attempt.client_order_id,
        reduceOnly: attempt.reduce_only === true
      });
    } catch (error) {
      return recoverAmbiguousSubmission(clientOrderId, error);
    }

    return reconcileAcknowledgement(clientOrderId, acknowledgement);
  }

  async function submit(input = {}) {
    const expected = validateInput(input);
    const clientOrderId = makeOptionsClientOrderId(
      expected.groupId,
      clientIdRole(expected.intent, expected.legRole),
      expected.attemptNo
    );
    const active = inFlightGroups.get(expected.groupId);
    if (active) {
      throw new Error('Another Options order request is already running for this execution group');
    }

    const operation = submitOnce(expected, clientOrderId);
    inFlightGroups.set(expected.groupId, operation);
    try {
      return await operation;
    } finally {
      if (inFlightGroups.get(expected.groupId) === operation) {
        inFlightGroups.delete(expected.groupId);
      }
    }
  }

  return Object.freeze({ submit });
}
