#!/usr/bin/env node
/**
 * Isolated walk-forward backtest for the pre-breakout detector.
 *
 * Default: 90 days of 15m Delta India candles for BTCUSD, ETHUSD and SOLUSD.
 * Override PRE_BREAKOUT_BACKTEST_RESOLUTION=1h to run the same engine on 1h.
 * No database writes, worker integration, or order submission are performed.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { normalizeCandle } from '../worker/candle-normalization.mjs';
import { detectPreBreakout } from '../worker/leading-indicators/pre-breakout.mjs';

const DEFAULT_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD'];
const DAY_SECONDS = 86400;
const CANDLE_SECONDS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600 });
const PAGE_CANDLES = 1900; // Stay below Delta's documented 2,000-candle response cap.
const FEE_PER_SIDE = 0.001; // Requested fee model: 0.1% of entry and exit price per side.
const MAX_FEE_RISK_RATIO = 0.15;
const ENTRY_SLIPPAGE = 0.001;
const RISK_PER_TRADE = 0.01;
const API_BASE = String(process.env.DELTA_REST_BASE || 'https://api.india.delta.exchange').replace(/\/+$/, '');
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedResolution(value = process.env.PRE_BREAKOUT_BACKTEST_RESOLUTION || '15m') {
  const resolution = String(value).trim().toLowerCase();
  if (!Object.hasOwn(CANDLE_SECONDS, resolution)) {
    throw new RangeError('Unsupported resolution: ' + resolution + '. Use 1m, 5m, 15m or 1h.');
  }
  return resolution;
}

function safeCandle(row, resolution) {
  const result = normalizeCandle(row, resolution);
  return result.ok ? result.candle : null;
}

async function fetchPage(symbol, resolution, start, end) {
  const url = new URL(API_BASE + '/v2/history/candles');
  url.searchParams.set('resolution', resolution);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));

  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'DealDost-PreBreakout-Backtest/1.0' }
      });
      const body = await response.text();
      let payload;
      try {
        payload = body ? JSON.parse(body) : null;
      } catch {
        throw new Error('Delta returned non-JSON response for ' + symbol + ' (' + response.status + ')');
      }

      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(Math.min(8000, 500 * (2 ** attempt)));
        continue;
      }
      if (!response.ok || !payload || payload.success === false) {
        const detail = payload?.error?.message || payload?.error?.code || ('HTTP_' + response.status);
        throw new Error('Delta candle request failed for ' + symbol + ': ' + detail);
      }
      if (!Array.isArray(payload.result)) {
        throw new Error('Delta candle response for ' + symbol + ' did not contain result[]');
      }
      return payload.result;
    } catch (error) {
      lastError = error;
      if (attempt < 4 && /fetch failed|network|timeout|ECONNRESET|ENOTFOUND/i.test(String(error?.message || error))) {
        await sleep(Math.min(8000, 500 * (2 ** attempt)));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('Delta candle request retry exhausted for ' + symbol);
}

export async function fetchHistoricalCandles(symbol, startSeconds, endSeconds, resolution = '15m') {
  const intervalSeconds = CANDLE_SECONDS[selectedResolution(resolution)];
  const byTime = new Map();
  let requestCount = 0;

  for (let pageStart = startSeconds; pageStart < endSeconds;) {
    const pageEnd = Math.min(endSeconds, pageStart + PAGE_CANDLES * intervalSeconds);
    const rows = await fetchPage(symbol, resolution, pageStart, pageEnd);
    requestCount++;

    for (const raw of rows) {
      const candle = safeCandle(raw, resolution);
      if (!candle) continue;
      if (candle.time >= startSeconds && candle.time < endSeconds) {
        byTime.set(candle.time, candle);
      }
    }

    pageStart = pageEnd;
    await sleep(120);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, requestCount };
}

function adverseEntryPrice(open, direction) {
  return direction === 'UP'
    ? open * (1 + ENTRY_SLIPPAGE)
    : open * (1 - ENTRY_SLIPPAGE);
}

/**
 * Before taking a candidate, estimate round-trip fees using entry and the
 * stop-loss as the conservative exit-price estimate. Actual realized fees below
 * use the actual simulated exit. A rejected candidate increments skippedByFees.
 */
