import { safeNum } from './formatters.js';

export function buildPnlHistoryInsights(history = []) {
  const groups = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const key = String(row?.deployment_id ?? 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = new Map();
  for (const rows of groups.values()) {
    rows.sort((a,b) => Date.parse(a?.captured_at || 0) - Date.parse(b?.captured_at || 0));
    for (let index = 0; index < rows.length; index++) {
      const current = rows[index];
      const currentValue = safeNum(current?.reported_pnl);
      const currentTime = Date.parse(current?.captured_at || '');
      let previousNonZero = null;
      for (let i = index - 1; i >= 0; i--) {
        const value = safeNum(rows[i]?.reported_pnl);
        if (value !== null && value !== 0) {
          previousNonZero = rows[i];
          break;
        }
      }
      let sameTimeYesterday = null;
      if (Number.isFinite(currentTime)) {
        let distance = Infinity;
        for (let i = 0; i < index; i++) {
          const rowTime = Date.parse(rows[i]?.captured_at || '');
          const value = safeNum(rows[i]?.reported_pnl);
          if (!Number.isFinite(rowTime) || value === null) continue;
          const delta = Math.abs((currentTime - rowTime) - 86400000);
          if (delta <= 15 * 60 * 1000 && delta < distance) {
            distance = delta;
            sameTimeYesterday = rows[i];
          }
        }
      }
      const fallback = sameTimeYesterday ? null : previousNonZero;
      const reference = sameTimeYesterday || fallback;
      const referenceValue = reference ? safeNum(reference.reported_pnl) : null;
      const dayChange = currentValue !== null && referenceValue !== null ? currentValue - referenceValue : null;
      const trendDelta = currentValue !== null && previousNonZero
        ? currentValue - safeNum(previousNonZero.reported_pnl) : null;
      const trend = trendDelta === null ? 'UNKNOWN'
        : trendDelta > 0 ? 'UP'
          : trendDelta < 0 ? 'DOWN' : 'FLAT';
      result.set(String(current?.snapshot_id), {
        dayChange,
        dayChangeBasis: sameTimeYesterday ? 'same time yesterday' : fallback ? 'previous nonzero sample (fallback)' : 'not enough history',
        trend,
        trendDelta
      });
    }
  }
  return result;
}
