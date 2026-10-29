/**
 * Pure helpers for Momentum/Scalping score display. These helpers are display-only;
 * they never participate in worker stage classification or order routing.
 */
function finiteScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function detailsOf(signal) {
  let details = signal?.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  return details && typeof details === 'object' && !Array.isArray(details) ? details : {};
}

export function normalizedScoreFromView(signal) {
  const details = detailsOf(signal);
  return finiteScore(signal?.normalizedScore ?? details.normalizedScore);
}

export function originalScoreFromView(signal) {
  return finiteScore(signal?.score);
}

/** Prefer normalized scores for display; original score remains diagnostic fallback only. */
export function visibleScoreFrom(signal) {
  return normalizedScoreFromView(signal) ?? originalScoreFromView(signal);
}

export function passesScoreFilter(signal, showAll = false, threshold = 80) {
  if (showAll) return true;
  const normalizedScore = normalizedScoreFromView(signal);
  return normalizedScore !== null && normalizedScore >= threshold;
}

export function normalizedScoreTooltip(signal) {
  const normalized = normalizedScoreFromView(signal);
  const original = originalScoreFromView(signal);
  const show = value => value === null ? '—' : value.toFixed(2);
  return 'Normalized: ' + show(normalized) + ' (Original: ' + show(original) + ')';
}

export function showAllPreferenceKey(engine) {
  const key = String(engine || '').trim().toUpperCase();
  if (key !== 'MOMENTUM' && key !== 'SCALPING') {
    throw new TypeError('Show-all preference requires MOMENTUM or SCALPING');
  }
  return 'deltaScanner:showAllSignals:' + key;
}

export function readShowAllPreference(storage, key) {
  try {
    return storage?.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function writeShowAllPreference(storage, key, enabled) {
  try {
    storage?.setItem(key, enabled ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}
