#!/usr/bin/env node
/**
 * Standalone, public-market-data-only Delta India Volatility Breakout backtest.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

const RES_SECONDS = { '1m': 60, '1h': 3600 };
const MAX_CANDLES_PER_REQUEST = 1900;
const REQUEST_PAUSE_MS = 35;
const DEFAULT_BASE_URL = 'https://api.india.delta.exchange';

function getArg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function numberArg(name, fallback, min = -Infinity, max = Infinity) {
  const raw = getArg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }
  return value;
}

const BASE_URL = (getArg('base-url', process.env.DELTA_BASE_URL || DEFAULT_BASE_URL)).replace(/\/+$/, '');
const MONTHS = numberArg('months', 12, 1, 36);
const TOP_N = Math.floor(numberArg('top-n', 20, 1, 100));
const MIN_TURNOVER_USD = numberArg('min-turnover-usd', 5_000_000, 0);
const MOVE_TRIGGER = numberArg('trigger-pct', 4, 0.1, 100) / 100;
const ATR_MULTIPLE = numberArg('atr-multiple', 1.5, 0.1, 20);
const TARGET_R = numberArg('target-r', 2, 0.1, 20);
const TIME_EXIT_MINUTES = Math.floor(numberArg('time-exit-minutes', 60, 1, 1440));
const COOLDOWN_MINUTES = Math.floor(numberArg('cooldown-minutes', 30, 0, 1440));
const MAX_GLOBAL_POSITIONS = Math.floor(numberArg('max-positions', 2, 1, 20));
const CONFIRM_VOL_MULTIPLE = numberArg('confirm-volume-multiple', 2, 0, 100);
const EXTENSION_ATR_MAX = numberArg('extension-atr-max', 0.5, 0, 10);
const NOTIONAL_USD = numberArg('notional-usd', 1000, 1);
const INITIAL_EQUITY_USD = numberArg('initial-equity-usd', 10_000, 1);
const SLIPPAGE_BPS = (getArg('slippage-bps', '10,20,30')).split(',').map((v) => Number(v.trim()));

if (!SLIPPAGE_BPS.length || SLIPPAGE_BPS.some((v) => !Number.isFinite(v) || v < 0 || v > 500)) {
  throw new Error('Invalid --slippage-bps. Example: --slippage-bps=10,20,30');
}

const TAKER_FEE_OVERRIDE_RAW = getArg('taker-fee-rate', process.env.DELTA_TAKER_FEE_RATE || '');
const TAKER_FEE_OVERRIDE = TAKER_FEE_OVERRIDE_RAW === '' ? null : Number(TAKER_FEE_OVERRIDE_RAW);

if (TAKER_FEE_OVERRIDE !== null && (!Number.isFinite(TAKER_FEE_OVERRIDE) || TAKER_FEE_OVERRIDE < 0 || TAKER_FEE_OVERRIDE > 0.05)) {
  throw new Error('Invalid --taker-fee-rate. Supply a decimal, e.g. 0.0005 for 0.05%.');
}

const OUT_DIR = path.resolve(getArg('out', './volatility-breakout-output'));
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const BASE_TAG = new URL(BASE_URL).hostname.replace(/[^a-z0-9.-]/gi, '_');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (v, digits = 8) => Number.isFinite(v) ? Number(v.toFixed(digits)).toString() : '';
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (values) => values.map(csvCell).join(',') + '\n';
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');

function getRange() {
  const now = new Date();
  const endMinute = Math.floor(now.getTime() / 60_000) * 60 - 60;
  const startDate = new Date(now);
  startDate.setUTCMonth(startDate.getUTCMonth() - MONTHS);
  const startMinute = Math.floor(startDate.getTime() / 60_000) * 60;
  const startHour = Math.floor(startMinute / 3600) * 3600 - (24 * 3600);
  const endHour = Math.floor(endMinute / 3600) * 3600;
  return { startMinute, endMinute, startHour, endHour };
}

const RANGE = getRange();

async function requestJson(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'DEALDOST-Research/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        const delay = Math.min(1000 * (2 ** attempt), 30_000);
        await response.arrayBuffer().catch(() => null);
        console.warn(`[retry] ${label}: HTTP ${response.status}; waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`${label}: response was not JSON`); }
      if (json?.success === false || json?.error) throw new Error(`${label}: API error`);
      await sleep(REQUEST_PAUSE_MS);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt === 7) break;
      await sleep(Math.min(500 * (2 ** attempt), 15_000));
    }
  }
  throw new Error(`${label} failed after retries: ${lastError?.message}`);
}

async function fetchProducts() {
  const products = [];
  let after = null;
  const seenCursors = new Set();
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ page_size: '100' });
    if (after) params.set('after', after);
    const data = await requestJson(`${BASE_URL}/v2/products?${params}`, 'GET /v2/products');
    const rows = Array.isArray(data.result) ? data.result : [];
    products.push(...rows);
    const next = data.meta?.after || null;
    if (!next || next === after) break;
    if (seenCursors.has(next)) throw new Error('Products pagination repeated cursor.');
    seenCursors.add(next);
    after = next;
  }
  return products.filter((p) => {
    if (p.contract_type !== 'perpetual_futures') return false;
    if (p.state === 'upcoming' || p.is_quanto === true) return false;
    if (p.notional_type && p.notional_type !== 'vanilla') return false;
    if (!p.symbol || !(Number(p.contract_value) > 0)) return false;
    const quote = p.quoting_asset?.symbol;
    if (quote && quote !== 'USD' && quote !== 'USDT') return false;
    const fee = TAKER_FEE_OVERRIDE ?? Number(p.taker_commission_rate);
    if (!Number.isFinite(fee) || fee < 0) return false;
    return true;
  });
}

function candleToRow(c) {
  const row = { t: Number(c.time), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume) };
  if (!Number.isFinite(row.t) || !Number.isFinite(row.o) || !Number.isFinite(row.h) || !Number.isFinite(row.l) || !Number.isFinite(row.c) || !Number.isFinite(row.v)) return null;
  if (row.o <= 0 || row.h <= 0 || row.l <= 0 || row.c <= 0 || row.v < 0) return null;
  return row;
}

async function loadCsvBars(filePath, maxRows) {
  const arrays = { t: new Float64Array(maxRows), o: new Float64Array(maxRows), h: new Float64Array(maxRows), l: new Float64Array(maxRows), c: new Float64Array(maxRows), v: new Float64Array(maxRows) };
  let count = 0;
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length !== 6) continue;
    const row = parts.map(Number);
    if (row.some((x) => !Number.isFinite(x))) continue;
    if (count >= maxRows) throw new Error(`Cache has more candles than expected: ${filePath}`);
    arrays.t[count] = row[0]; arrays.o[count] = row[1]; arrays.h[count] = row[2]; arrays.l[count] = row[3]; arrays.c[count] = row[4]; arrays.v[count] = row[5];
    count += 1;
  }
  const bars = {};
  for (const key of Object.keys(arrays)) bars[key] = arrays[key].subarray(0, count);
  return bars;
}

async function loadCandles(symbol, resolution, start, end) {
  const interval = RES_SECONDS[resolution];
  const maxRows = Math.floor((end - start) / interval) + 3;
  const filePath = path.join(CACHE_DIR, `${BASE_TAG}_${resolution}_${sanitize(symbol)}_${start}_${end}.csv`);
  try { await fsp.access(filePath); return await loadCsvBars(filePath, maxRows); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tempPath = `${filePath}.part`;
  const stream = createWriteStream(tempPath, { encoding: 'utf8' });
  stream.write(`#delta-candles,${resolution},${symbol},${start},${end}\n`);
  try {
    let total = 0;
    for (let chunkStart = start; chunkStart <= end; chunkStart += MAX_CANDLES_PER_REQUEST * interval) {
      const chunkEnd = Math.min(end, chunkStart + (MAX_CANDLES_PER_REQUEST - 1) * interval);
      const params = new URLSearchParams({ resolution, symbol, start: String(chunkStart), end: String(chunkEnd) });
      const data = await requestJson(`${BASE_URL}/v2/history/candles?${params}`, `candles ${symbol} ${resolution} ${chunkStart}`);
      if (!Array.isArray(data.result)) throw new Error(`Unexpected candle response`);
      const deduped = new Map();
      for (const item of data.result) {
        const row = candleToRow(item);
        if (!row || row.t < chunkStart || row.t > chunkEnd) continue;
        deduped.set(row.t, row);
      }
      const rows = [...deduped.values()].sort((a, b) => a.t - b.t);
      let text = '';
      for (const r of rows) text += `${r.t},${r.o},${r.h},${r.l},${r.c},${r.v}\n`;
      if (text && !stream.write(text)) {
        await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); });
      }
      total += rows.length;
    }
    stream.end();
    await finished(stream);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    stream.destroy();
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return await loadCsvBars(filePath, maxRows);
}

function estimatedUsdTurnover(product, candle) {
  const volume = candle.v;
  const contractValue = Number(product.contract_value);
  const unit = String(product.contract_unit_currency || '').toUpperCase();
  const multiplier = (unit === 'USD' || unit === 'USDT') ? 1 : candle.c;
  return volume * contractValue * multiplier;
}

async function buildHistoricalTopUniverse(products, hours) {
  const hourIndex = new Map(hours.map((t, i) => [t, i]));
  const turnoverRows = [];
  const turnoverBySymbol = new Map();
  console.log(`Building historical hourly Top-${TOP_N} ranking...`);
  let count = 0;
  for (const product of products) {
    count += 1;
    console.log(`[hourly ${count}/${products.length}] ${product.symbol}`);
    const bars = await loadCandles(product.symbol, '1h', RANGE.startHour, RANGE.endHour);
    const values = new Float64Array(hours.length);
    values.fill(Number.NaN);
    const hourlyVolume = new Float64Array(hours.length);
    hourlyVolume.fill(Number.NaN);
    for (let j = 0; j < bars.t.length; j += 1) {
      const idx = hourIndex.get(bars.t[j]);
      if (idx === undefined) continue;
      const turnover = estimatedUsdTurnover(product, { v: bars.v[j], c: bars.c[j] });
      if (Number.isFinite(turnover) && turnover >= 0) hourlyVolume[idx] = turnover;
    }
    for (let i = 24; i < hours.length; i += 1) {
      let sum = 0; let valid = true;
      for (let k = i - 24; k < i; k += 1) {
        if (!Number.isFinite(hourlyVolume[k])) { valid = false; break; }
        sum += hourlyVolume[k];
      }
      if (valid) values[i] = sum;
    }
    turnoverRows.push({ product, values });
    turnoverBySymbol.set(product.symbol, values);
  }
  const eligibleHours = new Map();
  const candidateSymbols = new Set();
  const universeFile = path.join(OUT_DIR, 'universe-history.csv');
  const universeStream = createWriteStream(universeFile, { encoding: 'utf8' });
  universeStream.write(csvLine(['hour_utc', 'rank', 'symbol', 'estimated_24h_turnover_usd']));
  for (let i = 0; i < hours.length; i += 1) {
    const ranked = [];
    for (const entry of turnoverRows) {
      const value = entry.values[i];
      if (Number.isFinite(value) && value >= MIN_TURNOVER_USD) ranked.push({ symbol: entry.product.symbol, turnover: value });
    }
    ranked.sort((a, b) => b.turnover - a.turnover || a.symbol.localeCompare(b.symbol));
    const top = ranked.slice(0, TOP_N);
    for (let rank = 0; rank < top.length; rank += 1) {
      const item = top[rank];
      if (!eligibleHours.has(item.symbol)) eligibleHours.set(item.symbol, new Set());
      eligibleHours.get(item.symbol).add(i);
      candidateSymbols.add(item.symbol);
      universeStream.write(csvLine([iso(hours[i]), rank + 1, item.symbol, fmt(item.turnover, 2)]));
    }
  }
  universeStream.end();
  await finished(universeStream);
  return { eligibleHours, candidateSymbols, universeFile, turnoverBySymbol };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function atr14At(bars, endIndex) {
  let sum = 0;
  for (let j = endIndex - 13; j <= endIndex; j += 1) {
    const previousClose = bars.c[j - 1];
    const tr = Math.max(bars.h[j] - bars.l[j], Math.abs(bars.h[j] - previousClose), Math.abs(bars.l[j] - previousClose));
    sum += tr;
  }
  return sum / 14;
}

function makeSignals(symbol, product, bars, eligibleHours, turnoverBySymbol, hourIndex) {
  const feeRate = TAKER_FEE_OVERRIDE ?? Number(product.taker_commission_rate);
  const signals = [];
  const n = bars.t.length;
  const firstUsable = 20;
  const lastUsable = n - 3;
  for (let i = firstUsable; i <= lastUsable; i += 1) {
    let contiguous = true;
    for (let j = i - 19; j <= i + 2; j += 1) {
      if (bars.t[j] !== bars.t[j - 1] + 60) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const move = bars.c[i] / bars.c[i - 15] - 1;
    let direction = 0;
    if (move > MOVE_TRIGGER) direction = 1;
    else if (move < -MOVE_TRIGGER) direction = -1;
    if (!direction) continue;
    const confirmIndex = i + 1;
    const confirmClose = bars.c[confirmIndex];
    const confirms = direction === 1 ? (confirmClose > bars.o[confirmIndex] && confirmClose > bars.c[i]) : (confirmClose < bars.o[confirmIndex] && confirmClose < bars.c[i]);
    if (!confirms) continue;
    const baselineMedian = median(Array.from(bars.v.subarray(i - 19, i + 1)));
    if (!(baselineMedian > 0) || bars.v[confirmIndex] < baselineMedian * CONFIRM_VOL_MULTIPLE) continue;
    const atr = atr14At(bars, confirmIndex);
    if (!(atr > 0) || !Number.isFinite(atr)) continue;
    const extension = direction * (confirmClose - bars.c[i]);
    if (extension > EXTENSION_ATR_MAX * atr) continue;
    const entryIndex = i + 2;
    const entryTs = bars.t[entryIndex];
    const hourTs = Math.floor(entryTs / 3600) * 3600;
    const idx = hourIndex.get(hourTs);
    if (idx === undefined || !eligibleHours.get(symbol)?.has(idx)) continue;
    signals.push({ symbol, direction, triggerTs: bars.t[i], confirmTs: bars.t[confirmIndex], entryTs, entryIndex, entryRaw: bars.o[entryIndex], atr, triggerMovePct: move * 100, turnoverUsd: turnoverBySymbol.get(symbol)?.[idx] ?? 0, feeRate });
  }
  return signals;
}

function simulateSignal(signal, bars, slippageBps) {
  const slip = slippageBps / 10_000;
  const direction = signal.direction;
  const entryFill = signal.entryRaw * (1 + direction * slip);
  const stopDistance = ATR_MULTIPLE * signal.atr;
  const stopPrice = entryFill - direction * stopDistance;
  const targetPrice = entryFill + direction * (stopDistance * TARGET_R);
  if (!(stopPrice > 0) || !(targetPrice > 0)) return null;
  const entryFee = NOTIONAL_USD * signal.feeRate;
  let exitIndex = -1;
  let exitReason = '';
  let exitRaw = NaN;
  const lastExitIndex = signal.entryIndex + TIME_EXIT_MINUTES - 1;
  if (lastExitIndex >= bars.t.length) return null;
  const markPoints = [];
  for (let k = signal.entryIndex; k <= lastExitIndex; k += 1) {
    const open = bars.o[k], high = bars.h[k], low = bars.l[k], close = bars.c[k];
    const stopHit = direction === 1 ? low <= stopPrice : high >= stopPrice;
    const targetHit = direction === 1 ? high >= targetPrice : low <= targetPrice;
    if (stopHit) {
      exitRaw = direction === 1 ? (open < stopPrice ? open : stopPrice) : (open > stopPrice ? open : stopPrice);
      exitIndex = k; exitReason = 'STOP';
    } else if (targetHit) {
      exitRaw = targetPrice; exitIndex = k; exitReason = 'TARGET';
    } else if (k === lastExitIndex) {
      exitRaw = close; exitIndex = k; exitReason = 'TIME';
    }
    if (exitIndex === k) {
      const exitFill = exitRaw * (1 - direction * slip);
      const grossPnl = NOTIONAL_USD * direction * (exitFill / entryFill - 1);
      const exitNotional = NOTIONAL_USD * (exitFill / entryFill);
      const exitFee = exitNotional * signal.feeRate;
      const fees = entryFee + exitFee;
      const netPnl = grossPnl - fees;
      markPoints.push({ ts: bars.t[k] + 60, pnl: netPnl });
      return { ...signal, slippageBps, entryFill, exitTs: bars.t[k] + 60, exitRaw, exitFill, exitReason, grossPnl, fees, netPnl, entryFee, markPoints };
    }
    const markExitFill = close * (1 - direction * slip);
    const markGross = NOTIONAL_USD * direction * (markExitFill / entryFill - 1);
    const markExitNotional = NOTIONAL_USD * (markExitFill / entryFill);
    const markNet = markGross - entryFee - (markExitNotional * signal.feeRate);
    markPoints.push({ ts: bars.t[k] + 60, pnl: markNet });
  }
  return null;
}

function schedulePortfolio(candidates) {
  candidates.sort((a, b) => a.entryTs - b.entryTs || b.turnoverUsd - a.turnoverUsd || a.symbol.localeCompare(b.symbol));
  const accepted = [];
  let active = [];
  const symbolCooldownUntil = new Map();
  const symbolExitAt = new Map();
  for (const candidate of candidates) {
    active = active.filter((position) => position.exitTs > candidate.entryTs);
    const sameSymbolExit = symbolExitAt.get(candidate.symbol) ?? -Infinity;
    const cooldownUntil = symbolCooldownUntil.get(candidate.symbol) ?? -Infinity;
    if (candidate.entryTs < sameSymbolExit) continue;
    if (candidate.entryTs < cooldownUntil) continue;
    if (active.length >= MAX_GLOBAL_POSITIONS) continue;
    accepted.push(candidate);
    active.push({ symbol: candidate.symbol, exitTs: candidate.exitTs });
    symbolExitAt.set(candidate.symbol, candidate.exitTs);
    symbolCooldownUntil.set(candidate.symbol, candidate.exitTs + COOLDOWN_MINUTES * 60);
  }
  return accepted;
}

function portfolioDrawdown(trades) {
  const events = new Map();
  const addEvent = (timestamp, delta) => { events.set(timestamp, (events.get(timestamp) || 0) + delta); };
  for (const trade of trades) {
    addEvent(trade.entryTs, -trade.entryFee);
    let previousContribution = -trade.entryFee;
    for (const point of trade.markPoints) {
      const delta = point.pnl - previousContribution;
      addEvent(point.ts, delta);
      previousContribution = point.pnl;
    }
  }
  const timeline = [...events.entries()].sort((a, b) => a[0] - b[0]);
  let equity = INITIAL_EQUITY_USD, peak = equity, maxDrawdown = 0, maxDrawdownPct = 0;
  for (const [, delta] of timeline) {
    equity += delta;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
  }
  return { maxDrawdown, maxDrawdownPct };
}

function summarize(slippageBps, trades) {
  const pumps = trades.filter((trade) => trade.direction === 1);
  const dumps = trades.filter((trade) => trade.direction === -1);
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const positiveNet = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const negativeNet = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const dd = portfolioDrawdown(trades);
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  return {
    slippageBps, totalTrades: trades.length, pumpTrades: pumps.length, dumpTrades: dumps.length,
    pumpWinRate: pumps.length ? pumps.filter((trade) => trade.netPnl > 0).length / pumps.length * 100 : 0,
    dumpWinRate: dumps.length ? dumps.filter((trade) => trade.netPnl > 0).length / dumps.length * 100 : 0,
    overallWinRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: negativeNet === 0 ? (positiveNet > 0 ? 'Infinity' : 0) : positiveNet / negativeNet,
    maxDrawdownUsd: dd.maxDrawdown, maxDrawdownPct: dd.maxDrawdownPct,
    netPnlUsd: sum(trades, 'netPnl'), grossPnlUsd: sum(trades, 'grossPnl'), feesUsd: sum(trades, 'fees'),
    avgNetPnlUsd: trades.length ? sum(trades, 'netPnl') / trades.length : 0,
  };
}

async function writeCsv(filePath, header, rows) {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  stream.write(csvLine(header));
  for (const row of rows) stream.write(csvLine(row));
  stream.end();
  await finished(stream);
}

async function main() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const hours = [];
  for (let timestamp = RANGE.startHour; timestamp <= RANGE.endHour; timestamp += 3600) hours.push(timestamp);
  const hourIndex = new Map(hours.map((timestamp, index) => [timestamp, index]));
  console.log('DEALDOST Volatility Breakout historical research backtest');
  const products = await fetchProducts();
  const { eligibleHours, candidateSymbols, universeFile, turnoverBySymbol } = await buildHistoricalTopUniverse(products, hours);
  const productBySymbol = new Map(products.map((product) => [product.symbol, product]));
  const symbols = [...candidateSymbols].sort();
  const scenarioCandidates = new Map(SLIPPAGE_BPS.map((bps) => [bps, []]));
  let symbolCount = 0;
  for (const symbol of symbols) {
    symbolCount += 1;
    const product = productBySymbol.get(symbol);
    if (!product) continue;
    console.log(`[minute ${symbolCount}/${symbols.length}] ${symbol}`);
    const bars = await loadCandles(symbol, '1m', RANGE.startMinute, RANGE.endMinute);
    if (bars.t.length < 100) continue;
    const signals = makeSignals(symbol, product, bars, eligibleHours, turnoverBySymbol, hourIndex);
    for (const bps of SLIPPAGE_BPS) {
      const bucket = scenarioCandidates.get(bps);
      for (const signal of signals) {
        const candidate = simulateSignal(signal, bars, bps);
        if (candidate) bucket.push(candidate);
      }
    }
  }
  const summaries = [];
  const allTradeRows = [];
  for (const bps of SLIPPAGE_BPS) {
    const candidates = scenarioCandidates.get(bps);
    const accepted = schedulePortfolio(candidates);
    const summary = summarize(bps, accepted);
    summaries.push(summary);
    console.log(`\n${bps} bps: trades=${summary.totalTrades}, win=${summary.overallWinRate.toFixed(2)}%, PF=${summary.profitFactor}, net=$${summary.netPnlUsd.toFixed(2)}, MDD=$${summary.maxDrawdownUsd.toFixed(2)} (${summary.maxDrawdownPct.toFixed(2)}%)`);
    for (const trade of accepted) {
      allTradeRows.push({
        slippageBps: bps, symbol: trade.symbol, direction: trade.direction === 1 ? 'PUMP_LONG' : 'DUMP_SHORT',
        triggerTimeUtc: iso(trade.triggerTs), confirmationTimeUtc: iso(trade.confirmTs), entryTimeUtc: iso(trade.entryTs), exitTimeUtc: iso(trade.exitTs),
        triggerMovePct: fmt(trade.triggerMovePct, 4), atr14: fmt(trade.atr, 8),
        entryRaw: fmt(trade.entryRaw, 8), entryFill: fmt(trade.entryFill, 8), exitRaw: fmt(trade.exitRaw, 8), exitFill: fmt(trade.exitFill, 8),
        exitReason: trade.exitReason, notionalUsd: fmt(NOTIONAL_USD, 2), takerFeeRate: fmt(trade.feeRate, 8),
        grossPnlUsd: fmt(trade.grossPnl, 6), feesUsd: fmt(trade.fees, 6), netPnlUsd: fmt(trade.netPnl, 6),
      });
    }
  }
  const summaryPath = path.join(OUT_DIR, 'volatility-breakout-summary.csv');
  const tradesPath = path.join(OUT_DIR, 'volatility-breakout-trades.csv');
  await writeCsv(summaryPath, ['slippage_bps','total_trades','pump_trades','dump_trades','pump_win_rate_pct','dump_win_rate_pct','overall_win_rate_pct','profit_factor','max_drawdown_usd','max_drawdown_pct','net_pnl_usd','gross_pnl_usd','fees_usd','avg_net_pnl_usd','initial_equity_usd','notional_per_trade_usd'], summaries.map((summary) => [summary.slippageBps, summary.totalTrades, summary.pumpTrades, summary.dumpTrades, fmt(summary.pumpWinRate, 4), fmt(summary.dumpWinRate, 4), fmt(summary.overallWinRate, 4), summary.profitFactor, fmt(summary.maxDrawdownUsd, 6), fmt(summary.maxDrawdownPct, 4), fmt(summary.netPnlUsd, 6), fmt(summary.grossPnlUsd, 6), fmt(summary.feesUsd, 6), fmt(summary.avgNetPnlUsd, 6), fmt(INITIAL_EQUITY_USD, 2), fmt(NOTIONAL_USD, 2)]));
  await writeCsv(tradesPath, ['slippage_bps','symbol','direction','trigger_time_utc','confirmation_time_utc','entry_time_utc','exit_time_utc','trigger_move_pct','atr14','entry_raw','entry_fill','exit_raw','exit_fill','exit_reason','notional_usd','taker_fee_rate','gross_pnl_usd','fees_usd','net_pnl_usd'], allTradeRows.map((trade) => [trade.slippageBps, trade.symbol, trade.direction, trade.triggerTimeUtc, trade.confirmationTimeUtc, trade.entryTimeUtc, trade.exitTimeUtc, trade.triggerMovePct, trade.atr14, trade.entryRaw, trade.entryFill, trade.exitRaw, trade.exitFill, trade.exitReason, trade.notionalUsd, trade.takerFeeRate, trade.grossPnlUsd, trade.feesUsd, trade.netPnlUsd]));
  const metadataPath = path.join(OUT_DIR, 'backtest-assumptions.txt');
  const metadata = ['Volatility Breakout backtest assumptions', `API base: ${BASE_URL}`, `UTC range: ${iso(RANGE.startMinute)} to ${iso(RANGE.endMinute)}`, `Product catalog count: ${products.length}`, `Historical Top-N union symbols: ${symbols.length}`, `Top N: ${TOP_N}`, `Minimum estimated rolling 24h turnover USD: ${MIN_TURNOVER_USD}`, `Trigger: absolute close-to-close 15-minute return > ${(MOVE_TRIGGER * 100).toFixed(4)}%`, `Confirmation: next 1m close direction + confirmation volume >= ${CONFIRM_VOL_MULTIPLE}x previous-20-bar median`, `Extension limit: ${EXTENSION_ATR_MAX} ATR beyond trigger close`, 'ATR: simple 14-period average true range through confirmation candle', 'Entry: next candle open, with adverse slippage', `Stop: ${ATR_MULTIPLE} ATR; target: ${TARGET_R}R; time exit: ${TIME_EXIT_MINUTES} minutes`, `Max concurrent positions: ${MAX_GLOBAL_POSITIONS}`, `Per-symbol cooldown: ${COOLDOWN_MINUTES} minutes after exit`, `Fixed USD notional per trade: ${NOTIONAL_USD}`, `Taker fee override: ${TAKER_FEE_OVERRIDE === null ? 'none; product metadata rate used' : TAKER_FEE_OVERRIDE}`, `Slippage scenarios (bps, each entry and exit): ${SLIPPAGE_BPS.join(',')}`, 'Fees: entry and exit taker fees charged on modeled notional.', 'Funding: excluded.', 'Spread/order-book depth: historical data unavailable; not verified by this backtest.', 'Product history: only currently discoverable Products API catalog; delisted-symbol survivorship bias may remain.', 'Turnover: estimate from OHLC candle volume and product contract metadata; inspect universe-history.csv.', 'Drawdown: minute-by-minute estimated liquidation-value equity including open-trade marks, fees, and slippage.', 'Execution: no authenticated endpoints and no order submission code.'].join('\n') + '\n';
  await fsp.writeFile(metadataPath, metadata, 'utf8');
  console.log('\nCompleted. Files written:');
  console.log(`  Summary: ${summaryPath}`);
  console.log(`  Trades:  ${tradesPath}`);
  console.log(`  Universe audit: ${universeFile}`);
  console.log(`  Assumptions: ${metadataPath}`);
  console.log(`  Cache: ${CACHE_DIR}`);
}

main().catch((error) => {
  console.error(`\nBACKTEST FAILED: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
