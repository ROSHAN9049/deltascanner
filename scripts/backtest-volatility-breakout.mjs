
        break;
      }
    }

    if (!contiguous) continue;

    // 15-minute price move, using completed 1-minute candles.
    const move = bars.c[i] / bars.c[i - 15] - 1;
    let direction = 0;

    if (move > MOVE_TRIGGER) direction = 1;
    else if (move < -MOVE_TRIGGER) direction = -1;
    if (!direction) continue;

    // The next completed candle must confirm the direction.
    const confirmIndex = i + 1;
    const confirmClose = bars.c[confirmIndex];

    const confirms = direction === 1
      ? (confirmClose > bars.o[confirmIndex] && confirmClose > bars.c[i])
      : (confirmClose < bars.o[confirmIndex] && confirmClose < bars.c[i]);

    if (!confirms) continue;

    // Confirmation volume must be >= configured multiple of prior 20-bar median.
    const baselineMedian = median(Array.from(bars.v.subarray(i - 19, i + 1)));
    if (!(baselineMedian > 0) ||
        bars.v[confirmIndex] < baselineMedian * CONFIRM_VOL_MULTIPLE) {
      continue;
    }

    // ATR is calculated through the confirmation candle.
    const atr = atr14At(bars, confirmIndex);
    if (!(atr > 0) || !Number.isFinite(atr)) continue;

    // Reject entries where the confirmation candle has already overextended.
    const extension = direction * (confirmClose - bars.c[i]);
    if (extension > EXTENSION_ATR_MAX * atr) continue;

    // Entry is at the open of the candle after confirmation.
    const entryIndex = i + 2;
    const entryTs = bars.t[entryIndex];
    const hourTs = Math.floor(entryTs / 3600) * 3600;
    const idx = hourIndex.get(hourTs);

    // The symbol must have qualified for the historical Top-N at entry time.
    if (idx === undefined || !eligibleHours.get(symbol)?.has(idx)) continue;

    signals.push({
      symbol,
      direction,
      triggerTs: bars.t[i],
      confirmTs: bars.t[confirmIndex],
      entryTs,
      entryIndex,
      entryRaw: bars.o[entryIndex],
      atr,
      triggerMovePct: move * 100,
      turnoverUsd: turnoverBySymbol.get(symbol)?.[idx] ?? 0,
      feeRate,
    });
  }

  return signals;
}

function simulateSignal(signal, bars, slippageBps) {
  const slip = slippageBps / 10_000;
  const direction = signal.direction;

  // Adverse slippage on entry:
  // BUY pays higher; SELL receives lower.
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

  // Do not simulate an incomplete trade beyond available candle history.
  if (lastExitIndex >= bars.t.length) return null;

  const markPoints = [];

  for (let k = signal.entryIndex; k <= lastExitIndex; k += 1) {
    const open = bars.o[k];
    const high = bars.h[k];
    const low = bars.l[k];
    const close = bars.c[k];

    const stopHit = direction === 1
      ? low <= stopPrice
      : high >= stopPrice;

    const targetHit = direction === 1
      ? high >= targetPrice
      : low <= targetPrice;

    // Conservative intrabar assumption: if both levels are touched,
    // the stop is assumed to execute first.
    if (stopHit) {
      // Account for a gap through the stop at the candle open.
      exitRaw = direction === 1
        ? (open < stopPrice ? open : stopPrice)
        : (open > stopPrice ? open : stopPrice);

      exitIndex = k;
      exitReason = 'STOP';
    } else if (targetHit) {
      exitRaw = targetPrice;
      exitIndex = k;
      exitReason = 'TARGET';
    } else if (k === lastExitIndex) {
      exitRaw = close;
      exitIndex = k;
      exitReason = 'TIME';
    }

    if (exitIndex === k) {
      // Adverse slippage on exit:
      // SELL exit for a long receives less; BUY exit for a short pays more.
      const exitFill = exitRaw * (1 - direction * slip);

      // Fixed USD notional, linear-contract approximation.
      const grossPnl = NOTIONAL_USD *
        direction *
        (exitFill / entryFill - 1);

      const exitNotional = NOTIONAL_USD * (exitFill / entryFill);
      const exitFee = exitNotional * signal.feeRate;
      const fees = entryFee + exitFee;
      const netPnl = grossPnl - fees;

      markPoints.push({
        ts: bars.t[k] + 60,
        pnl: netPnl,
      });

      return {
        ...signal,
        slippageBps,
        entryFill,
        exitTs: bars.t[k] + 60,
        exitRaw,
        exitFill,
        exitReason,
        grossPnl,
        fees,
        netPnl,
        entryFee,
        markPoints,
      };
    }

    // Mark-to-market estimate using a hypothetical liquidation at candle close.
    // This includes adverse exit slippage and the estimated exit taker fee.
    const markExitFill = close * (1 - direction * slip);

    const markGross = NOTIONAL_USD *
      direction *
      (markExitFill / entryFill - 1);

    const markExitNotional = NOTIONAL_USD * (markExitFill / entryFill);
    const markNet = markGross -
      entryFee -
      (markExitNotional * signal.feeRate);

    markPoints.push({
      ts: bars.t[k] + 60,
      pnl: markNet,
    });
  }

  return null;
}

