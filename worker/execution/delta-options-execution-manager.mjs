import crypto from 'node:crypto';
import * as defaultDatabase from '../../server/db.js';
import {
  isOptionsExecutionAllowed,
  OPTIONS_EXECUTION_LOCK_REASON
} from '../options-execution-lock.mjs';
import {
  makeOptionsClientOrderId,
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
    net_credit_usd: mode === 'OPTIONS_SELL' ? finitePositive(netCreditUsd) : null,
    raw: {
      source: 'delta_options_execution_manager',
      environment: 'testnet',
      entry_sequence: plan.entrySequence,
      max_loss_usd: maxLoss,
      risk_budget_usd: riskBudget,
      reserved_margin_usd: reserve,
      net_credit_usd: mode === 'OPTIONS_SELL' ? Number(netCreditUsd) : null
    }
  };

  return { group, legs, plan };
}

export function createDeltaOptionsExecutionManager({
  database = defaultDatabase,
  executor,
  now = () => Date.now(),
  createGroupId = () => crypto.randomUUID()
} = {}) {
  function assertExecutionAllowed() {
    if (!isOptionsExecutionAllowed()) {
      throw new Error(OPTIONS_EXECUTION_LOCK_REASON);
    }
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
    const response = await database.rpc('reserve_dd_options_execution_group', {
      p_group: payload.group,
      p_legs: payload.legs
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' || !result.group_id ||
        result.client_group_id !== payload.group.client_group_id ||
        result.state !== 'RESERVED' ||
        Number(result.leg_count) !== payload.legs.length) {
      // Never submit an exchange order when the DB reservation response is
      // absent, malformed, or refers to a different client group.
      throw new Error('Atomic Options group reservation could not be confirmed; no order may be submitted');
    }
    return { ...result, payload };
  }

  async function submitReservedOrder(order) {
    // The locked executor independently repeats this guard before network I/O.
    assertExecutionAllowed();
    if (typeof executor?.placeOptionOrder !== 'function') {
      throw new Error('Dedicated Delta Testnet Options executor is unavailable');
    }
    return executor.placeOptionOrder(order);
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

  return Object.freeze({
    preview,
    reserve,
    submitReservedOrder,
    getActiveGroup,
    assertExecutionAllowed
  });
}
