import { TradetronDeveloperApi } from '../../server/tradetron-developer-api.mjs';

// This is the only place that knows about the existing Tradetron API shape.
// The route above stays decoupled.
const developerApi = new TradetronDeveloperApi();

function normalizeSnapshot(raw) {
  // fetchSnapshot() returns deployment summaries with nested positions[]. The
  // exact shape of every upstream position row may vary by Tradetron deployment.
  const deployments = Array.isArray(raw) ? raw : Array.isArray(raw?.snapshots) ? raw.snapshots : [];
  const normalized = [];

  for (const item of deployments) {
    const rows = Array.isArray(item?.positions) ? item.positions : [item];
    for (const row of rows) {
      const symbolValue = row?.symbol ?? row?.instrument ?? row?.contract;
      let sideValue = row?.side ?? row?.position_type ?? row?.positionType;
      if (sideValue == null && row?.quantity != null && Number.isFinite(Number(row.quantity))) {
        sideValue = Number(row.quantity) < 0 ? 'SHORT' : Number(row.quantity) > 0 ? 'LONG' : null;
      }
      const sideText = String(sideValue ?? '').toUpperCase();
      const side = ['LONG', 'BUY'].includes(sideText) ? 'LONG'
        : ['SHORT', 'SELL'].includes(sideText) ? 'SHORT' : null;

      if (!symbolValue || !side) {
        // TODO: verify position side/quantity semantics against live API samples.
        console.warn('[tradetron-snapshot-adapter] Skipping position with unexpected shape');
        continue;
      }
      normalized.push({ symbol: String(symbolValue), side });
    }
  }
  return normalized;
}

export const tradetronAPI = {
  async getSnapshot() {
    const raw = await developerApi.fetchSnapshot();
    return normalizeSnapshot(raw);
  }
};

export { normalizeSnapshot };
