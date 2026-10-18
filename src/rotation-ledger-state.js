import { safeNum } from './formatters.js';

/**
 * Summarize the currently loaded Profit Rotation rows without treating
 * missing fields as zero. An empty array is a confirmed empty state only
 * when the API confirms that the complete ledger has been loaded.
 */
export function summarizeRotationLedger(todayLedger = [], ledgerComplete = false) {
  const rows = Array.isArray(todayLedger) ? todayLedger : [];
  const hasEvents = rows.length > 0;
  const releasedValues = rows.map(row => safeNum(row?.released));
  const retainedValues = rows.map(row => safeNum(row?.retained));
  const releasedComplete = hasEvents
    ? ledgerComplete === true && releasedValues.every(value => value !== null)
    : null;
  const retainedComplete = hasEvents
    ? ledgerComplete === true && retainedValues.every(value => value !== null)
    : null;

  return {
    hasEvents,
    emptyConfirmed: ledgerComplete === true && !hasEvents,
    releasedValues,
    retainedValues,
    releasedComplete,
    retainedComplete,
    released: releasedComplete === true
      ? releasedValues.reduce((sum, value) => sum + value, 0)
      : null,
    retained: retainedComplete === true
      ? retainedValues.reduce((sum, value) => sum + value, 0)
      : null
  };
}
