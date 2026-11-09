import { normalizeEpochSeconds } from './candle-normalization.mjs';

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const upper = value => String(value || '').trim().toUpperCase();
const isClosedSeries = candles => Array.isArray(candles) && candles.length > 2
  ? candles.slice(0, -1)
  : [];

function directionalPriceChange(side, entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  return (side === 'BUY' ? (exit / entry) - 1 : (entry / exit) - 1) * 100;
}

/**
 * Return a completed 5m high-volatility impulse. Relative volume is compared
 * with the mean volume of the preceding twenty completed 5m candles.
 */
export function getAdaptiveVolatilityImpulse(candles5m) {
  const candles = isClosedSeries(candles5m);
  if (candles.length < 22) return null;
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const previousVolume = candles.slice(-21, -1)
    .reduce((sum, candle) => sum + Math.max(0, numberOrNull(candle?.volume) || 0), 0) / 20;
  const currentVolume = Math.max(0, numberOrNull(latest?.volume) || 0);
  const moveBase = numberOrNull(previous?.close);
  const moveClose = numberOrNull(latest?.close);
  if (!(moveBase > 0) || !(moveClose > 0) || !(previousVolume > 0)) return null;
  // Round only for deterministic threshold comparisons: binary floating
  // point must not turn an exact 2.5% / 3.0x boundary into a qualifying event.
  const movePct = Number((((moveClose / moveBase) - 1) * 100).toFixed(8));
  const relativeVolume = Number((currentVolume / previousVolume).toFixed(8));
  if (!(Math.abs(movePct) > 2.5) || !(relativeVolume > 3)) return null;
  const candleStart = normalizeEpochSeconds(latest?.time);
  if (candleStart === null) return null;
  return {
    side: movePct < 0 ? 'SELL' : 'BUY',
    movePct,
    relativeVolume,
    signalAtSeconds: candleStart + 300
  };
}

/**
 * Infer a missing directional signal only if the existing 5m/15m trend stack
 * supports the high-volume impulse. This is shadow-only; live signal unchanged.
 */
export function inferAdaptiveVolatilityShadowSide(signal, impulseSide) {
  const wanted = upper(impulseSide);
  const current = upper(signal?.side);
  if (current) return current;
  const trend5 = upper(signal?.trend);
  const trend15 = upper(signal?.confirmTrend);
  if (wanted === 'SELL' &&
      (trend5 === 'BEAR' || (trend5 === 'FLAT' && trend15 === 'BEAR')) &&
      trend15 !== 'BULL') return 'SELL';
  if (wanted === 'BUY' &&
      (trend5 === 'BULL' || (trend5 === 'FLAT' && trend15 === 'BULL')) &&
      trend15 !== 'BEAR') return 'BUY';
  return '';
}

/**
 * Create a separate shadow observation only when a completed 5m candle shows
 * both a >2.5% directional impulse and >3x relative volume. It never changes
 * the signal passed to the live risk gate.
 */
