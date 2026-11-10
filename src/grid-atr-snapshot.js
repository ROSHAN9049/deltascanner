/**
 * Resolve the persisted Worker ATR snapshot for one Grid symbol.
 * Prefer the snake_case database contract, with old aliases and a draft fallback.
 */
function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}
function positiveNumber(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const raw = object?.[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}
export function resolveGridAtrSnapshot(settings, symbol, draftConfig = {}) {
  const saved = asObject(settings?.grid_symbol_configs);
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const savedKey = Object.keys(saved).find(key => key.trim().toUpperCase() === normalizedSymbol);
  const persisted = asObject(savedKey ? saved[savedKey] : null);
  const draft = asObject(draftConfig);
  const candidates = [persisted, draft];
  const statusValue = candidates.map(value => value.atr_snapshot_status ?? value.atrSnapshotStatus)
    .find(value => typeof value === 'string' && value.trim());
  const status = statusValue ? statusValue.trim().toUpperCase() : null;
  const fallback = candidates.some(value => value.atr_fallback === true || value.atrFallback === true) ||
    status === 'FALLBACK_3PCT';
  return {
    atr: positiveNumber(candidates, ['atr_14d', 'atr']),
    atrPct: positiveNumber(candidates, ['atr_pct', 'atrPct']),
    status,
    fallback,
    snapshotAt: persisted.atr_snapshot_at ?? persisted.atrSnapshotAt ??
      draft.atr_snapshot_at ?? draft.atrSnapshotAt ?? null
  };
}
