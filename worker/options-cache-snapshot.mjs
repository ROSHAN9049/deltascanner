/**
 * Helpers for complete, bounded Options diagnostic snapshots. These are cache
 * bookkeeping only; they never create or authorize an exchange order route.
 */

export function countOptionProductsByUnderlying(productMap, underlyings = []) {
  const requested = Array.isArray(underlyings)
    ? underlyings.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const counts = Object.fromEntries(requested.map(asset => [asset, 0]));
  const symbols = productMap instanceof Map
    ? [...productMap.keys()]
    : Array.isArray(productMap) ? productMap : [];

  for (const raw of symbols) {
    const symbol = String(raw || '').toUpperCase();
    const match = symbol.match(/^[CP]-([A-Z0-9]+)-/);
    if (match && Object.hasOwn(counts, match[1])) counts[match[1]] += 1;
  }
  return counts;
}

/**
 * Replace, rather than append to, the small current-candidate cache. An empty
 * result is still a complete scan snapshot and must remove candidates retained
 * from a previous scan (for example, an underlying that is no longer supported).
 */
export async function replaceOptionCacheSnapshot(rows, {
  remove,
  upsertMany
} = {}) {
  if (typeof remove !== 'function' || typeof upsertMany !== 'function') {
    throw new TypeError('Options cache replacement requires remove and upsertMany database functions');
  }

  const snapshotRows = Array.isArray(rows)
    ? rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    : [];

  // Clear first: if the subsequent upsert fails, the cache stays empty instead
  // of exposing a partially refreshed or mixed-age candidate batch.
  await remove('dd_option_cache', 'cache_key=not.is.null');
  if (snapshotRows.length) {
    await upsertMany('dd_option_cache', snapshotRows, 'cache_key');
  }

  return { rowCount: snapshotRows.length };
}
