const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Sum only exchange close P&L rows explicitly marked as verified.
 * A count mismatch, missing value, or REST-only reconciliation keeps the
 * daily total unavailable instead of mixing verified and unverified rows.
 */
export function summarizeVerifiedDeltaClosedPnl(rows, expectedCount) {
  const source = Array.isArray(rows) ? rows : [];
  const count = numberOrNull(expectedCount);
  const values = source.map(row =>
    row?.realized_pnl_verified === true
      ? numberOrNull(row?.realized_pnl)
      : null
  );
  const complete = count !== null &&
    Number.isSafeInteger(count) &&
    count >= 0 &&
    count === source.length &&
    values.every(value => value !== null);

  return {
    complete,
    pnl: complete ? values.reduce((sum, value) => sum + value, 0) : null
  };
}
