const GRID_STATE_KEY = 'grid_state';

function normalizeGridState(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function auditValue(key, value) {
  if (value === undefined) return null;
  if (key === GRID_STATE_KEY) {
    const state = normalizeGridState(value);
    return {
      status: state.status ?? null,
      openPositions: Array.isArray(state.positions) ? state.positions.length : 0,
      pausedReason: state.pausedReason ?? null,
      wasEnabled: state.wasEnabled === true
    };
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Build a structured, secret-free audit row for a successful settings update.
 * Actor is the authenticated channel because this app does not maintain
 * individual user identities for shared ENGINE_SECRET sessions.
 */
export function buildSettingsAuditEntry({ actor, previous = {}, patch = {}, persisted = {}, at } = {}) {
  const changes = [];
  for (const key of Object.keys(patch)) {
    const from = auditValue(key, previous[key]);
    const to = auditValue(key, Object.prototype.hasOwnProperty.call(persisted, key) ? persisted[key] : patch[key]);
    if (!sameValue(from, to)) changes.push({ setting: key, from, to });
  }
  if (!changes.length) return null;
  return {
    level: 'INFO',
    message: 'Settings changed',
    data: {
      event: 'SETTINGS_CHANGED',
      source: 'api/engine/toggle',
      actor: String(actor || 'unknown-authenticated-actor'),
      at: at || new Date().toISOString(),
      changes
    }
  };
}