function schedulePortfolio(candidates) {
  // Resolve simultaneous candidates deterministically:
  // highest historical turnover first, then symbol alphabetically.
  candidates.sort((a, b) =>
    a.entryTs - b.entryTs ||
    b.turnoverUsd - a.turnoverUsd ||
    a.symbol.localeCompare(b.symbol)
  );

  const accepted = [];
  let active = [];

  const symbolCooldownUntil = new Map();
  const symbolExitAt = new Map();

  for (const candidate of candidates) {
    // Only positions still open at this candidate's entry time consume capacity.
    active = active.filter((position) =>
      position.exitTs > candidate.entryTs
    );

    const sameSymbolExit =
      symbolExitAt.get(candidate.symbol) ?? -Infinity;

    const cooldownUntil =
      symbolCooldownUntil.get(candidate.symbol) ?? -Infinity;

    // Block overlapping positions on the same symbol.
    if (candidate.entryTs < sameSymbolExit) continue;

    // Enforce the post-exit cooldown.
    if (candidate.entryTs < cooldownUntil) continue;

    // Enforce the global concurrent-position cap.
    if (active.length >= MAX_GLOBAL_POSITIONS) continue;

    accepted.push(candidate);

    active.push({
      symbol: candidate.symbol,
      exitTs: candidate.exitTs,
    });

    symbolExitAt.set(candidate.symbol, candidate.exitTs);

    symbolCooldownUntil.set(
      candidate.symbol,
      candidate.exitTs + COOLDOWN_MINUTES * 60,
    );
  }

  return accepted;
}

function portfolioDrawdown(trades) {
  // Calculate equity using chronological, minute-level liquidation estimates.
  const events = new Map();

  const addEvent = (timestamp, delta) => {
    events.set(
      timestamp,
      (events.get(timestamp) || 0) + delta,
    );
  };

  for (const trade of trades) {
    // Entry fee is charged immediately.
    addEvent(trade.entryTs, -trade.entryFee);

    let previousContribution = -trade.entryFee;

    for (const point of trade.markPoints) {
      const delta = point.pnl - previousContribution;
      addEvent(point.ts, delta);
      previousContribution = point.pnl;
    }
  }

  const timeline = [...events.entries()]
    .sort((a, b) => a[0] - b[0]);

  let equity = INITIAL_EQUITY_USD;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const [, delta] of timeline) {
    equity += delta;

    if (equity > peak) {
      peak = equity;
    }

    const drawdown = peak - equity;
    const drawdownPct = peak > 0
      ? (drawdown / peak) * 100
      : 0;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
    }
  }

  return {
    maxDrawdown,
    maxDrawdownPct,
  };
}