export function passesFeeToRiskFilter(entryPrice, stopLoss, exitPriceEstimate = stopLoss) {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const totalFees = (entryPrice * FEE_PER_SIDE) + (exitPriceEstimate * FEE_PER_SIDE);
  return {
    passes: Number.isFinite(stopDistance) && stopDistance > 0 &&
      Number.isFinite(totalFees) && totalFees <= (stopDistance * MAX_FEE_RISK_RATIO),
    stopDistance,
    totalFees,
    feeRiskRatio: stopDistance > 0 ? totalFees / stopDistance : Infinity
  };
}

/**
 * Simulate sequential, non-overlapping trades. Each signal sees only candles
 * before entryIndex; entry is the following candle's open plus adverse slippage.
 * ATR risk levels are re-anchored to actual fill. If SL and TP1 occur in one
 * candle, SL is assumed first. End-of-data open trades are not scored.
 */
export function simulateSymbol(symbol, candles) {
  const trades = [];
  let openAtEnd = 0;
  let skippedByFees = 0;
  let index = 100;

  while (index < candles.length - 1) {
    const history = candles.slice(Math.max(0, index - 100), index);
    const setup = detectPreBreakout(symbol, history);
    if (!setup.signal) {
      index++;
      continue;
    }

    const signal = setup.signal;
    const entryCandle = candles[index];
    const directionSign = signal.direction === 'UP' ? 1 : -1;
    const rawOpen = Number(entryCandle.open);
    if (!Number.isFinite(rawOpen) || rawOpen <= 0) {
      index++;
      continue;
    }

    const entryPrice = adverseEntryPrice(rawOpen, signal.direction);
    const atrValue = Math.abs(signal.tp1 - signal.entryPrice) / 3;
    if (!Number.isFinite(atrValue) || atrValue <= 0) {
      index++;
      continue;
    }

    const stopLoss = entryPrice - directionSign * 2 * atrValue;
    const tp1 = entryPrice + directionSign * 3 * atrValue;
    const tp2 = entryPrice + directionSign * 5 * atrValue;
    const riskPerUnit = Math.abs(entryPrice - stopLoss);

    // exit is unknowable before entry, so use the stop as a conservative
    // estimate. This applies the requested exact fee formula before admission.
    const feeGate = passesFeeToRiskFilter(entryPrice, stopLoss, stopLoss);
    if (!feeGate.passes) {
      skippedByFees++;
      index++;
      continue;
    }

    let exitIndex = -1;
    let exitPrice = null;
    let exitReason = null;

    for (let forward = index; forward < candles.length; forward++) {
      const candle = candles[forward];
      const high = Number(candle.high);
      const low = Number(candle.low);
      const stopHit = signal.direction === 'UP' ? low <= stopLoss : high >= stopLoss;
      const targetHit = signal.direction === 'UP' ? high >= tp1 : low <= tp1;

      if (stopHit && targetHit) {
        exitIndex = forward;
        exitPrice = stopLoss;
        exitReason = 'SL';
        break;
      }
      if (stopHit) {
        exitIndex = forward;
        exitPrice = stopLoss;
        exitReason = 'SL';
        break;
      }
      if (targetHit) {
        exitIndex = forward;
        exitPrice = tp1;
        exitReason = 'TP1';
        break;
      }
    }

    if (exitIndex < 0) {
      openAtEnd++;
      break;
    }

    const grossPnl = directionSign * (exitPrice - entryPrice);
    const fees = (entryPrice * FEE_PER_SIDE) + (exitPrice * FEE_PER_SIDE);
    const netPnl = grossPnl - fees;
    const rMultiple = netPnl / riskPerUnit;

    trades.push({
      symbol,
      direction: signal.direction,
      signalTime: history.at(-1)?.time ?? null,
      entryTime: entryCandle.time,
      exitTime: candles[exitIndex].time,
      signalEntryPrice: signal.entryPrice,
      entryPrice,
      exitPrice,
      stopLoss,
      tp1,
      tp2,
      exitReason,
      result: exitReason,
      grossPnl,
      fees,
      feeRiskRatio: fees / riskPerUnit,
      netPnl,
      rMultiple
    });

    index = exitIndex + 1;
  }

  return { trades, openAtEnd, skippedByFees };
}

