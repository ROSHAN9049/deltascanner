#!/usr/bin/env node
/**
 * Import Tradetron "Download Data" CSV into the display-only API-derived ledger.
 *
 * Dry-run is the default. Pass --apply to mutate dd_api_derived_trades.
 * Never writes dd_trades, fills, positions, or risk state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const clean = value => String(value ?? '').trim();

export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(value => clean(value) !== '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field.');
  if (field.length || row.length) {
    row.push(field);
    if (row.some(value => clean(value) !== '')) records.push(row);
  }
  if (!records.length) return [];
  const headers = records.shift().map((header, index) => normalizeHeader(header) || ('column_' + (index + 1)));
  return records.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export function normalizeHeader(value) {
  return clean(value).toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function fieldValue(row, aliases) {
  for (const alias of aliases) {
    if (Object.hasOwn(row, alias) && clean(row[alias]) !== '') return row[alias];
  }
  return null;
}
function numberOrNull(value) {
  if (value === null || value === undefined || clean(value) === '') return null;
  const text = clean(value).replace(/[,$₹\s]/g, '');
  const valueNumber = Number(text);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}
function timestampOrNull(value) {
  if (value === null || value === undefined || clean(value) === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function normalizeSide(value) {
  const side = clean(value).toUpperCase();
  if (['LONG','BUY'].includes(side)) return 'LONG';
  if (['SHORT','SELL'].includes(side)) return 'SHORT';
  return null;
}
function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeTradetronCsvRow(raw, { deploymentIdOverride = null, detectedAt = new Date().toISOString() } = {}) {
  const deploymentValue = fieldValue(raw, ['deployment_id','deploymentid','deployed_strategy_id']);
  const deploymentId = clean(deploymentValue ?? deploymentIdOverride);
  const symbolRaw = fieldValue(raw, ['symbol','tradingsymbol','trading_symbol','instrument','instrument_symbol','contract_symbol','scrip','coin']);
  const symbol = clean(symbolRaw).toUpperCase().replace(/^DIN[-_]?/i, '').split(/[ _]/)[0];
  const side = normalizeSide(fieldValue(raw, ['side','position_side','direction','trade_side']));
  const qty = numberOrNull(fieldValue(raw, ['qty_closed','closed_quantity','quantity','qty','net_quantity','position_qty','size']));
  const entryPrice = numberOrNull(fieldValue(raw, ['entry_price','entryprice','average_entry_price','avg_entry_price','average_price','avg_price','entry']));
  const exitPrice = numberOrNull(fieldValue(raw, ['exit_price','exitprice','average_exit_price','avg_exit_price','close_price','exit']));
  const ltp = numberOrNull(fieldValue(raw, ['ltp','last_traded_price','mark_price','current_price','last_price']));
  const rawPnl = numberOrNull(fieldValue(raw, ['raw_pnl','realized_pnl','net_pnl','pnl','profit_loss','profitloss','profit']));
  const openedAt = timestampOrNull(fieldValue(raw, ['opened_at','openedat','entry_time','entry_datetime','open_time','open_datetime','entry_timestamp']));
  const closedAt = timestampOrNull(fieldValue(raw, ['closed_at','closedat','exit_time','exit_datetime','close_time','close_datetime','exit_timestamp','closed_time']));
  if (!deploymentId) return { ok: false, reason: 'missing deployment_id (supply --deployment-id=...)', raw };
  if (!symbol) return { ok: false, reason: 'missing/unsupported symbol field', raw };
  if (rawPnl === null) return { ok: false, reason: 'missing explicit P&L field', raw };
  const quality = entryPrice !== null && exitPrice !== null ? 'FULL' : side ? 'PARTIAL' : 'MINIMAL';
  const canonical = {
    deploymentId, symbol, side, qty, entryPrice, exitPrice, openedAt, closedAt, rawPnl, ltp
  };
  return {
    ok: true,
    row: {
      id: randomUUID(),
      deployment_id: deploymentId,
      symbol,
      side,
      qty_closed: qty === null ? null : Math.abs(qty),
      last_known_ltp: ltp,
      raw_pnl: rawPnl,
      raw_api_data: {
        source: 'tradetron_download_data_csv',
        raw_row: raw,
        imported_at: detectedAt,
        warning: 'CSV source fields are preserved as supplied; no fee, side, or price was inferred.'
      },
      derived_from: 'csv_import',
      data_quality: quality,
      transition_from_snapshot_id: null,
      detected_at: detectedAt,
      closed_at_estimated: closedAt,
      entry_price: entryPrice,
      exit_price: exitPrice,
      opened_at: openedAt,
      closed_at: closedAt,
      is_verified: false,
      source_fingerprint: canonicalHash(canonical)
    }
  };
}

function printUsage() {
  console.log('Usage: node scripts/import-tradetron-csv.mjs <file.csv> [--deployment-id=ID] [--apply]');
  console.log('Default is dry-run. --apply writes only dd_api_derived_trades; never dd_trades or risk state.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || !args.some(value => !value.startsWith('--'))) {
    printUsage();
    if (args.includes('--help') || args.includes('-h')) return;
    process.exitCode = 2;
    return;
  }
  const filePath = path.resolve(args.find(value => !value.startsWith('--')));
  const deploymentArg = args.find(value => value.startsWith('--deployment-id='));
  const deploymentIdOverride = deploymentArg ? deploymentArg.slice('--deployment-id='.length).trim() : null;
  const apply = args.includes('--apply');
  const csvText = await readFile(filePath, 'utf8');
  const parsedRows = parseCsv(csvText);
  if (!parsedRows.length) throw new Error('CSV is empty or contains no data rows.');
  const detectedAt = new Date().toISOString();
  const accepted = [];
  const rejected = [];
  for (const raw of parsedRows) {
    const result = normalizeTradetronCsvRow(raw, { deploymentIdOverride, detectedAt });
    if (result.ok) accepted.push(result.row);
    else rejected.push({ reason: result.reason });
  }
  console.log('Tradetron CSV import ' + (apply ? 'APPLY' : 'DRY-RUN'));
  console.log('File rows: ' + parsedRows.length + ' · accepted: ' + accepted.length + ' · skipped: ' + rejected.length);
  console.log('Quality counts: ' + JSON.stringify(accepted.reduce((counts, row) => {
    counts[row.data_quality] = (counts[row.data_quality] || 0) + 1;
    return counts;
  }, {})));
  if (rejected.length) {
    console.log('Skipped reasons: ' + JSON.stringify(rejected.reduce((counts, row) => {
      counts[row.reason] = (counts[row.reason] || 0) + 1;
      return counts;
    }, {})));
  }
  if (!apply) {
    console.log('Dry-run only. Review the CSV header mapping, then re-run with --apply to import.');
    return;
  }
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required for --apply; its value will not be printed.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });
  let inserted = 0;
  let enriched = 0;
  let duplicates = 0;
  try {
    for (const trade of accepted) {
      // Enrich only when one API-derived row has an explicit estimated/actual close
      // time within 15 minutes of the CSV close time. Ambiguous matches create a
      // separate CSV row instead of guessing which API observation is the same trade.
      let match = null;
      if (trade.closed_at) {
        const candidates = await pool.query(
          `SELECT id, COALESCE(closed_at, closed_at_estimated) AS close_time
             FROM public.dd_api_derived_trades
            WHERE deployment_id = $1 AND symbol = $2
              AND derived_from <> 'csv_import' AND is_verified = false
              AND COALESCE(closed_at, closed_at_estimated) BETWEEN $3::timestamptz - INTERVAL '15 minutes'
                                                              AND $3::timestamptz + INTERVAL '15 minutes'`,
          [trade.deployment_id, trade.symbol, trade.closed_at]
        );
        if (candidates.rows.length === 1) match = candidates.rows[0];
      }
      if (match) {
        const update = await pool.query(
          `UPDATE public.dd_api_derived_trades
              SET side = COALESCE($1, side),
                  qty_closed = COALESCE($2, qty_closed),
                  last_known_ltp = COALESCE($3, last_known_ltp),
                  raw_pnl = COALESCE($4, raw_pnl),
                  entry_price = COALESCE($5, entry_price),
                  exit_price = COALESCE($6, exit_price),
                  opened_at = COALESCE($7, opened_at),
                  closed_at = COALESCE($8, closed_at),
                  closed_at_estimated = COALESCE(closed_at_estimated, $8),
                  data_quality = CASE
                    WHEN COALESCE($5, entry_price) IS NOT NULL AND COALESCE($6, exit_price) IS NOT NULL THEN 'FULL'
                    WHEN COALESCE($1, side) IS NOT NULL THEN 'PARTIAL'
                    ELSE 'MINIMAL' END,
                  raw_api_data = raw_api_data || $9::jsonb,
                  is_verified = false
            WHERE id = $10 AND is_verified = false
            RETURNING id`,
          [trade.side,trade.qty_closed,trade.last_known_ltp,trade.raw_pnl,trade.entry_price,trade.exit_price,
            trade.opened_at,trade.closed_at,JSON.stringify({csv_enrichment:trade.raw_api_data, csv_source_fingerprint:trade.source_fingerprint}),match.id]
        );
        if (update.rowCount) enriched++;
        else duplicates++;
        continue;
      }
      const result = await pool.query(
        `INSERT INTO public.dd_api_derived_trades
          (id,deployment_id,symbol,side,qty_closed,last_known_ltp,raw_pnl,raw_api_data,derived_from,data_quality,
           transition_from_snapshot_id,detected_at,closed_at_estimated,entry_price,exit_price,opened_at,closed_at,is_verified,source_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18)
         ON CONFLICT (source_fingerprint) DO NOTHING
         RETURNING id`,
        [trade.id,trade.deployment_id,trade.symbol,trade.side,trade.qty_closed,trade.last_known_ltp,trade.raw_pnl,
          JSON.stringify(trade.raw_api_data),trade.derived_from,trade.data_quality,trade.transition_from_snapshot_id,
          trade.detected_at,trade.closed_at_estimated,trade.entry_price,trade.exit_price,trade.opened_at,trade.closed_at,
          trade.source_fingerprint]
      );
      if (result.rowCount) inserted++; else duplicates++;
    }
  } finally {
    await pool.end();
  }
  console.log('Imported: ' + inserted + ' · enriched: ' + enriched + ' · duplicate/no-op: ' + duplicates);
  console.log('All records remain is_verified=false and are isolated from dd_trades / execution / risk logic.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('Tradetron CSV import failed: ' + String(error?.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED DATABASE URL]').slice(0, 500));
    process.exitCode = 1;
  });
}