function summarize(slippageBps, trades) {
  const pumps = trades.filter((trade) => trade.direction === 1);
  const dumps = trades.filter((trade) => trade.direction === -1);

  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);

  const positiveNet = wins.reduce(
    (sum, trade) => sum + trade.netPnl,
    0,
  );

  const negativeNet = Math.abs(
    losses.reduce((sum, trade) => sum + trade.netPnl, 0),
  );

  const dd = portfolioDrawdown(trades);

  const sum = (items, key) => items.reduce(
    (total, item) => total + item[key],
    0,
  );

  return {
    slippageBps,
    totalTrades: trades.length,
    pumpTrades: pumps.length,
    dumpTrades: dumps.length,

    pumpWinRate: pumps.length
      ? pumps.filter((trade) => trade.netPnl > 0).length /
        pumps.length * 100
      : 0,

    dumpWinRate: dumps.length
      ? dumps.filter((trade) => trade.netPnl > 0).length /
        dumps.length * 100
      : 0,

    overallWinRate: trades.length
      ? wins.length / trades.length * 100
      : 0,

    profitFactor: negativeNet === 0
      ? (positiveNet > 0 ? 'Infinity' : 0)
      : positiveNet / negativeNet,

    maxDrawdownUsd: dd.maxDrawdown,
    maxDrawdownPct: dd.maxDrawdownPct,

    netPnlUsd: sum(trades, 'netPnl'),
    grossPnlUsd: sum(trades, 'grossPnl'),
    feesUsd: sum(trades, 'fees'),

    avgNetPnlUsd: trades.length
      ? sum(trades, 'netPnl') / trades.length
      : 0,
  };
}

async function writeCsv(filePath, header, rows) {
  const stream = createWriteStream(filePath, {
    encoding: 'utf8',
  });

  stream.write(csvLine(header));

  for (const row of rows) {
    stream.write(csvLine(row));
  }

  stream.end();
  await finished(stream);
}

