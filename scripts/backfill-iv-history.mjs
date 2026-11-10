import { CONFIG } from '../server/config.js';
import { DeltaAdapter } from '../worker/delta-adapter.mjs';
import { extractCurrentImpliedVolatility } from '../worker/options-iv-rank.mjs';
import { buildIvHistoryGroup } from '../worker/options-iv-grouping.mjs';
import * as db from '../server/db.js';

const UNDERLYINGS = ['BTC', 'ETH'];
const SOURCE = 'delta_public_option_ticker_snapshot_seed';

function underlyingFromSymbol(symbol) {
  const match = String(symbol || '').toUpperCase().match(/^[CP]-(BTC|ETH)-/);
  return match?.[1] || null;
}

async function main() {
  if (!['TESTNET', 'SIGNAL_ONLY'].includes(CONFIG.environment)) {
    throw new Error('Unsupported scanner environment; refusing to seed IV history');
  }

  const now = new Date();
  const observedAt = now.toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  // Prevent accidental repeated runs from creating multiple same-day seed snapshots.
  const existing = await db.select(
    'dd_iv_history',
    'source=eq.' + SOURCE + '&observed_at=gte.' + encodeURIComponent(dayStart) + '&select=id&limit=1'
  );
  if (Array.isArray(existing) && existing.length) {
    throw new Error('A snapshot seed already exists for this UTC day; refusing duplicate insertion');
  }

  const adapter = new DeltaAdapter();
  const rows = [];
  const diagnostics = {};

  for (const underlying of UNDERLYINGS) {
    const tickers = await adapter.optionTickers(underlying);
    const contracts = Array.isArray(tickers) ? tickers : [];
    let eligible = 0;
    let withIv = 0;

    for (const ticker of contracts) {
      const symbol = String(ticker?.symbol || '').toUpperCase();
      if (underlyingFromSymbol(symbol) !== underlying) continue;
      eligible += 1;
      const iv = extractCurrentImpliedVolatility(ticker);
      if (iv === null) continue;
      withIv += 1;
      const group = buildIvHistoryGroup(ticker, underlying, now.getTime());
      if (!group) continue;
      rows.push({
        symbol,
        ...group,
        iv_current: iv,
        observed_at: observedAt,
        source: SOURCE
      });
    }
    diagnostics[underlying] = { contracts: eligible, withCurrentIv: withIv };
  }

  if (!rows.length) {
    throw new Error('No BTC/ETH option ticker returned a usable current IV; no database rows inserted');
  }

  await db.insertMany('dd_iv_history', rows);
  console.log(JSON.stringify({
    status: 'SNAPSHOT_SEEDED',
    observedAt,
    source: SOURCE,
    insertedRows: rows.length,
    diagnostics,
    warning: 'This is one current snapshot, not historical backfill. It does not satisfy the seven-day IV history gate.'
  }, null, 2));
}

main().catch(error => {
  console.error('IV snapshot seed failed:', String(error?.message || error).slice(0, 500));
  process.exitCode = 1;
});
