import crypto from 'node:crypto';
import * as defaultDatabase from '../../server/db.js';
import {
  isOptionsExecutionAllowed,
  OPTIONS_EXECUTION_LOCK_REASON
} from '../options-execution-lock.mjs';
import {
  makeOptionsClientOrderId,
  getOptionsOrderClientIdRole,
  validateCreditSpreadEntryPlan,
  validateLongOptionEntryPlan
} from './delta-options-execution-policy.mjs';

const finitePositive = input => {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? value : null;
};
const upper = input => String(input ?? '').trim().toUpperCase();

function validClientGroupId(input) {
  const value = String(input ?? '').trim();
  if (value.length < 8 || value.length > 80) {
    throw new Error('Options client group ID must be 8–80 characters');
  }
  return value;
}

function sameNumber(left, right) {
  return Number.isFinite(Number(left)) && Number(left) === Number(right);
}

function sameInstant(left, right) {
  const a = Date.parse(String(left ?? ''));
  const b = Date.parse(String(right ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

export function matchesPersistedOptionsReservation(groupRow, legRows, payload) {
  if (!groupRow || !Array.isArray(legRows) || !payload?.group || !Array.isArray(payload.legs)) {
    return false;
  }
  const group = payload.group;
  if (String(groupRow.client_group_id ?? '') !== String(group.client_group_id) ||
      upper(groupRow.state) !== 'RESERVED' ||
      upper(groupRow.strategy) !== upper(group.strategy) ||
      upper(groupRow.underlying_symbol) !== upper(group.underlying_symbol) ||
      upper(groupRow.underlying_direction) !== upper(group.underlying_direction) ||
      upper(groupRow.option_type) !== upper(group.option_type) ||
      !sameInstant(groupRow.expiry_at, group.expiry_at) ||
      !sameNumber(groupRow.requested_qty, group.requested_qty) ||
      !sameNumber(groupRow.matched_qty ?? 0, 0) ||
      !sameNumber(groupRow.risk_budget_usd, group.risk_budget_usd) ||
      !sameNumber(groupRow.max_loss_usd, group.max_loss_usd) ||
      !sameNumber(groupRow.reserved_margin_usd, group.reserved_margin_usd) ||
      upper(groupRow.settlement_asset) !== upper(group.settlement_asset) ||
      (group.net_credit_usd === null
        ? groupRow.net_credit_usd !== null
        : !sameNumber(groupRow.net_credit_usd, group.net_credit_usd))) {
    return false;
  }

  if (legRows.length !== payload.legs.length) return false;
  const persistedByRole = new Map(
    legRows.map(row => [upper(row?.leg_role), row])
  );
  for (const expected of payload.legs) {
    const row = persistedByRole.get(upper(expected.role));
    if (!row ||
        !sameNumber(row.product_id, expected.productId) ||
        upper(row.symbol) !== upper(expected.symbol) ||
        upper(row.contract_type) !== upper(expected.contractType) ||
        upper(row.option_type) !== upper(expected.optionType) ||
        !sameNumber(row.strike, expected.strike) ||
        !sameNumber(row.contract_value, expected.contractValue) ||
        !sameNumber(row.tick_size, expected.tickSize) ||
        upper(row.settlement_asset) !== upper(expected.settlement_asset) ||
        !sameInstant(row.expiry_at, expected.expiry_at) ||
        upper(row.side) !== upper(expected.side) ||
        !sameNumber(row.requested_qty, expected.qty) ||
        !sameNumber(row.filled_qty ?? 0, 0) ||
        upper(row.order_state) !== 'RESERVED' ||
        String(row.client_order_id ?? '') !== String(expected.clientOrderId)) {
      return false;
    }
  }
  return true;
}

export function buildOptionsReservationPayload({
  strategy,
  underlyingSide,
  ticker,
  shortTicker,
  protectiveTicker,
  qty,
  riskBudgetUsd,
  maxLossUsd,
  reservedMarginUsd,
  netCreditUsd,
  clientGroupId,
  now = Date.now()
} = {}) {
  const groupId = validClientGroupId(clientGroupId);
  const riskBudget = finitePositive(riskBudgetUsd);
  const maxLoss = finitePositive(maxLossUsd);
  const reserve = finitePositive(reservedMarginUsd);
  if (!riskBudget || !maxLoss || maxLoss > riskBudget || !reserve) {
    throw new Error('Options reservation needs a positive risk budget, bounded maximum loss, and positive reserve');
  }

  const mode = upper(strategy);
  const plan = mode === 'OPTIONS_BUY'
    ? validateLongOptionEntryPlan({ ticker, underlyingSide, qty, maxLossUsd: maxLoss, now })
    : mode === 'OPTIONS_SELL'
      ? validateCreditSpreadEntryPlan({
        shortTicker,
        protectiveTicker,
        underlyingSide,
        qty,
        maxLossUsd: maxLoss,
        netCreditUsd,
        now
      })
      : { valid: false, reason: 'Unsupported Options execution strategy' };

  if (!plan.valid) throw new Error(plan.reason || 'Options execution plan is invalid');
  const expiryAt = new Date(plan.expiryMs).toISOString();
  const legs = plan.legs.map(leg => ({
    role: leg.role,
    productId: leg.productId,
    symbol: leg.symbol,
    contractType: leg.contractType,
    optionType: leg.optionType,
    strike: leg.strike,
    contractValue: leg.contractValue,
    tickSize: leg.tickSize,
    settlement_asset: leg.settlementAsset,
    side: leg.side,
    qty: leg.qty,
    expiry_at: expiryAt,
    clientOrderId: makeOptionsClientOrderId(groupId, leg.role, 1)
  }));

  const group = {
    client_group_id: groupId,
    strategy: mode,
    underlying_symbol: plan.underlyingSymbol,
    underlying_direction: plan.underlyingDirection,
    option_type: plan.optionType,
    expiry_at: expiryAt,
    requested_qty: plan.qty,
    risk_budget_usd: riskBudget,
    max_loss_usd: maxLoss,
    reserved_margin_usd: reserve,
    settlement_asset: plan.settlementAsset,
    net_credit_usd: mode === 'OPTIONS_SELL' ? finitePositive(netCreditUsd) : null,
    raw: {
      source: 'delta_options_execution_manager',
      environment: 'testnet',
      entry_sequence: plan.entrySequence,
      max_loss_usd: maxLoss,
      risk_budget_usd: riskBudget,
      reserved_margin_usd: reserve,
      settlement_asset: plan.settlementAsset,
      net_credit_usd: mode === 'OPTIONS_SELL' ? Number(netCreditUsd) : null
    }
  };

  return { group, legs, plan };
}

export function createDeltaOptionsExecutionManager({
  database = defaultDatabase,
  now = () => Date.now(),
  createGroupId = () => crypto.randomUUID(),
  accountRiskGate = null
} = {}) {
  function assertExecutionAllowed() {
    if (!isOptionsExecutionAllowed()) {
      throw new Error(OPTIONS_EXECUTION_LOCK_REASON);
    }
  }

  async function assertAccountRisk(input = {}) {
    if (!accountRiskGate || typeof accountRiskGate.evaluate !== 'function') {
      throw new Error('Account-wide Options risk gate is unavailable; reservation and new entries remain blocked');
    }
    const result = await accountRiskGate.evaluate(input);
    if (!result || result.allowed !== true) {
      const reasons = Array.isArray(result?.reasons) ? result.reasons.join(',') : 'ACCOUNT_RISK_EVALUATION_UNAVAILABLE';
      throw new Error('Account-wide Options risk gate blocked the order: ' + reasons);
    }
    return result;
  }

  function preview(input) {
    const clientGroupId = input?.clientGroupId || createGroupId();
    return buildOptionsReservationPayload({
      ...input,
      clientGroupId,
      now: now()
    });
  }

  async function reserve(input) {
    // This code path stays unavailable until the independent release review
    // deliberately changes the source-code lock. It performs no DB write today.
    assertExecutionAllowed();
    if (typeof database?.rpc !== 'function') {
      throw new Error('Atomic Options reservation RPC is unavailable');
    }
    const payload = preview(input);
    await assertAccountRisk({ phase: 'RESERVE', candidate: payload.group });
    async function recoverAmbiguousReservation() {
      const existing = await getGroupByClientGroupId(payload.group.client_group_id);
      if (!existing) return null;
      const legs = await getGroupLegs(existing.id);
      if (!matchesPersistedOptionsReservation(existing, legs, payload)) return null;
      return {
        group_id: existing.id,
        client_group_id: existing.client_group_id,
        state: existing.state,
        leg_count: legs.length,
        recoveredAfterAmbiguousRpc: true,
        payload
      };
    }

    try {
      const response = await database.rpc('reserve_dd_options_execution_group', {
        p_group: payload.group,
        p_legs: payload.legs
      });
      const result = Array.isArray(response) ? response[0] : response;
      if (result && typeof result === 'object' && result.group_id &&
          result.client_group_id === payload.group.client_group_id &&
          result.state === 'RESERVED' &&
          Number(result.leg_count) === payload.legs.length) {
        return { ...result, payload };
      }
      const recovered = await recoverAmbiguousReservation().catch(() => null);
      if (recovered) return recovered;
      throw new Error('Atomic Options group reservation could not be confirmed; no order may be submitted');
    } catch (error) {
      const recovered = await recoverAmbiguousReservation().catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
  }

  async function submitReservedOrder() {
    // The DB-backed order-attempt/acknowledgement/fill pipeline is not wired yet.
    // This second release gate remains closed even if the entry constant changes.
    assertExecutionAllowed();
    throw new Error('Options order-attempt persistence and fill reconciliation are incomplete; exchange submission remains disabled');
  }

  async function getOrderAttemptByClientId(clientOrderId) {
    const id = String(clientOrderId ?? '').trim();
    if (!id || id.length > 32 || typeof database?.select !== 'function') {
      throw new Error('Options client order ID or ledger reader is invalid');
    }
    const rows = await database.select(
      'dd_options_execution_orders',
      'client_order_id=eq.' + encodeURIComponent(id) + '&select=*&limit=2'
    );
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error('Options client-order idempotency lookup returned an invalid snapshot');
    }
    return rows[0] || null;
  }

  async function getGroupOrders(groupId) {
    const id = String(groupId ?? '').trim();
    if (!id || id.length > 80 || typeof database?.select !== 'function') {
      throw new Error('Options group ID or ledger reader is invalid');
    }
    const rows = await database.select(
      'dd_options_execution_orders',
      'group_id=eq.' + encodeURIComponent(id) + '&select=*&order=created_at.asc,id.asc&limit=100'
    );
    if (!Array.isArray(rows) || rows.length > 100) {
      throw new Error('Options group order-attempt snapshot is malformed or truncated');
    }
    return rows;
  }

  async function getGroupFills(groupId) {
    const id = String(groupId ?? '').trim();
    if (!id || id.length > 80 || typeof database?.select !== 'function') {
      throw new Error('Options group ID or ledger reader is invalid');
    }
    const rows = await database.select(
      'dd_options_execution_fills',
      'group_id=eq.' + encodeURIComponent(id) + '&select=*&order=filled_at.asc,id.asc&limit=1000'
    );
    if (!Array.isArray(rows) || rows.length > 1000) {
      throw new Error('Options group fill snapshot is malformed or truncated');
    }
    return rows;
  }

  async function reserveOrderAttempt({
    groupId,
    legRole,
    intent,
    attemptNo,
    limitPrice
  } = {}) {
    // The source-code execution lock prevents even a DB order reservation in
    // this phase. When deliberately reviewed later, the RPC reserves the order
    // before the exchange request and derives side/quantity inside Postgres.
    assertExecutionAllowed();
    if (typeof database?.rpc !== 'function') {
      throw new Error('Options order-attempt reservation RPC is unavailable');
    }
    const group = String(groupId ?? '').trim();
    const role = upper(legRole);
    const action = upper(intent);
    const attempt = Number(attemptNo);
    const price = finitePositive(limitPrice);
    if (!group || group.length > 80 ||
        !['LONG_PREMIUM', 'PROTECTIVE_WING', 'SHORT_OPTION'].includes(role) ||
        !['ENTRY', 'EXIT', 'UNWIND'].includes(action) ||
        !Number.isSafeInteger(attempt) || attempt < 1 || !price) {
      throw new Error('Options order-attempt plan is invalid');
    }
    if (action === 'ENTRY') {
      await assertAccountRisk({ phase: 'ORDER', groupId: group });
    }

    const clientIdRole = getOptionsOrderClientIdRole(action, role);
    const clientOrderId = makeOptionsClientOrderId(group, clientIdRole, attempt);
    const args = {
      p_group_id: group,
      p_leg_role: role,
      p_intent: action,
      p_attempt_no: attempt,
      p_client_order_id: clientOrderId,
      p_limit_price: price
    };

    async function recoverAmbiguousAttempt() {
      const existing = await getOrderAttemptByClientId(clientOrderId);
      if (!existing) return null;
      if (String(existing.group_id) !== group ||
          upper(existing.leg_role) !== role ||
          upper(existing.intent) !== action ||
          Number(existing.attempt_no) !== attempt ||
          String(existing.client_order_id) !== clientOrderId ||
          !sameNumber(existing.limit_price, price) ||
          !['RESERVED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'].includes(upper(existing.order_state))) {
        return null;
      }
      return { ...existing, recoveredAfterAmbiguousRpc: true };
    }

    try {
      const response = await database.rpc('reserve_dd_options_order_attempt', args);
      const result = Array.isArray(response) ? response[0] : response;
      if (result && typeof result === 'object' &&
          result.client_order_id === clientOrderId &&
          String(result.group_id) === group &&
          upper(result.leg_role) === role &&
          upper(result.intent) === action &&
          Number(result.attempt_no) === attempt &&
          finitePositive(result.qty) &&
          finitePositive(result.limit_price)) {
        return result;
      }
      const recovered = await recoverAmbiguousAttempt().catch(() => null);
      if (recovered) return recovered;
      throw new Error('Options order-attempt reservation could not be confirmed');
    } catch (error) {
      const recovered = await recoverAmbiguousAttempt().catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
  }

  async function recordOrderAcknowledgement({
    orderAttemptId,
    exchangeOrderId = null,
    orderState,
    acknowledgedFilledQty,
    averageFillPrice = null,
    raw = {}
  } = {}) {
    if (typeof database?.rpc !== 'function') {
      throw new Error('Options order acknowledgement RPC is unavailable');
    }
    const id = Number(orderAttemptId);
    const qty = Number(acknowledgedFilledQty);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !Number.isFinite(qty) || qty < 0) {
      throw new Error('Options order acknowledgement id or filled quantity is invalid');
    }
    const response = await database.rpc('record_dd_options_order_ack', {
      p_order_attempt_id: id,
      p_exchange_order_id: exchangeOrderId === null ? null : String(exchangeOrderId),
      p_order_state: upper(orderState || 'UNKNOWN'),
      p_ack_filled_qty: qty,
      p_ack_average_fill_price: averageFillPrice === null ? null : finitePositive(averageFillPrice),
      p_raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' || Number(result.order_attempt_id) !== id) {
      throw new Error('Options order acknowledgement was not persisted');
    }
    return result;
  }

  async function recordExecutionFill({
    orderAttemptId,
    exchangeFillId,
    fillQty,
    fillPrice,
    commission = null,
    commissionCurrency = null,
    filledAt,
    raw = {}
  } = {}) {
    if (typeof database?.rpc !== 'function') {
      throw new Error('Options execution fill RPC is unavailable');
    }
    const id = Number(orderAttemptId);
    const qty = finitePositive(fillQty);
    const price = finitePositive(fillPrice);
    const fillId = String(exchangeFillId ?? '').trim();
    const timestamp = new Date(filledAt);
    if (!Number.isSafeInteger(id) || id <= 0 || !qty || !price ||
        !fillId || fillId.length > 128 || !Number.isFinite(timestamp.getTime()) ||
        (commission !== null && !Number.isFinite(Number(commission))) ||
        (commission !== null && !String(commissionCurrency ?? '').trim())) {
      throw new Error('Options exchange fill is incomplete or invalid');
    }
    const response = await database.rpc('record_dd_options_execution_fill', {
      p_order_attempt_id: id,
      p_exchange_fill_id: fillId,
      p_fill_qty: qty,
      p_fill_price: price,
      p_commission: commission === null ? null : Number(commission),
      p_commission_currency: commissionCurrency === null ? null : upper(commissionCurrency),
      p_filled_at: timestamp.toISOString(),
      p_raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' ||
        Number(result.order_attempt_id) !== id ||
        typeof result.duplicate !== 'boolean') {
      throw new Error('Options exchange fill was not persisted or returned an invalid result');
    }
    return result;
  }

  async function getActiveGroup() {
    if (typeof database?.select !== 'function') {
      throw new Error('Options execution ledger read is unavailable');
    }
    const rows = await database.select(
      'dd_options_execution_groups',
      'execution_slot=eq.DELTA_TESTNET_OPTIONS&state=not.in.(CLOSED,REJECTED,FAILED)&select=*&limit=2'
    );
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error('Options execution ledger returned an invalid active-group snapshot');
    }
    return rows[0] || null;
  }

  async function getGroupByClientGroupId(clientGroupId) {
    const id = validClientGroupId(clientGroupId);
    if (typeof database?.select !== 'function') {
      throw new Error('Options execution ledger read is unavailable');
    }
    const rows = await database.select(
      'dd_options_execution_groups',
      'client_group_id=eq.' + encodeURIComponent(id) + '&select=*&limit=2'
    );
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error('Options group idempotency lookup returned an invalid snapshot');
    }
    return rows[0] || null;
  }

  async function getGroupLegs(groupId) {
    const id = String(groupId ?? '').trim();
    if (!id || id.length > 80 || typeof database?.select !== 'function') {
      throw new Error('Options group ID or ledger reader is invalid');
    }
    const rows = await database.select(
      'dd_options_execution_legs',
      'group_id=eq.' + encodeURIComponent(id) + '&select=*&order=id.asc&limit=3'
    );
    if (!Array.isArray(rows) || rows.length > 2) {
      throw new Error('Options group leg snapshot is malformed');
    }
    return rows;
  }

  return Object.freeze({
    preview,
    reserve,
    submitReservedOrder,
    getActiveGroup,
    getGroupByClientGroupId,
    getGroupLegs,
    getOrderAttemptByClientId,
    getGroupOrders,
    getGroupFills,
    reserveOrderAttempt,
    recordOrderAcknowledgement,
    recordExecutionFill,
    assertExecutionAllowed,
    assertAccountRisk
  });
}
