export async function executeDefinedRiskSellExit({ quantity, closeShort, closeHedge } = {}) {
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty < 1 ||
      typeof closeShort !== 'function' || typeof closeHedge !== 'function') {
    throw new TypeError('Defined-risk SELL exit requires a positive quantity and both close callbacks');
  }
  const short = await closeShort();
  const fill = short?.fill ?? short;
  if (fill?.fullyFilled !== true || Number(fill.filledQty) !== qty ||
      !(Number(fill.averageFillPrice) > 0)) {
    const error = new Error('Short option buyback is not fully confirmed; protective BUY must remain open');
    error.code = 'OPTIONS_SHORT_EXIT_UNCONFIRMED';
    error.ambiguous = true;
    throw error;
  }
  // This callback is intentionally unreachable until the short buyback is
  // fully filled and its average fill price has been verified.
  return closeHedge({ shortOrder: short?.order ?? null, shortFill: fill });
}