export function buildAdaptiveVolatilityShadowObservation(signal, candles5m, {
  strategy,
  baseEmaDistanceMax = null,
  takerFeeRate = null,
  maxHoldMinutes = 240,
  maxAntiChasePct = 15,
  rangeAtrMax = 4,
  spreadMaxPct = 0.35,
  costGateRatio = 0.20,
  volumeMin = 0
} = {}) {
  const impulse = getAdaptiveVolatilityImpulse(candles5m);
  if (!impulse) return null;
  const { side: impulseSide, movePct, relativeVolume, signalAtSeconds } = impulse;

  const normalizedStrategy = upper(strategy || signal?.strategy);
  if (!['MOMENTUM', 'SCALPING'].includes(normalizedStrategy)) return null;
  const signalSide = upper(signal?.side);
  const directionalMatch = signalSide === impulseSide;
  const inferredDirection = signal?.adaptiveVolatilityShadowDirectionInferred === true;
  const isScalping = normalizedStrategy === 'SCALPING';

  const minRsi = isScalping ? 40 : 45;
  const maxRsi = isScalping ? 60 : 55;
  const rsi = numberOrNull(signal?.rsi);
  const adaptiveRsiPass = rsi !== null && (impulseSide === 'SELL'
    ? rsi >= 15 && rsi <= maxRsi
    : rsi >= minRsi && rsi <= 80);

  const price = numberOrNull(signal?.price);
  const vwap = numberOrNull(signal?.vwap);
  const atrEntry = numberOrNull(signal?.atrEntry);
  const vwapTolerance = Math.max(
    atrEntry > 0 ? atrEntry * (isScalping ? 0.35 : 0.25) : 0,
    price > 0 ? price * (isScalping ? 0.0025 : 0.0020) : 0
  );
  const vwapPass = !isScalping || (
    price > 0 && vwap > 0 &&
    (impulseSide === 'SELL' ? price <= vwap + vwapTolerance : price >= vwap - vwapTolerance)
  );

  const configuredEmaMax = numberOrNull(baseEmaDistanceMax) ??
    (isScalping ? 2.5 : 3.5);
  const adaptiveEmaMax = Math.min(configuredEmaMax + 1, configuredEmaMax * 1.3);
  const emaDistanceAtr = numberOrNull(signal?.emaDistanceAtr);
  const emaDistancePass = emaDistanceAtr !== null && emaDistanceAtr <= adaptiveEmaMax;

  const sourceBlocks = Array.isArray(signal?.blocked) ? signal.blocked.map(String) : [];
  const shadowBlocks = sourceBlocks.filter(reason => {
    if (reason === 'RSI/VWAP' && adaptiveRsiPass && vwapPass) return false;
    if (reason.includes('from entry EMA21') && emaDistancePass) return false;
    if (reason === 'No directional trigger' && inferredDirection && directionalMatch) return false;
    return true;
  });

  if (!directionalMatch) shadowBlocks.push('Signal direction does not match the 5m impulse');
  if (!adaptiveRsiPass && !shadowBlocks.includes('RSI/VWAP')) {
    shadowBlocks.push('RSI outside adaptive volatility bounds');
  }
  if (!vwapPass) shadowBlocks.push('VWAP direction confirmation');
  if (!emaDistancePass && !shadowBlocks.some(reason => reason.includes('from entry EMA21'))) {
    shadowBlocks.push('EMA21 distance exceeds adaptive volatility limit');
  }

  const change24h = numberOrNull(signal?.change);
  const antiChaseLimit = Math.max(0, numberOrNull(maxAntiChasePct) ?? 15);
  const antiChasePass = change24h !== null && (
    impulseSide === 'BUY' ? change24h <= antiChaseLimit : change24h >= -antiChaseLimit
  );
  if (!antiChasePass) shadowBlocks.push('24h anti-chase');

  const btcTrend5 = upper(signal?.btcTrend);
  const btcTrend15 = upper(signal?.btcConfirmTrend);
  const btcOpposed = impulseSide === 'BUY'
    ? btcTrend5 === 'BEAR' && btcTrend15 === 'BEAR'
    : btcTrend5 === 'BULL' && btcTrend15 === 'BULL';
  if (btcOpposed) shadowBlocks.push('BTC regime');

  const rangeAtr = numberOrNull(signal?.rangeAtr);
  const rangeMax = Math.max(0, numberOrNull(rangeAtrMax) ?? 4);
  if (rangeAtr === null || rangeAtr > rangeMax) shadowBlocks.push('Entry candle range exceeds strategy limit');

  const volumeSpike = numberOrNull(signal?.volumeSpike);
  const minimumVolume = Math.max(0, numberOrNull(volumeMin) ?? 0);
  if (volumeSpike === null || volumeSpike < minimumVolume) shadowBlocks.push('Strategy volume threshold');

  const spreadPct = Math.max(0, numberOrNull(signal?.spreadPct) ?? 99);
  const spreadLimit = Math.max(0, numberOrNull(spreadMaxPct) ?? 0.35);
  if (spreadPct > spreadLimit) shadowBlocks.push('Spread exceeds configured limit');

  const feeRiskRatio = numberOrNull(signal?.feeRiskRatio);
  const feeRiskLimit = Math.max(0, numberOrNull(costGateRatio) ?? 0.20);
  if (feeRiskRatio === null || feeRiskRatio > feeRiskLimit) shadowBlocks.push('Fee + spread exceeds allowed 1R cost');

  const localScore = numberOrNull(signal?.score);
  if (localScore === null || localScore < 45) shadowBlocks.push('Local strategy score below 45');

  const normalizedScore = numberOrNull(signal?.normalizedScore);
  if (normalizedScore === null || normalizedScore < 80) {
    shadowBlocks.push('Normalized score below 80 or unavailable');
  }
  if (signal?.candlesFresh !== true) shadowBlocks.push('Fresh closed candles unavailable');

  let sl = numberOrNull(signal?.sl);
  if (!(price > 0) || !(sl > 0)) {
    const stopPct = numberOrNull(signal?.stopPct);
    if (stopPct !== null && stopPct > 0 && stopPct < 0.5) {
      const rawStop = impulseSide === 'BUY' ? price * (1 - stopPct) : price * (1 + stopPct);
      const tick = Math.max(0, numberOrNull(signal?.tickSize) ?? 0);
      sl = tick > 0
        ? (impulseSide === 'BUY' ? Math.floor(rawStop / tick) * tick : Math.ceil(rawStop / tick) * tick)
        : rawStop;
    }
  }
  if (!(price > 0) || !(sl > 0) ||
      (impulseSide === 'BUY' ? sl >= price : sl <= price)) {
    shadowBlocks.push('Valid directional initial stop unavailable');
  }

  const feeRateInput = numberOrNull(takerFeeRate);
  if (feeRateInput === null) shadowBlocks.push('Taker fee rate unavailable');

  const uniqueBlocks = [...new Set(shadowBlocks)];
  const symbol = upper(signal?.symbol);
  if (!symbol) return null;

  const holdMinutes = Math.max(1, Math.min(1440, Math.floor(Number(maxHoldMinutes) || 240)));
  const feeRate = Math.max(0, feeRateInput ?? 0);
  const capturedSpreadPct = Math.max(0, numberOrNull(signal?.spreadPct) || 0);
  const initialStopDistance = price > 0 && sl > 0 ? Math.abs(price - sl) : null;
  const status = uniqueBlocks.length ? 'BLOCKED' : 'PENDING_ENTRY';

  return {
    signal_key: [symbol, normalizedStrategy, impulseSide, signalAtSeconds].join(':'),
    symbol,
    strategy: normalizedStrategy,
    side: impulseSide,
    impulse_side: impulseSide,
    source_signal_side: upper(signal?.originalSignalSide ?? signalSide) || null,
    signal_at: new Date(signalAtSeconds * 1000).toISOString(),
    signal_price: price,
    move_5m_pct: Number(movePct.toFixed(8)),
    relative_volume: Number(relativeVolume.toFixed(6)),
    rsi,
    ema_distance_atr: emaDistanceAtr,
    ema_distance_limit_atr: Number(adaptiveEmaMax.toFixed(4)),
    normalized_score: normalizedScore,
    taker_fee_rate: feeRate,
    spread_pct: capturedSpreadPct,
    max_hold_minutes: holdMinutes,
    base_blocked_reasons: sourceBlocks,
    shadow_blocked_reasons: uniqueBlocks,
    shadow_status: status,
    details: {
      sourceStage: upper(signal?.stage),
      sourceLocalScore: numberOrNull(signal?.score),
      sourceNormalizedScore: normalizedScore,
      sourceStopPrice: sl,
      sourceTakeProfitPrice: numberOrNull(signal?.tp),
      initialStopDistance,
      sourceTrend5m: upper(signal?.trend),
      sourceTrend15m: upper(signal?.confirmTrend),
      adaptiveRsiMinimum: impulseSide === 'SELL' ? 15 : minRsi,
      adaptiveRsiMaximum: impulseSide === 'BUY' ? 80 : maxRsi,
      emaRelaxation: 'base_limit_plus_30_percent_capped_at_plus_1_ATR',
      trailingModel: 'activate_at_1R_then_trail_by_1R',
      exitModel: 'initial_stop_then_trailing_stop_or_time_exit; no_fixed_take_profit',
      takerFeeRateAvailable: feeRateInput !== null,
      execution: 'SHADOW_ONLY'
    }
  };
}