export function calculateBacktestMetrics(inputTrades) {
  const trades = [...inputTrades].sort((a, b) =>
    Number(a.exitTime ?? a.entryTime ?? 0) - Number(b.exitTime ?? b.entryTime ?? 0));
  const totalTrades = trades.length;
  const wins = trades.filter(trade => trade.result === 'TP1');
  const losses = trades.filter(trade => trade.result === 'SL');
  const winRate = totalTrades ? wins.length / totalTrades : 0;
  const lossRate = totalTrades ? losses.length / totalTrades : 0;
  const avgWinR = wins.length
    ? wins.reduce((sum, trade) => sum + Number(trade.rMultiple), 0) / wins.length
    : 0;
  const avgLossR = losses.length
    ? losses.reduce((sum, trade) => sum + Math.abs(Number(trade.rMultiple)), 0) / losses.length
    : 0;
  const expectancyR = (winRate * avgWinR) - (lossRate * avgLossR);

  const positiveR = trades.reduce((sum, trade) => sum + Math.max(0, Number(trade.rMultiple) || 0), 0);
  const negativeR = trades.reduce((sum, trade) => sum + Math.abs(Math.min(0, Number(trade.rMultiple) || 0)), 0);
  const profitFactor = negativeR > 0 ? positiveR / negativeR : positiveR > 0 ? Infinity : 0;

  let equity = 100;
  let peak = equity;
  let maxDrawdownPct = 0;
  let currentConsecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of trades) {
    const rMultiple = Number(trade.rMultiple) || 0;
    equity *= Math.max(0, 1 + (RISK_PER_TRADE * rMultiple));
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);

    if (trade.result === 'SL' || rMultiple < 0) {
      currentConsecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentConsecutiveLosses);
    } else {
      currentConsecutiveLosses = 0;
    }
  }

  const gates = {
    minimumTrades: totalTrades >= 100,
    winRate: (winRate * 100) > 40,
    expectancy: expectancyR > 0.3,
    profitFactor: profitFactor >= 1.3,
    maxDrawdown: maxDrawdownPct <= 25,
    maxConsecutiveLosses: maxConsecutiveLosses <= 6
  };
  return {
    totalTrades,
    targetWins: wins.length,
    stopLosses: losses.length,
    winRatePct: winRate * 100,
    avgWinR,
    avgLossR,
    expectancyR,
    profitFactor,
    maxConsecutiveLosses,
    maxDrawdownPct,
    gates,
    gatesPassed: Object.values(gates).every(Boolean)
  };
}

function printSummary(symbolRows, metrics, dayCount, resolution, openAtEnd, skippedByFees) {
  const line = (cells, widths) => '| ' + cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ') + ' |';
  const headers = ['Symbol', 'Candles', 'Requests', 'Trades', 'Fee skips', 'Open at end'];
  const widths = [10, 9, 8, 8, 9, 12];
  const divider = '|-' + widths.map(width => '-'.repeat(width)).join('-|-') + '-|';
  console.error('Pre-breakout walk-forward backtest — ' + dayCount + ' requested days · ' + resolution);
  console.error(line(headers, widths));
  console.error(divider);
  for (const row of symbolRows) {
    console.error(line([
      row.symbol, row.candleCount, row.requestCount, row.tradeCount,
      row.skippedByFees, row.openAtEnd
    ], widths));
  }
  console.error(divider);
  console.error('Completed trades: ' + metrics.totalTrades +
    ' | TP1 hits: ' + metrics.targetWins +
    ' | SL: ' + metrics.stopLosses +
    ' | skipped by fee filter: ' + skippedByFees +
    ' | unresolved at data end: ' + openAtEnd);
  console.error('Win rate: ' + metrics.winRatePct.toFixed(2) + '%' +
    ' | Avg win: ' + metrics.avgWinR.toFixed(3) + 'R' +
    ' | Avg loss: ' + metrics.avgLossR.toFixed(3) + 'R' +
    ' | Expectancy: ' + metrics.expectancyR.toFixed(3) + 'R');
  console.error('Profit factor: ' + (Number.isFinite(metrics.profitFactor)
    ? metrics.profitFactor.toFixed(3) : 'Infinity') +
    ' | Max DD: ' + metrics.maxDrawdownPct.toFixed(2) + '%' +
    ' | Max consecutive losses: ' + metrics.maxConsecutiveLosses);
  console.error('Validation gates:');
  for (const [gate, passed] of Object.entries(metrics.gates)) {
    console.error('  ' + (passed ? 'PASS' : 'FAIL') + ' — ' + gate);
  }
  console.error('Overall: ' + (metrics.gatesPassed ? 'PASS' : 'FAIL — do not proceed to shadow mode'));
}

