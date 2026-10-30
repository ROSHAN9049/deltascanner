import { planDeltaOptionsLifecycle } from './delta-options-lifecycle.mjs';

const upper = value => String(value ?? '').trim().toUpperCase();
const text = value => String(value ?? '').trim();

export function createDeltaOptionsExpirySupervisor({
  manager,
  getQuotes = async () => ({}),
  now = () => Date.now(),
  minutesBeforeExpiry = 30,
  maxQuoteAgeMs = 5_000
} = {}) {
  if (!manager || typeof manager.getActiveGroup !== 'function' ||
      typeof manager.getGroupLegs !== 'function' ||
      typeof manager.getGroupOrders !== 'function') {
    throw new Error('Options expiry supervisor requires durable group, leg and order readers');
  }
  if (typeof getQuotes !== 'function') {
    throw new Error('Options expiry supervisor requires a quote reader');
  }
  if (!Number.isSafeInteger(minutesBeforeExpiry) ||
      minutesBeforeExpiry < 5 || minutesBeforeExpiry > 240 ||
      !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs < 250 || maxQuoteAgeMs > 60_000) {
    throw new Error('Options expiry supervisor timing configuration is invalid');
  }

  let inFlight = null;

  async function reviewOnceInternal() {
    const group = await manager.getActiveGroup();
    if (!group) return { status: 'NO_ACTIVE_GROUP', executionEnabled: false, submitted: false };

    const expiryMs = Date.parse(String(group.expiry_at ?? ''));
    const clock = Number(now());
    if (!Number.isFinite(expiryMs) || expiryMs <= 0 ||
        !Number.isFinite(clock) || clock <= 0) {
      return {
        status: 'RECONCILIATION_REQUIRED',
        executionEnabled: false,
        submitted: false,
        reason: 'Persisted Options expiry or supervisor clock is invalid'
      };
    }

    const deadline = expiryMs - minutesBeforeExpiry * 60_000;
    const deadlineIso = new Date(deadline).toISOString();
    if (clock < deadline) {
      return {
        status: 'NOT_DUE',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso
      };
    }

    const state = upper(group.state);
    if (state === 'RECONCILIATION_REQUIRED') {
      return {
        status: 'RECONCILIATION_REQUIRED',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        reason: 'Data/order reconciliation lock must be resolved before expiry exit planning'
      };
    }
    if (state !== 'EXIT_REQUIRED') {
      return {
        status: 'EXIT_REQUIRED_STATE_NOT_MARKED',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        reason: 'The restart supervisor must durably mark the group EXIT_REQUIRED before planning its exit'
      };
    }

    let legs;
    let orders;
    try {
      [legs, orders] = await Promise.all([
        manager.getGroupLegs(group.id),
        manager.getGroupOrders(group.id)
      ]);
    } catch (error) {
      return {
        status: 'RECONCILIATION_REQUIRED',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        reason: 'Durable Options exit snapshot is unavailable: ' + text(error?.message || error).slice(0, 200)
      };
    }

    if (!Array.isArray(legs) || !Array.isArray(orders)) {
      return {
        status: 'RECONCILIATION_REQUIRED',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        reason: 'Durable Options exit snapshot is malformed'
      };
    }

    let quotes;
    try {
      quotes = await getQuotes({ group, legs });
      if (!quotes || typeof quotes !== 'object' || Array.isArray(quotes)) {
        throw new Error('Quote reader returned a malformed Options quote map');
      }
    } catch (error) {
      return {
        status: 'EXIT_WAITING_FOR_FRESH_QUOTE',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        reason: text(error?.message || error).slice(0, 200)
      };
    }

    const plan = planDeltaOptionsLifecycle({
      group,
      legs,
      orders,
      quotes,
      entrySignalReady: false,
      expiryExitDue: true,
      now: clock,
      maxQuoteAgeMs
    });

    if (plan.status === 'ACTION_READY') {
      return {
        status: 'EXIT_ACTION_READY',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso,
        action: plan.nextAction
      };
    }
    if (plan.status === 'CLOSED') {
      return {
        status: 'EXIT_ALREADY_FLAT',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso,
        reason: plan.reason
      };
    }
    if (plan.status === 'ORDER_PENDING') {
      return {
        status: 'EXIT_ORDER_PENDING',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso,
        reason: plan.reason
      };
    }
    if (plan.status === 'WAITING_FOR_FRESH_QUOTE' || plan.status === 'QUOTE_NOT_TICK_ALIGNED') {
      return {
        status: 'EXIT_WAITING_FOR_FRESH_QUOTE',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso,
        reason: plan.reason
      };
    }
    if (plan.status === 'RECONCILIATION_REQUIRED') {
      return {
        status: 'RECONCILIATION_REQUIRED',
        executionEnabled: false,
        submitted: false,
        groupId: group.id,
        expiryDeadline: deadlineIso,
        reason: plan.reason
      };
    }
    return {
      status: 'EXIT_REVIEW_REQUIRED',
      executionEnabled: false,
      submitted: false,
      groupId: group.id,
      expiryDeadline: deadlineIso,
      lifecycleStatus: plan.status,
      reason: plan.reason || 'Lifecycle planner did not produce a safe exit action'
    };
  }

  async function reviewOnce() {
    if (inFlight) return inFlight;
    inFlight = reviewOnceInternal().catch(error => ({
      status: 'SUPERVISOR_UNAVAILABLE',
      executionEnabled: false,
      submitted: false,
      reason: text(error?.message || error).slice(0, 240)
    })).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({ reviewOnce });
}