/**
 * Simulate one completed 1m bar using conservative OHLC ordering: test the
 * stop that existed before the candle first, then update the high-water mark
 * and trailing stop for the next candle. No exchange order is ever submitted.
 */
export function advanceAdaptiveShadowPosition(position, candle) {
  const side = upper(position?.side);
  const entry = numberOrNull(position?.entry_price);
  const initialStop = numberOrNull(position?.initial_stop_price);
  const currentStop = numberOrNull(position?.trailing_stop_price ?? initialStop);
  const open = numberOrNull(candle?.open);
  const high = numberOrNull(candle?.high);
  const low = numberOrNull(candle?.low);
  const close = numberOrNull(candle?.close);
  const candleTime = normalizeEpochSeconds(candle?.time);
  if (!['BUY', 'SELL'].includes(side) || !(entry > 0) ||
      !(initialStop > 0) || !(currentStop > 0) ||
      !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) ||
      candleTime === null) return null;

  const riskDistance = Math.abs(entry - initialStop);
  if (!(riskDistance > 0)) return null;

  const hitStop = side === 'BUY' ? low <= currentStop : high >= currentStop;
  if (hitStop) {
    const exitPrice = side === 'BUY'
      ? (open < currentStop ? open : currentStop)
      : (open > currentStop ? open : currentStop);
    const gross = directionalPriceChange(side, entry, exitPrice);
    const feeRate = Math.max(0, numberOrNull(position?.taker_fee_rate) || 0);
    const spreadPct = Math.max(0, numberOrNull(position?.spread_pct) || 0);
    const costPct = (2 * feeRate * 100) + spreadPct;
    return {
      shadow_status: 'CLOSED',
      best_price: numberOrNull(position?.best_price) ?? entry,
      worst_price: numberOrNull(position?.worst_price) ?? entry,
      trailing_activated: position?.trailing_activated === true,
      trailing_stop_price: currentStop,
      max_favorable_excursion_pct: numberOrNull(position?.max_favorable_excursion_pct),
      max_adverse_excursion_pct: numberOrNull(position?.max_adverse_excursion_pct),
      exit_at: new Date((candleTime + 60) * 1000).toISOString(),
      exit_price: exitPrice,
      exit_reason: position?.trailing_activated === true ? 'TRAILING_STOP' : 'INITIAL_STOP',
      gross_pnl_pct: gross,
      transaction_cost_pct: costPct,
      net_pnl_pct: gross === null ? null : gross - costPct,
      last_processed_candle_time: candleTime
    };
  }

  const priorBest = numberOrNull(position?.best_price) ?? entry;
  const bestPrice = side === 'BUY' ? Math.max(priorBest, high) : Math.min(priorBest, low);
  const worstPrice = numberOrNull(position?.worst_price) ??
    (side === 'BUY' ? entry : entry);
  const nextWorst = side === 'BUY' ? Math.min(worstPrice, low) : Math.max(worstPrice, high);
  const favorablePct = directionalPriceChange(side, entry, bestPrice);
  const adversePct = directionalPriceChange(side, entry, nextWorst);
  const activated = position?.trailing_activated === true || (
    side === 'BUY' ? bestPrice >= entry + riskDistance : bestPrice <= entry - riskDistance
  );
  const proposedStop = side === 'BUY' ? bestPrice - riskDistance : bestPrice + riskDistance;
  const nextStop = !activated ? currentStop : side === 'BUY'
    ? Math.max(currentStop, proposedStop)
    : Math.min(currentStop, proposedStop);

  const entryAtMs = Date.parse(position?.entry_at || '');
  const holdMinutes = Math.max(1, Math.min(1440, Number(position?.max_hold_minutes) || 240));
  const timedOut = Number.isFinite(entryAtMs) &&
    (candleTime + 60) * 1000 >= entryAtMs + holdMinutes * 60_000;
  if (timedOut) {
    const gross = directionalPriceChange(side, entry, close);
    const feeRate = Math.max(0, numberOrNull(position?.taker_fee_rate) || 0);
    const spreadPct = Math.max(0, numberOrNull(position?.spread_pct) || 0);
    const costPct = (2 * feeRate * 100) + spreadPct;
    return {
      shadow_status: 'CLOSED',
      best_price: bestPrice,
      worst_price: nextWorst,
      trailing_activated: activated,
      trailing_stop_price: nextStop,
      max_favorable_excursion_pct: favorablePct,
      max_adverse_excursion_pct: adversePct,
      exit_at: new Date((candleTime + 60) * 1000).toISOString(),
      exit_price: close,
      exit_reason: 'TIMEOUT',
      gross_pnl_pct: gross,
      transaction_cost_pct: costPct,
      net_pnl_pct: gross === null ? null : gross - costPct,
      last_processed_candle_time: candleTime
    };
  }

  return {
    shadow_status: 'OPEN',
    best_price: bestPrice,
    worst_price: nextWorst,
    trailing_activated: activated,
    trailing_stop_price: nextStop,
    max_favorable_excursion_pct: favorablePct,
    max_adverse_excursion_pct: adversePct,
    last_processed_candle_time: candleTime
  };
}

