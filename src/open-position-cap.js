export const DEFAULT_MAX_OPEN_POSITIONS = 3;

export function normalizeMaxOpenPositions(value, fallback = DEFAULT_MAX_OPEN_POSITIONS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export function countOpenPositionSymbols(positions) {
  const occupied = new Set();
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = String(position?.symbol || '').trim().toUpperCase();
    const quantity = Number(position?.qty ?? position?.quantity ?? position?.size ?? 0);
    if (!symbol || !Number.isFinite(quantity) || Math.abs(quantity) <= 0) continue;
    occupied.add(symbol);
  }
  return occupied.size;
}

export function isGlobalOpenPositionCapReached(positions, maxOpenPositions) {
  const cap = normalizeMaxOpenPositions(maxOpenPositions);
  return countOpenPositionSymbols(positions) >= cap;
}

/**
 * Returns a blocker for a new symbol when the global open-position cap is full.
 * Existing-symbol duplicates are handled by the separate duplicate-symbol gate.
 * Position snapshots and unexpired signal reservations must be supplied together.
 */
export function globalOpenPositionCapBlocker(positions, symbol, maxOpenPositions) {
  const target = String(symbol || '').trim().toUpperCase();
  if (!target) return 'Global open-position cap blocked: signal symbol unavailable';

  const occupied = new Set();
  for (const position of Array.isArray(positions) ? positions : []) {
    const currentSymbol = String(position?.symbol || '').trim().toUpperCase();
    const quantity = Number(position?.qty ?? position?.quantity ?? position?.size ?? 0);
    if (!currentSymbol || !Number.isFinite(quantity) || Math.abs(quantity) <= 0) continue;
    occupied.add(currentSymbol);
  }

  // Duplicate-symbol blocking provides the more precise reason for this case.
  if (occupied.has(target)) return '';

  const cap = normalizeMaxOpenPositions(maxOpenPositions);
  if (occupied.size >= cap) {
    return 'Global open-position limit reached (' + occupied.size + '/' + cap + '); new Tradetron entry blocked';
  }
  return '';
}