export async function runBacktest({
  symbols = DEFAULT_SYMBOLS,
  days = positiveInteger(process.env.PRE_BREAKOUT_BACKTEST_DAYS, 90),
  resolution = selectedResolution(),
  nowMs = Date.now()
} = {}) {
  resolution = selectedResolution(resolution);
  const intervalSeconds = CANDLE_SECONDS[resolution];
  const endSeconds = Math.floor(nowMs / (intervalSeconds * 1000)) * intervalSeconds;
  const startSeconds = endSeconds - days * DAY_SECONDS;
  const symbolRows = [];
  const trades = [];
  let openAtEnd = 0;
  let skippedByFees = 0;

  for (const symbol of symbols) {
    const fetched = await fetchHistoricalCandles(symbol, startSeconds, endSeconds, resolution);
    const simulation = simulateSymbol(symbol, fetched.candles);
    const row = {
      symbol,
      candleCount: fetched.candles.length,
      requestCount: fetched.requestCount,
      tradeCount: simulation.trades.length,
      skippedByFees: simulation.skippedByFees,
      openAtEnd: simulation.openAtEnd
    };
    symbolRows.push(row);
    trades.push(...simulation.trades);
    openAtEnd += simulation.openAtEnd;
    skippedByFees += simulation.skippedByFees;
  }

  trades.sort((a, b) => Number(a.exitTime) - Number(b.exitTime));
  const metrics = calculateBacktestMetrics(trades);
  const result = {
    generatedAt: new Date(nowMs).toISOString(),
    period: {
      requestedDays: days,
      start: new Date(startSeconds * 1000).toISOString(),
      end: new Date(endSeconds * 1000).toISOString(),
      resolution,
      candleSeconds: intervalSeconds,
      symbols: [...symbols]
    },
    executionModel: {
      signalHistoryCandles: 100,
      entry: 'next candle open',
      entrySlippagePct: ENTRY_SLIPPAGE * 100,
      feePerSidePct: FEE_PER_SIDE * 100,
      feeRiskFilter: {
        maxFeeToRiskRatio: MAX_FEE_RISK_RATIO,
        formula: 'entryPrice*0.001 + estimatedExitPrice*0.001 <= abs(entryPrice-stopLoss)*0.15',
        preEntryExitEstimate: 'stop-loss price (conservative)',
        skippedCandidatesAreNotTrades: true
      },
      riskPerTradePct: RISK_PER_TRADE * 100,
      sameCandleStopAndTarget: 'stop-loss first',
      targetForWinRate: 'TP1; TP2 is reported but no partial-exit model is assumed',
      levels: 're-anchored to actual slippage-adjusted fill using ATR from signal time',
      incompleteTrades: 'excluded from completed trade metrics and reported separately',
      noLookAhead: true
    },
    symbolResults: symbolRows,
    skippedByFees,
    unresolvedOpenTradesAtEnd: openAtEnd,
    metrics: {
      ...metrics,
      profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 'Infinity'
    },
    trades
  };
  printSummary(symbolRows, metrics, days, resolution, openAtEnd, skippedByFees);
  return result;
}

async function main() {
  const result = await runBacktest();
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error('Pre-breakout backtest failed: ' + String(error?.stack || error));
    process.exitCode = 1;
  });
}