function buildEntryPatch(observation, candle) {
  const side = upper(observation?.side);
  const entryPrice = numberOrNull(candle?.open);
  const signalPrice = numberOrNull(observation?.signal_price);
  const sourceStop = numberOrNull(observation?.details?.sourceStopPrice);
  if (!(entryPrice > 0) || !(signalPrice > 0) || !(sourceStop > 0)) return null;
  const riskDistance = Math.abs(signalPrice - sourceStop);
  if (!(riskDistance > 0)) return null;
  const stop = side === 'BUY' ? entryPrice - riskDistance : entryPrice + riskDistance;
  if (!(stop > 0)) return null;
  const candleTime = normalizeEpochSeconds(candle?.time);
  if (candleTime === null) return null;
  return {
    shadow_status: 'OPEN',
    entry_at: new Date(candleTime * 1000).toISOString(),
    entry_price: entryPrice,
    initial_stop_price: stop,
    trailing_stop_price: stop,
    best_price: entryPrice,
    worst_price: entryPrice,
    trailing_activated: false,
    last_processed_candle_time: null,
    updated_at: new Date().toISOString()
  };
}

async function updateShadowRow(database, signalKey, patch) {
  await database.update(
    'dd_shadow_signals',
    'signal_key=eq.' + encodeURIComponent(String(signalKey)),
    { ...patch, updated_at: new Date().toISOString() }
  );
}

