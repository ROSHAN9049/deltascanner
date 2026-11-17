export function createTtlSingleFlightCache({ ttlMs = 15_000, now = Date.now } = {}) {
  const entries = new Map();

  return {
    async get(key, loader) {
      if (typeof loader !== 'function') throw new TypeError('Cache loader must be a function');
      const cacheKey = String(key);
      const current = entries.get(cacheKey);
      const timestamp = Number(now());

      if (current?.hasValue === true && timestamp - current.cachedAt < ttlMs) {
        return current.value;
      }
      if (current?.inFlight) return current.inFlight;

      const inFlight = Promise.resolve().then(loader);
      entries.set(cacheKey, {
        hasValue: current?.hasValue === true,
        value: current?.value,
        cachedAt: current?.cachedAt ?? 0,
        inFlight
      });

      try {
        const value = await inFlight;
        entries.set(cacheKey, { hasValue: true, value, cachedAt: Number(now()), inFlight: null });
        return value;
      } catch (error) {
        if (entries.get(cacheKey)?.inFlight === inFlight) {
          if (current?.hasValue === true) entries.set(cacheKey, current);
          else entries.delete(cacheKey);
        }
        throw error;
      }
    },

    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(String(key));
    }
  };
}