async function main() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });

  const hours = [];

  for (
    let timestamp = RANGE.startHour;
    timestamp <= RANGE.endHour;
    timestamp += 3600
  ) {
    hours.push(timestamp);
  }

  const hourIndex = new Map(
    hours.map((timestamp, index) => [timestamp, index]),
  );

  console.log('DEALDOST Volatility Breakout historical research backtest');
  console.log(`Market data base: ${BASE_URL}`);
  console.log(
    `Range: ${iso(RANGE.startMinute)} to ${iso(RANGE.endMinute)} (fully closed candles)`,
  );

  console.log(
    `Rules: +/-${(MOVE_TRIGGER * 100).toFixed(2)}% / 15m, ` +
    `ATR ${ATR_MULTIPLE}x, TP ${TARGET_R}R, ` +
    `${TIME_EXIT_MINUTES}m time exit`,
  );

  console.log(
    `Universe: rolling Top-${TOP_N} by preceding 24h estimated turnover; ` +
    `minimum $${MIN_TURNOVER_USD.toLocaleString('en-US')}`,
  );

  console.log(
    `Portfolio: max ${MAX_GLOBAL_POSITIONS}, ` +
    `${COOLDOWN_MINUTES}m symbol cooldown, ` +
    `fixed $${NOTIONAL_USD} notional`,
  );

  console.log(
    'READ-ONLY MODE: no authenticated account, order, database, or worker endpoints.',
  );

  const products = await fetchProducts();

  if (!products.length) {
    throw new Error(
      'No eligible USD-quoted linear perpetual products found in /v2/products.',
    );
  }

  console.log(
    `Found ${products.length} eligible perpetual products in the currently discoverable catalog.`,
  );

  const {
    eligibleHours,
    candidateSymbols,
    universeFile,
    turnoverBySymbol,
  } = await buildHistoricalTopUniverse(products, hours);

  const productBySymbol = new Map(
    products.map((product) => [product.symbol, product]),
  );

  const symbols = [...candidateSymbols].sort();

  console.log(
    `Historical Top-${TOP_N} union: ${symbols.length} symbols. ` +
    `Ranking audit: ${universeFile}`,
  );

  if (!symbols.length) {
    throw new Error(
      'No symbol met the historical Top-N and minimum-turnover filters.',
    );
  }

  // Build a separate candidate list for every slippage scenario.
  const scenarioCandidates = new Map(
    SLIPPAGE_BPS.map((bps) => [bps, []]),
  );

  let symbolCount = 0;

  for (const symbol of symbols) {
    symbolCount += 1;

    const product = productBySymbol.get(symbol);
    if (!product) continue;

    console.log(`[minute ${symbolCount}/${symbols.length}] ${symbol}`);

    const bars = await loadCandles(
      symbol,
      '1m',
      RANGE.startMinute,
      RANGE.endMinute,
    );

    if (bars.t.length < 100) {
      console.warn(
        `  Skipping ${symbol}: only ${bars.t.length} minute candles available.`,
      );
      continue;
    }

    const signals = makeSignals(
      symbol,
      product,
      bars,
      eligibleHours,
      turnoverBySymbol,
      hourIndex,
    );

    console.log(
      `  candles=${bars.t.length.toLocaleString()}, ` +
      `confirmed candidates=${signals.length}`,
    );

    for (const bps of SLIPPAGE_BPS) {
      const bucket = scenarioCandidates.get(bps);

      for (const signal of signals) {
        const candidate = simulateSignal(
          signal,
          bars,
          bps,
        );

        if (candidate) {
          bucket.push(candidate);
        }
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

    console.log(
      `\n${bps} bps: ` +
      `trades=${summary.totalTrades}, ` +
      `win=${summary.overallWinRate.toFixed(2)}%, ` +
      `PF=${summary.profitFactor}, ` +
      `net=$${summary.netPnlUsd.toFixed(2)}, ` +
      `MDD=$${summary.maxDrawdownUsd.toFixed(2)} ` +
      `(${summary.maxDrawdownPct.toFixed(2)}%)`,
    );

    for (const trade of accepted) {
      allTradeRows.push({
        slippageBps: bps,
        symbol: trade.symbol,
        direction: trade.direction === 1
          ? 'PUMP_LONG'
          : 'DUMP_SHORT',

        triggerTimeUtc: iso(trade.triggerTs),
        confirmationTimeUtc: iso(trade.confirmTs),
        entryTimeUtc: iso(trade.entryTs),
        exitTimeUtc: iso(trade.exitTs),

        triggerMovePct: fmt(trade.triggerMovePct, 4),
        atr14: fmt(trade.atr, 8),

        entryRaw: fmt(trade.entryRaw, 8),
        entryFill: fmt(trade.entryFill, 8),
        exitRaw: fmt(trade.exitRaw, 8),
        exitFill: fmt(trade.exitFill, 8),

        exitReason: trade.exitReason,
        notionalUsd: fmt(NOTIONAL_USD, 2),
        takerFeeRate: fmt(trade.feeRate, 8),

        grossPnlUsd: fmt(trade.grossPnl, 6),
        feesUsd: fmt(trade.fees, 6),
        netPnlUsd: fmt(trade.netPnl, 6),
      });
    }
  }

  const summaryPath = path.join(
    OUT_DIR,
    'volatility-breakout-summary.csv',
  );

  const tradesPath = path.join(
    OUT_DIR,
    'volatility-breakout-trades.csv',
  );

  await writeCsv(
    summaryPath,
    [
      'slippage_bps',
      'total_trades',
      'pump_trades',
      'dump_trades',
      'pump_win_rate_pct',
      'dump_win_rate_pct',
      'overall_win_rate_pct',
      'profit_factor',
      'max_drawdown_usd',
      'max_drawdown_pct',
      'net_pnl_usd',
      'gross_pnl_usd',
      'fees_usd',
      'avg_net_pnl_usd',
      'initial_equity_usd',
      'notional_per_trade_usd',
    ],
    summaries.map((summary) => [
      summary.slippageBps,
      summary.totalTrades,
      summary.pumpTrades,
      summary.dumpTrades,
      fmt(summary.pumpWinRate, 4),
      fmt(summary.dumpWinRate, 4),
      fmt(summary.overallWinRate, 4),
      summary.profitFactor,
      fmt(summary.maxDrawdownUsd, 6),
      fmt(summary.maxDrawdownPct, 4),
      fmt(summary.netPnlUsd, 6),
      fmt(summary.grossPnlUsd, 6),
      fmt(summary.feesUsd, 6),
      fmt(summary.avgNetPnlUsd, 6),
      fmt(INITIAL_EQUITY_USD, 2),
      fmt(NOTIONAL_USD, 2),
    ]),
  );

  await writeCsv(
    tradesPath,
    [
      'slippage_bps',
      'symbol',
      'direction',
      'trigger_time_utc',
      'confirmation_time_utc',
      'entry_time_utc',
      'exit_time_utc',
      'trigger_move_pct',
      'atr14',
      'entry_raw',
      'entry_fill',
      'exit_raw',
      'exit_fill',
      'exit_reason',
      'notional_usd',
      'taker_fee_rate',
      'gross_pnl_usd',
      'fees_usd',
      'net_pnl_usd',
    ],
    allTradeRows.map((trade) => [
      trade.slippageBps,
      trade.symbol,
      trade.direction,
      trade.triggerTimeUtc,
      trade.confirmationTimeUtc,
      trade.entryTimeUtc,
      trade.exitTimeUtc,
      trade.triggerMovePct,
      trade.atr14,
      trade.entryRaw,
      trade.entryFill,
      trade.exitRaw,
      trade.exitFill,
      trade.exitReason,
      trade.notionalUsd,
      trade.takerFeeRate,
      trade.grossPnlUsd,
      trade.feesUsd,
      trade.netPnlUsd,
    ]),
  );

  const metadataPath = path.join(
    OUT_DIR,
    'backtest-assumptions.txt',
  );

  const metadata = [
    'Volatility Breakout backtest assumptions',
    `API base: ${BASE_URL}`,
    `UTC range: ${iso(RANGE.startMinute)} to ${iso(RANGE.endMinute)}`,
    `Product catalog count: ${products.length}`,
    `Historical Top-N union symbols: ${symbols.length}`,
    `Top N: ${TOP_N}`,
    `Minimum estimated rolling 24h turnover USD: ${MIN_TURNOVER_USD}`,
    'Turnover formula: volume * contract_value * close unless contract_unit_currency is USD/USDT',
    `Trigger: absolute close-to-close 15-minute return > ${(MOVE_TRIGGER * 100).toFixed(4)}%`,
    `Confirmation: next 1m close direction + confirmation volume >= ${CONFIRM_VOL_MULTIPLE}x previous-20-bar median`,
    `Extension limit: ${EXTENSION_ATR_MAX} ATR beyond trigger close`,
    'ATR: simple 14-period average true range through confirmation candle',
    'Entry: next candle open, with adverse slippage',
    `Stop: ${ATR_MULTIPLE} ATR; target: ${TARGET_R}R; time exit: ${TIME_EXIT_MINUTES} minutes`,
    `Max concurrent positions: ${MAX_GLOBAL_POSITIONS}`,
    `Per-symbol cooldown: ${COOLDOWN_MINUTES} minutes after exit`,
    `Fixed USD notional per trade: ${NOTIONAL_USD}`,
    `Taker fee override: ${TAKER_FEE_OVERRIDE === null ? 'none; product metadata rate used' : TAKER_FEE_OVERRIDE}`,
    `Slippage scenarios (bps, each entry and exit): ${SLIPPAGE_BPS.join(',')}`,
    'Fees: entry and exit taker fees charged on modeled notional.',
    'Funding: excluded.',
    'Spread/order-book depth: historical data unavailable; not verified by this backtest.',
    'Product history: only currently discoverable Products API catalog; delisted-symbol survivorship bias may remain.',
    'Turnover: estimate from OHLC candle volume and product contract metadata; inspect universe-history.csv.',
    'Drawdown: minute-by-minute estimated liquidation-value equity including open-trade marks, fees, and slippage.',
    'Execution: no authenticated endpoints and no order submission code.',
  ].join('\n') + '\n';

  await fsp.writeFile(
    metadataPath,
    metadata,
    'utf8',
  );

  console.log('\nCompleted. Files written:');
  console.log(`  Summary: ${summaryPath}`);
  console.log(`  Trades:  ${tradesPath}`);
  console.log(`  Universe audit: ${universeFile}`);
  console.log(`  Assumptions: ${metadataPath}`);
  console.log(`  Cache: ${CACHE_DIR}`);
}

main().catch((error) => {
  console.error(
    `\nBACKTEST FAILED: ${error.stack || error.message || error}`,
  );
  process.exitCode = 1;
});
        