/**
 * Persist new observations and advance pending/open shadow positions. Database
 * state is the only simulation state so restarts are idempotent.
 */
export async function processAdaptiveVolatilityShadowCycle({
  database,
  observations = [],
  candlesBySymbol = new Map(),
  now = () => Date.now()
} = {}) {
  if (!database || typeof database.select !== 'function' || typeof database.update !== 'function') {
    throw new Error('Adaptive shadow database adapter is unavailable');
  }

  const rows = Array.isArray(observations) ? observations.filter(Boolean) : [];
  if (rows.length) {
    if (typeof database.insertManyIgnore === 'function') {
      await database.insertManyIgnore('dd_shadow_signals', rows, 'signal_key');
    } else if (typeof database.insertIgnore === 'function') {
      for (const row of rows) await database.insertIgnore('dd_shadow_signals', row, 'signal_key');
    } else {
      throw new Error('Database adapter does not support idempotent shadow inserts');
    }
  }

  const activeRows = await database.select(
    'dd_shadow_signals',
    'shadow_status=in.(PENDING_ENTRY,OPEN)&select=*&order=created_at.asc&limit=500'
  );
  if (!Array.isArray(activeRows)) throw new Error('Shadow position query returned malformed data');

  let entriesOpened = 0;
  let exitsClosed = 0;
  let positionsUpdated = 0;
  const currentTime = Number(now());
  for (const row of activeRows) {
    const symbol = upper(row?.symbol);
    const candles = candlesBySymbol instanceof Map ? candlesBySymbol.get(symbol) : candlesBySymbol?.[symbol];
    if (!Array.isArray(candles) || candles.length < 3) continue;

    if (row.shadow_status === 'PENDING_ENTRY') {
      const signalAtMs = Date.parse(row.signal_at || '');
      if (!Number.isFinite(signalAtMs)) continue;
      // The signal is timestamped at the close of a 5m candle. Use only the
      // immediately following 1m bucket; never enter late using a later bar.
      const entryCandle = candles.find(candle => {
        const seconds = normalizeEpochSeconds(candle?.time);
        return seconds !== null && seconds * 1000 === signalAtMs;
      });
      if (!entryCandle) {
        if (currentTime > signalAtMs + 10 * 60_000) {
          await updateShadowRow(database, row.signal_key, {
            shadow_status: 'EXPIRED',
            exit_reason: 'NO_NEXT_1M_CANDLE',
            exit_at: new Date(currentTime).toISOString()
          });
        }
        continue;
      }
      const entryPatch = buildEntryPatch(row, entryCandle);
      if (!entryPatch) {
        await updateShadowRow(database, row.signal_key, {
          shadow_status: 'BLOCKED',
          shadow_blocked_reasons: [...(row.shadow_blocked_reasons || []), 'Invalid next-candle shadow entry or stop']
        });
        continue;
      }
      await updateShadowRow(database, row.signal_key, entryPatch);
      entriesOpened += 1;
      Object.assign(row, entryPatch);
    }

    if (row.shadow_status !== 'OPEN') continue;
    const closedCandles = isClosedSeries(candles);
    const lastProcessed = numberOrNull(row.last_processed_candle_time);
    const entryAtMs = Date.parse(row.entry_at || '');
    if (!Number.isFinite(entryAtMs)) continue;
    const bars = closedCandles.filter(candle => {
      const seconds = normalizeEpochSeconds(candle?.time);
      return seconds !== null && seconds * 1000 >= entryAtMs &&
        (lastProcessed === null || seconds > lastProcessed);
    }).sort((a, b) => Number(a.time) - Number(b.time));
    if (!bars.length) continue;

    let state = { ...row };
    for (const candle of bars) {
      const patch = advanceAdaptiveShadowPosition(state, candle);
      if (!patch) continue;
      state = { ...state, ...patch };
      positionsUpdated += 1;
      if (patch.shadow_status === 'CLOSED') {
        await updateShadowRow(database, row.signal_key, patch);
        exitsClosed += 1;
        break;
      }
    }
    if (state.shadow_status === 'OPEN' &&
        numberOrNull(state.last_processed_candle_time) !== lastProcessed) {
      await updateShadowRow(database, row.signal_key, {
        best_price: state.best_price,
        worst_price: state.worst_price,
        trailing_activated: state.trailing_activated,
        trailing_stop_price: state.trailing_stop_price,
        max_favorable_excursion_pct: state.max_favorable_excursion_pct,
        max_adverse_excursion_pct: state.max_adverse_excursion_pct,
        last_processed_candle_time: state.last_processed_candle_time
      });
    }
  }

  return {
    observationsInserted: rows.length,
    activeRows: activeRows.length,
    entriesOpened,
    positionsUpdated,
    exitsClosed
  };
}
