import * as defaultDatabase from '../../server/db.js';
import { createDeltaOptionsExecutionManager } from './delta-options-execution-manager.mjs';
import { createDeltaOptionsOrderLedger } from './delta-options-order-ledger.mjs';
import { resolveOptionExpiryExitDeadline } from './delta-options-execution-policy.mjs';

const ACTIVE_ORDER_STATES = new Set([
  'RESERVED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN',
  'RECONCILIATION_REQUIRED'
]);
const VALID_ROLES = new Set(['LONG_PREMIUM', 'PROTECTIVE_WING', 'SHORT_OPTION']);
const EPSILON = 1e-8;
const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const groupStateTerminal = state => ['CLOSED', 'REJECTED', 'FAILED'].includes(upper(state));

function asMicroseconds(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const micros = Math.floor(value * 1000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function orderWindowStart(order, group, nowMs) {
  const candidates = [
    Date.parse(String(order?.created_at ?? '')),
    Date.parse(String(order?.updated_at ?? '')),
    Date.parse(String(group?.created_at ?? ''))
  ].filter(value => Number.isFinite(value) && value > 0);
  const source = candidates.length ? Math.min(...candidates) : nowMs;
  // Backfill a small amount to cover server/client timestamp skew.
  return Math.max(1, source - 60 * 60 * 1000);
}

function normalizeExchangeOrder(order) {
  return {
    id: text(order?.id ?? order?.order_id),
    clientOrderId: text(order?.client_order_id ?? order?.clientOrderId),
    productId: finite(order?.product_id ?? order?.productId),
    symbol: upper(order?.product_symbol ?? order?.symbol),
    side: upper(order?.side),
    size: finite(order?.size),
    unfilledSize: finite(order?.unfilled_size),
    state: upper(order?.state)
  };
}

function normalizeExchangePosition(position) {
  return {
    productId: finite(position?.product_id ?? position?.productId),
    symbol: upper(position?.symbol ?? position?.product_symbol),
    side: upper(position?.side),
    qty: finite(position?.qty ?? position?.size)
  };
}

function sameQty(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPSILON;
}

function summarizeLegs(legs) {
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) {
    return { valid: false, reason: 'Options group must contain one or two persisted legs' };
  }
  const roles = legs.map(row => upper(row?.leg_role));
  if (roles.some(role => !VALID_ROLES.has(role)) || new Set(roles).size !== roles.length) {
    return { valid: false, reason: 'Options group contains an invalid or duplicated leg role' };
  }
  const groupLeg = legs[0];
  if (legs.length === 1 && upper(groupLeg?.leg_role) !== 'LONG_PREMIUM') {
    return { valid: false, reason: 'A single-leg Options group must be LONG_PREMIUM' };
  }
  if (legs.length === 2 &&
      !(roles.includes('PROTECTIVE_WING') && roles.includes('SHORT_OPTION'))) {
    return { valid: false, reason: 'A two-leg Options group must contain one protective wing and one short option' };
  }
  for (const leg of legs) {
    const requested = finite(leg?.requested_qty);
    const filled = finite(leg?.filled_qty);
    const exited = finite(leg?.exit_filled_qty);
    if (!Number.isSafeInteger(Number(leg?.product_id)) ||
        !upper(leg?.symbol) ||
        !['BUY', 'SELL'].includes(upper(leg?.side)) ||
        requested === null || requested <= 0 ||
        filled === null || filled < 0 ||
        exited === null || exited < 0 ||
        exited - filled > EPSILON ||
        filled - requested > EPSILON) {
      return { valid: false, reason: 'Options leg has malformed product, direction or fill accounting' };
    }
  }
  return { valid: true };
}

function expectedPositionMap(legs) {
  const map = new Map();
  for (const leg of legs) {
    const symbol = upper(leg.symbol);
    const previous = map.get(symbol);
    if (previous) throw new Error('Options execution group repeats a contract symbol');
    const qty = Math.max(0, Number(leg.filled_qty) - Number(leg.exit_filled_qty));
    map.set(symbol, {
      productId: Number(leg.product_id),
      symbol,
      side: upper(leg.side),
      qty
    });
  }
  return map;
}

function compareExchangePositions(legs, positions) {
  if (!Array.isArray(positions)) {
    return { matched: false, reason: 'Delta Options position snapshot is not an array' };
  }
  const expected = expectedPositionMap(legs);
  const actual = new Map();
  for (const raw of positions) {
    const position = normalizeExchangePosition(raw);
    if (!position.symbol || !Number.isSafeInteger(position.productId) ||
        position.qty === null || position.qty < 0 ||
        !['BUY', 'SELL'].includes(position.side)) {
      return { matched: false, reason: 'Delta Options position snapshot contains a malformed row' };
    }
    const previous = actual.get(position.symbol);
    if (previous) {
      return { matched: false, reason: 'Delta Options position snapshot contains duplicate contract rows' };
    }
    actual.set(position.symbol, position);
  }

  for (const [symbol, wanted] of expected) {
    const actualRow = actual.get(symbol);
    const actualQty = actualRow?.qty ?? 0;
    if (actualRow &&
        (actualRow.productId !== wanted.productId || actualRow.side !== wanted.side)) {
      return { matched: false, reason: 'Exchange Options position product or side differs from the persisted leg', symbol };
    }
    if (!sameQty(actualQty, wanted.qty)) {
      return {
        matched: false,
        reason: 'Exchange Options position quantity differs from persisted fill ledger',
        symbol,
        expectedQty: wanted.qty,
        actualQty
      };
    }
    actual.delete(symbol);
  }
  if (actual.size > 0) {
    const orphan = [...actual.values()][0];
    return {
      matched: false,
      reason: 'Exchange reports an Options position that is not owned by the active execution group',
      symbol: orphan.symbol,
      actualQty: orphan.qty
    };
  }
  return { matched: true };
}

function findLedgerOrder(exchangeOrder, ledgerOrders) {
  const normalized = normalizeExchangeOrder(exchangeOrder);
  return ledgerOrders.find(row =>
    (normalized.clientOrderId && String(row.client_order_id) === normalized.clientOrderId) ||
    (normalized.id && String(row.exchange_order_id || '') === normalized.id)
  ) || null;
}

export function createDeltaOptionsSupervisor({
  database = defaultDatabase,
  manager = createDeltaOptionsExecutionManager({ database }),
  executor,
  ledger = createDeltaOptionsOrderLedger({ database }),
  now = () => Date.now(),
  minutesBeforeExpiry = 30,
  fillPageSize = 50
} = {}) {
  if (!executor) throw new Error('Delta Options supervisor requires a dedicated Testnet executor');
  if (!Number.isSafeInteger(minutesBeforeExpiry) || minutesBeforeExpiry < 5 || minutesBeforeExpiry > 240) {
    throw new Error('Options expiry exit lead time must be an integer from 5 to 240 minutes');
  }
  if (!Number.isSafeInteger(fillPageSize) || fillPageSize < 1 || fillPageSize > 50) {
    throw new Error('Options fill reconciliation page bounds are invalid');
  }

  let inFlight = null;

  async function markGroupReconciliationRequired(group, code, detail, raw = {}) {
    if (!group?.id || typeof database?.rpc !== 'function') {
      throw new Error('Options group cannot be durably reconciliation-locked');
    }
    const errorCode = upper(code);
    if (!/^[A-Z0-9_]{4,64}$/.test(errorCode)) {
      throw new Error('Options reconciliation error code is invalid');
    }
    const response = await database.rpc('mark_dd_options_group_reconciliation_required', {
      p_group_id: String(group.id),
      p_error_code: errorCode,
      p_error_detail: text(detail).slice(0, 300),
      p_raw: {
        source: 'delta_options_restart_supervisor',
        observed_at: new Date(now()).toISOString(),
        ...raw
      }
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' ||
        String(result.group_id) !== String(group.id) ||
        upper(result.state) !== 'RECONCILIATION_REQUIRED') {
      throw new Error('Options group reconciliation lock was not confirmed by the database');
    }
    return result;
  }

  async function markGroupExpiryExitRequired(group, expiryMs, openQty) {
    if (!group?.id || typeof database?.rpc !== 'function') {
      throw new Error('Options group cannot be durably marked EXIT_REQUIRED');
    }
    const response = await database.rpc('mark_dd_options_group_expiry_exit_required', {
      p_group_id: String(group.id),
      p_expiry_at: new Date(expiryMs).toISOString(),
      p_minutes_before_expiry: minutesBeforeExpiry,
      p_open_qty: openQty,
      p_raw: {
        source: 'delta_options_restart_supervisor',
        observed_at: new Date(now()).toISOString(),
        expiry_deadline: new Date(expiryMs - minutesBeforeExpiry * 60 * 1000).toISOString()
      }
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' ||
        String(result.group_id) !== String(group.id) ||
        upper(result.state) !== 'EXIT_REQUIRED' ||
        !sameQty(result.open_qty, openQty)) {
      throw new Error('Options expiry exit requirement was not confirmed by the database');
    }
    return result;
  }

  async function closeGroupAfterExpiryIfFlat(group, expiryMs) {
    const response = await database.rpc('close_dd_options_group_after_expiry_if_flat', {
      p_group_id: String(group.id),
      p_expiry_at: new Date(expiryMs).toISOString(),
      p_raw: {
        source: 'delta_options_restart_supervisor',
        observed_at: new Date(now()).toISOString()
      }
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (!result || typeof result !== 'object' ||
        String(result.group_id) !== String(group.id) ||
        upper(result.state) !== 'CLOSED' ||
        !sameQty(result.open_qty, 0)) {
      throw new Error('Flat Options expiry close was not confirmed by the database');
    }
    return result;
  }

  async function getExchangeSnapshot() {
    if (typeof executor.assertConfigured === 'function') executor.assertConfigured();
    const [positions, openOrders] = await Promise.all([
      executor.getOpenOptionPositions(),
      executor.getOpenOptionOrders()
    ]);
    if (!Array.isArray(positions) || !Array.isArray(openOrders)) {
      throw new Error('Delta Testnet Options exchange snapshot is malformed');
    }
    return { positions, openOrders };
  }

  async function recoverOrderAttempts(group, orderRows) {
    const output = [];
    for (const original of orderRows) {
      let row = await ledger.getAttempt(original.client_order_id);
      if (!row) {
        return {
          ok: false,
          reason: 'A persisted Options order attempt cannot be read back by its client order ID',
          clientOrderId: original.client_order_id
        };
      }

      let exchangeOrderId = text(row.exchange_order_id);
      if (!exchangeOrderId &&
          ['RESERVED', 'SUBMITTED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(upper(row.order_state))) {
        try {
          const acknowledgement = await executor.getOptionOrderByClientId(row.client_order_id);
          row = await ledger.recordAcknowledgement(row.client_order_id, acknowledgement);
          exchangeOrderId = text(row.exchange_order_id);
        } catch (error) {
          // A missing lookup is not proof that an earlier POST did not reach the
          // exchange. Keep the client ID locked; never place a replacement order.
          if (upper(row.order_state) === 'RESERVED') {
            await ledger.markSubmissionUnknown(row.client_order_id, error);
          }
          return {
            ok: false,
            reason: 'Options client-order lookup is unresolved; blind resubmission is prohibited',
            clientOrderId: row.client_order_id
          };
        }
      }

      if (!exchangeOrderId) {
        if (ACTIVE_ORDER_STATES.has(upper(row.order_state)) || upper(row.order_state) === 'FILLED') {
          return {
            ok: false,
            reason: 'An active Options order attempt has no verified exchange order ID',
            clientOrderId: row.client_order_id
          };
        }
        output.push(row);
        continue;
      }

      const createdAt = Date.parse(String(row.created_at || group.created_at || ''));
      const start = asMicroseconds(orderWindowStart(
        { ...row, created_at: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null },
        group,
        now()
      ));
      const end = asMicroseconds(now() + 60_000);
      if (!start || !end || end <= start) {
        return {
          ok: false,
          reason: 'Options fill reconciliation time window is invalid',
          clientOrderId: row.client_order_id
        };
      }

      const reconciled = await ledger.reconcileFills(row.client_order_id, {
        executor,
        startTimeUs: start,
        endTimeUs: end,
        pageSize: fillPageSize
      });
      if (!reconciled || upper(reconciled.order_state) === 'RECONCILIATION_REQUIRED') {
        return {
          ok: false,
          reason: 'Options exchange fills could not be reconciled to the durable ledger',
          clientOrderId: row.client_order_id
        };
      }
      output.push(reconciled);
    }
    return { ok: true, orders: output };
  }

  async function runOnceInternal() {
    const group = await manager.getActiveGroup();
    let exchange;
    try {
      exchange = await getExchangeSnapshot();
    } catch (error) {
      if (group && !groupStateTerminal(group.state)) {
        const locked = await markGroupReconciliationRequired(
          group,
          'OPTIONS_EXCHANGE_SNAPSHOT_UNAVAILABLE',
          'Private Delta Testnet Options positions/orders could not be read after restart',
          { snapshot_error: text(error?.message || error).slice(0, 240) }
        );
        return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
      }
      throw error;
    }
    if (!group) {
      if (exchange.positions.length || exchange.openOrders.length) {
        return {
          status: 'ORPHAN_EXCHANGE_EXPOSURE',
          executionEnabled: false,
          reason: 'Exchange Options positions or orders exist without an active durable execution group',
          positionCount: exchange.positions.length,
          openOrderCount: exchange.openOrders.length
        };
      }
      return {
        status: 'NO_ACTIVE_GROUP',
        executionEnabled: false,
        positionCount: 0,
        openOrderCount: 0
      };
    }
    if (groupStateTerminal(group.state)) {
      return {
        status: 'INVALID_ACTIVE_GROUP_SNAPSHOT',
        executionEnabled: false,
        reason: 'The database returned a terminal Options group as active'
      };
    }

    let legs;
    let orderRows;
    try {
      [legs, orderRows] = await Promise.all([
        manager.getGroupLegs(group.id),
        manager.getGroupOrders(group.id)
      ]);
    } catch (error) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_LEDGER_SNAPSHOT_UNAVAILABLE',
        'Durable Options group legs/orders could not be read after restart',
        { ledger_error: text(error?.message || error).slice(0, 240) }
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }
    const legCheck = summarizeLegs(legs);
    if (!legCheck.valid) {
      const locked = await markGroupReconciliationRequired(
        group, 'OPTIONS_LEG_SNAPSHOT_INVALID', legCheck.reason
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked, reason: legCheck.reason };
    }
    if (!Array.isArray(orderRows) || orderRows.length > 100) {
      const locked = await markGroupReconciliationRequired(
        group, 'OPTIONS_ORDER_SNAPSHOT_INVALID', 'Options group order snapshot is malformed or truncated'
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }

    let orderRecovery;
    try {
      orderRecovery = await recoverOrderAttempts(group, orderRows);
    } catch (error) {
      orderRecovery = {
        ok: false,
        reason: 'Options order or fill reconciliation raised an error: ' + text(error?.message || error).slice(0, 200),
        clientOrderId: null
      };
    }
    if (!orderRecovery.ok) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_ORDER_RECOVERY_UNRESOLVED',
        orderRecovery.reason,
        { client_order_id: orderRecovery.clientOrderId || null }
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked, reason: orderRecovery.reason };
    }

    let refreshedOrders;
    let refreshedLegs;
    try {
      [refreshedOrders, refreshedLegs] = await Promise.all([
        manager.getGroupOrders(group.id),
        manager.getGroupLegs(group.id)
      ]);
    } catch (error) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_LEDGER_REFRESH_UNAVAILABLE',
        'Updated Options order/leg snapshot could not be read after fill recovery',
        { ledger_error: text(error?.message || error).slice(0, 240) }
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }
    if (!Array.isArray(refreshedOrders) || !Array.isArray(refreshedLegs)) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_LEDGER_REFRESH_INVALID',
        'Updated Options order/leg snapshot is malformed after fill recovery'
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }
    for (const exchangeOrder of exchange.openOrders) {
      const normalizedOrder = normalizeExchangeOrder(exchangeOrder);
      const ledgerOrder = findLedgerOrder(normalizedOrder, refreshedOrders);
      const hasExchangeIdentity = Boolean(normalizedOrder.clientOrderId || normalizedOrder.id);
      if (!ledgerOrder ||
          !hasExchangeIdentity ||
          (normalizedOrder.clientOrderId &&
            String(ledgerOrder.client_order_id) !== normalizedOrder.clientOrderId) ||
          (normalizedOrder.id &&
            String(ledgerOrder.exchange_order_id || '') !== normalizedOrder.id) ||
          Number(ledgerOrder.product_id) !== normalizedOrder.productId ||
          upper(ledgerOrder.symbol) !== normalizedOrder.symbol ||
          upper(ledgerOrder.side) !== normalizedOrder.side ||
          !sameQty(ledgerOrder.requested_qty, normalizedOrder.size)) {
        const locked = await markGroupReconciliationRequired(
          group,
          'OPTIONS_UNTRACKED_EXCHANGE_ORDER',
          'An open Delta Testnet Options order does not exactly match the active group order ledger',
          {
            exchange_order_id: normalizedOrder.id || null,
            client_order_id: normalizedOrder.clientOrderId || null,
            symbol: normalizedOrder.symbol || null
          }
        );
        return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
      }
    }

    let positions;
    try {
      positions = compareExchangePositions(refreshedLegs, exchange.positions);
    } catch (error) {
      positions = {
        matched: false,
        reason: 'Options position comparison failed: ' + text(error?.message || error).slice(0, 200)
      };
    }
    if (!positions.matched) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_POSITION_RECONCILIATION_FAILED',
        positions.reason,
        positions
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked, reason: positions.reason };
    }

    const openQty = refreshedLegs.reduce((sum, leg) =>
      sum + Math.max(0, Number(leg.filled_qty) - Number(leg.exit_filled_qty)), 0);
    const unresolvedOrders = [];
    const pendingOrders = [];
    for (const row of refreshedOrders) {
      const state = upper(row.order_state);
      if (state === 'RECONCILIATION_REQUIRED' || state === 'UNKNOWN' || state === 'RESERVED') {
        unresolvedOrders.push(row);
        continue;
      }
      if (!['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED'].includes(state)) continue;
      const activeOnExchange = exchange.openOrders.some(raw => {
        const normalized = normalizeExchangeOrder(raw);
        const found = findLedgerOrder(normalized, [row]);
        return Boolean(found &&
          (!normalized.clientOrderId || String(row.client_order_id) === normalized.clientOrderId) &&
          (!normalized.id || String(row.exchange_order_id || '') === normalized.id));
      });
      if (!activeOnExchange) unresolvedOrders.push(row);
      else pendingOrders.push(row);
    }
    if (unresolvedOrders.length) {
      const first = unresolvedOrders[0];
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_ORDER_TERMINALITY_UNVERIFIED',
        'A persisted Options order is still ambiguous or does not appear in the active exchange order snapshot',
        {
          client_order_id: first.client_order_id || null,
          exchange_order_id: first.exchange_order_id || null,
          order_state: upper(first.order_state)
        }
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }
    if (pendingOrders.length) {
      return {
        status: 'ORDER_PENDING',
        executionEnabled: false,
        groupId: group.id,
        pendingOrderCount: pendingOrders.length,
        positionCount: exchange.positions.length,
        openOrderCount: exchange.openOrders.length,
        openQty
      };
    }

    const expiryMs = Date.parse(String(group.expiry_at || ''));
    if (!Number.isFinite(expiryMs) || expiryMs <= 0) {
      const locked = await markGroupReconciliationRequired(
        group,
        'OPTIONS_EXPIRY_INVALID',
        'Options group expiry timestamp is invalid'
      );
      return { status: 'RECONCILIATION_REQUIRED', executionEnabled: false, group: locked };
    }
    const deadline = expiryMs - minutesBeforeExpiry * 60 * 1000;
    const deadlinePassed = now() >= deadline ||
      resolveOptionExpiryExitDeadline(expiryMs, {
        now: now(),
        minutesBeforeExpiry
      }) === null;
    if (deadlinePassed) {
      // Mark the separate expiry state for both open and already-flat groups.
      // This avoids misusing the integrity lock and allows a flat group to be
      // finalized only after the exchange snapshot and terminal orders agree.
      const marked = await markGroupExpiryExitRequired(group, expiryMs, openQty);
      if (openQty <= EPSILON) {
        const closed = await closeGroupAfterExpiryIfFlat({ ...group, state: 'EXIT_REQUIRED' }, expiryMs);
        return {
          status: 'EXPIRY_EXIT_FLAT',
          executionEnabled: false,
          group: closed,
          groupId: group.id,
          openQty: 0,
          expiryDeadline: new Date(deadline).toISOString()
        };
      }
      return {
        status: 'EXPIRY_EXIT_REQUIRED',
        executionEnabled: false,
        group: marked,
        groupId: group.id,
        openQty,
        expiryDeadline: new Date(deadline).toISOString()
      };
    }

    return {
      status: upper(group.state) === 'RECONCILIATION_REQUIRED'
        ? 'RECONCILIATION_REQUIRED'
        : 'RECONCILED',
      executionEnabled: false,
      groupId: group.id,
      groupState: upper(group.state),
      positionCount: exchange.positions.length,
      openOrderCount: exchange.openOrders.length,
      openQty,
      expiryDeadline: new Date(deadline).toISOString(),
      expiryExitDue: upper(group.state) === 'EXIT_REQUIRED' || now() >= deadline
    };
  }

  async function reconcileOnce() {
    if (inFlight) return inFlight;
    inFlight = runOnceInternal().catch(error => ({
      status: 'SUPERVISOR_UNAVAILABLE',
      executionEnabled: false,
      reason: text(error?.message || error).slice(0, 300)
    })).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({ reconcileOnce });
}
