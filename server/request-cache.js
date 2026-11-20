export function createTtlSingleFlightCache({ ttlMs = 15_000, now = Date.now } = {}) {
  const entries = new Map();

  return {
    async get(key, loader, { staleIfErrorMs = 0 } = {}) {
      if (typeof loader !== 'function') throw new TypeError('Cache loader must be a function');
      const cacheKey = String(key);
      const current = entries.get(cacheKey);
      const timestamp = Number(now());
      const maxStaleAge = Number(staleIfErrorMs);

      if (current?.hasValue === true && timestamp - current.cachedAt >= 0 &&
          timestamp - current.cachedAt < ttlMs) {
        return current.value;
      }
      if (current?.inFlight) return current.inFlight;

      const inFlight = Promise.resolve().then(loader).then(value => {
        entries.set(cacheKey, { hasValue: true, value, cachedAt: Number(now()), inFlight: null });
        return value;
      }).catch(error => {
        if (entries.get(cacheKey)?.inFlight === inFlight) {
          if (current?.hasValue === true) entries.set(cacheKey, { ...current, inFlight: null });
          else entries.delete(cacheKey);
        }

        const failedAt = Number(now());
        const staleAge = failedAt - Number(current?.cachedAt);
        if (current?.hasValue === true && Number.isFinite(maxStaleAge) && maxStaleAge > 0 &&
            Number.isFinite(staleAge) && staleAge >= 0 && staleAge <= maxStaleAge) {
          return current.value;
        }
        throw error;
      });

      entries.set(cacheKey, {
        hasValue: current?.hasValue === true,
        value: current?.value,
        cachedAt: current?.cachedAt ?? 0,
        inFlight
      });
      return inFlight;
    },

    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(String(key));
    }
  };
}
