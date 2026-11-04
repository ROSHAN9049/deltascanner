const GREEK_FIELDS = Object.freeze(['delta', 'gamma', 'theta', 'vega', 'rho']);

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function finiteOptionNumber(value) {
  if (value === null || value === undefined ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value !== 'string' && typeof value !== 'number')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Delta's option ticker carries Greeks under greeks.delta. Some adapters and
 * cached responses may serialize that object; keep parsing strict and never
 * synthesize a value when Delta omits it.
 */
export function optionGreeksFromTicker(ticker = {}) {
  const nested = asObject(ticker?.greeks);
  const alternate = asObject(ticker?.option_greeks ?? ticker?.greeks_data);
  return Object.freeze({
    delta: finiteOptionNumber(nested.delta ?? alternate.delta ?? ticker?.delta),
    gamma: finiteOptionNumber(nested.gamma ?? alternate.gamma ?? ticker?.gamma),
    theta: finiteOptionNumber(nested.theta ?? alternate.theta ?? ticker?.theta),
    vega: finiteOptionNumber(nested.vega ?? alternate.vega ?? ticker?.vega),
    rho: finiteOptionNumber(nested.rho ?? alternate.rho ?? ticker?.rho)
  });
}

export function hasOptionDelta(ticker) {
  return optionGreeksFromTicker(ticker).delta !== null;
}

/**
 * Bulk option-chain tickers are preferred. When Delta omits Greeks on a bulk
 * row, hydrate only the already-bounded scan selection from GET /tickers/{symbol}.
 * Keep the Testnet product identity from the bulk/catalogue join; the detail
 * endpoint is used only as a source of Greek fields.
 */
export async function hydrateOptionTickersWithGreeks(rows, fetchTicker, concurrency = 4) {
  if (typeof fetchTicker !== 'function') {
    throw new TypeError('Option Greeks hydration requires a ticker fetch function');
  }
  const output = Array.isArray(rows) ? rows.slice() : [];
  const pending = output
    .map((row, index) => ({ row, index, symbol: String(row?.symbol || '').trim().toUpperCase() }))
    .filter(item => item.symbol && !hasOptionDelta(item.row));

  const errors = [];
  let cursor = 0;
  let enriched = 0;
  const requestedConcurrency = Number.isFinite(Number(concurrency))
    ? Math.floor(Number(concurrency)) : 4;
  const workerCount = Math.min(pending.length, Math.max(1, Math.min(8, requestedConcurrency || 4)));

  async function hydrateNext() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        const response = await fetchTicker(item.symbol);
        let detail = response?.result && typeof response.result === 'object'
          ? response.result
          : response;
        if (Array.isArray(detail)) {
          detail = detail.find(row => String(row?.symbol || '').trim().toUpperCase() === item.symbol);
        }
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
          throw new Error('Single-contract ticker response is not an object');
        }
        const returnedSymbol = String(detail.symbol || '').trim().toUpperCase();
        if (returnedSymbol && returnedSymbol !== item.symbol) {
          throw new Error('Single-contract ticker symbol did not match the requested contract');
        }

        const fresh = optionGreeksFromTicker(detail);
        const previous = optionGreeksFromTicker(item.row);
        const merged = {};
        for (const field of GREEK_FIELDS) {
          const value = fresh[field] ?? previous[field];
          if (value !== null) merged[field] = value;
        }
        output[item.index] = { ...item.row, greeks: merged };
        if (fresh.delta !== null) enriched += 1;
      } catch (error) {
        errors.push({
          symbol: item.symbol,
          message: String(error?.message || error).slice(0, 180)
        });
      }
    }
  }

  if (workerCount) {
    await Promise.all(Array.from({ length: workerCount }, () => hydrateNext()));
  }

  return {
    rows: output,
    attempted: pending.length,
    enriched,
    missingSymbols: output
      .filter(row => !hasOptionDelta(row))
      .map(row => String(row?.symbol || '').trim().toUpperCase())
      .filter(Boolean),
    errors
  };
}
