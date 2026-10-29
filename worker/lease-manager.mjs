const DEFAULT_LEASE_TTL_SECONDS = 60;
const MIN_LEASE_TTL_SECONDS = 30;
const MAX_LEASE_TTL_SECONDS = 3600;
const DEFAULT_RENEW_INTERVAL_MS = 15_000;

export function getLeaseTtlSeconds(value = process.env.WORKER_LEASE_TTL_SECONDS) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_LEASE_TTL_SECONDS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) ||
      parsed < MIN_LEASE_TTL_SECONDS ||
      parsed > MAX_LEASE_TTL_SECONDS) {
    throw new RangeError(
      `WORKER_LEASE_TTL_SECONDS must be an integer between ${MIN_LEASE_TTL_SECONDS} and ${MAX_LEASE_TTL_SECONDS}`
    );
  }
  return parsed;
}

function toError(value, fallback) {
  return value instanceof Error ? value : new Error(String(value || fallback));
}

/**
 * Own the database worker lease for the lifetime of one worker process.
 * The callbacks are injected so lease behavior can be verified without a DB.
 *
 * acquireFn/renewFn must resolve true only when the database confirms this
 * lease ID and worker ID own the lease. Any false renewal means ownership
 * has been lost and triggers onLeaseLost immediately.
 */
export function createLeaseManager({
  leaseId,
  workerId,
  ttlSeconds = getLeaseTtlSeconds(),
  renewEveryMs = DEFAULT_RENEW_INTERVAL_MS,
  acquireFn,
  renewFn = acquireFn,
  releaseFn,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
  onLeaseLost = () => {}
} = {}) {
  if (!String(leaseId || '').trim()) throw new TypeError('leaseId is required');
  if (!String(workerId || '').trim()) throw new TypeError('workerId is required');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_LEASE_TTL_SECONDS) {
    throw new RangeError('ttlSeconds must be an integer of at least 30 seconds');
  }
  if (!Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 || renewEveryMs >= ttlSeconds * 1000) {
    throw new RangeError('renewEveryMs must be positive and shorter than the lease TTL');
  }
  if (typeof acquireFn !== 'function') throw new TypeError('acquireFn is required');
  if (typeof renewFn !== 'function') throw new TypeError('renewFn is required');
  if (typeof releaseFn !== 'function') throw new TypeError('releaseFn is required');

  let leaseAcquired = false;
  let leaseHealthy = false;
  let timer = null;
  let startPromise = null;
  let renewalPromise = null;
  let stopped = false;

  const context = () => ({ leaseId, workerId, ttlSeconds });
  const stopTimer = () => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };
  const notify = async (callback, error) => {
    try {
      await callback(error, context());
    } catch (callbackError) {
      try { await onError(toError(callbackError, 'Lease callback failed'), context()); } catch {}
    }
  };

  async function renewNow() {
    if (stopped || !leaseAcquired || renewalPromise) return false;
    renewalPromise = (async () => {
      try {
        const renewed = await renewFn(context());
        if (renewed !== true) {
          leaseAcquired = false;
          leaseHealthy = false;
          stopTimer();
          await notify(onLeaseLost, new Error('Trading lease renewal denied; lease ownership was lost'));
          return false;
        }
        leaseHealthy = true;
        return true;
      } catch (value) {
        // A transient renewal error makes ownership uncertain. Block entry
        // gates until a later renewal confirms ownership again; continue
        // retrying before the database TTL expires.
        leaseHealthy = false;
        await notify(onError, toError(value, 'Trading lease renewal failed'));
        return false;
      } finally {
        renewalPromise = null;
      }
    })();
    return renewalPromise;
  }

  function startTimer() {
    if (timer !== null || stopped) return;
    timer = setIntervalFn(() => {
      void renewNow();
    }, renewEveryMs);
    timer?.unref?.();
  }

  async function start() {
    if (leaseAcquired && leaseHealthy && !stopped) return true;
    if (startPromise) return startPromise;
    stopped = false;
    startPromise = (async () => {
      const acquired = await acquireFn(context());
      if (acquired !== true) {
        leaseAcquired = false;
        leaseHealthy = false;
        throw new Error('Trading lease is held by another worker');
      }
      leaseAcquired = true;
      leaseHealthy = true;
      startTimer();
      return true;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function release() {
    stopped = true;
    stopTimer();
    const shouldRelease = leaseAcquired;
    leaseAcquired = false;
    leaseHealthy = false;
    if (!shouldRelease) return true;
    try {
      const released = await releaseFn(context());
      if (released !== true) {
        await notify(onError, new Error('Trading lease release was not confirmed'));
        return false;
      }
      return true;
    } catch (value) {
      await notify(onError, toError(value, 'Trading lease release failed'));
      return false;
    }
  }

  return Object.freeze({
    start,
    renewNow,
    release,
    get isHeld() { return leaseAcquired && leaseHealthy && !stopped; },
    get isAcquired() { return leaseAcquired; },
    get isHealthy() { return leaseHealthy && !stopped; },
    get isRunning() { return timer !== null; },
    get ttlSeconds() { return ttlSeconds; },
    get renewEveryMs() { return renewEveryMs; }
  });
}
