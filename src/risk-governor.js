import { GATE_BLOCK, GATE_PASS, GATE_UNKNOWN, gateResult } from './gate-result.js';
import { safeNum } from './formatters.js';

function detailsOf(selected) {
  if (selected?.details && typeof selected.details === 'object' && !Array.isArray(selected.details)) {
    return selected.details;
  }
  if (typeof selected?.details === 'string') {
    try {
      const parsed = JSON.parse(selected.details);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function textOfReasons(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(' · ');
  return typeof value === 'string' ? value : '';
}

function status(known, passes) {
  if (!known) return GATE_UNKNOWN;
  return passes ? GATE_PASS : GATE_BLOCK;
}

function hasReason(reasonText, pattern) {
  const normalizedReason = reasonText.toLowerCase().replace(/[_-]+/g, ' ');
  const normalizedPattern = pattern.toLowerCase().replace(/[_-]+/g, ' ');
  return normalizedReason.includes(normalizedPattern);
}

export function buildRiskGovernorGates({
  selected,
  health = null,
  positions = null,
  routedSymbols = null,
  routeDataVerified = false,
  entrySafetyTrusted = null,
  scoreMin = 80
} = {}) {
  if (!selected || typeof selected !== 'object') return [];

  const details = detailsOf(selected);
  const reasonText = textOfReasons(selected.blocked_reasons);
  const score = safeNum(selected.score);
  const minimumScore = Math.max(80, safeNum(scoreMin) ?? 80);
  const stageKnown = typeof selected.stage === 'string' && selected.stage.trim() !== '';
  const confirmed = stageKnown && score !== null
    ? status(true, selected.stage === 'CONFIRMED' && score >= minimumScore)
    : status(false, false);

  const symbol = String(selected.symbol || '').trim().toUpperCase();
  const routeSet = Array.isArray(routedSymbols)
    ? new Set(routedSymbols.map(item => String(item || '').trim().toUpperCase()).filter(Boolean))
    : null;
  const routeBlockedByReason = hasReason(reasonText, 'route unavailable');
  const routeStatus = routeBlockedByReason || entrySafetyTrusted === false
    ? GATE_BLOCK
    : routeDataVerified && routeSet && symbol
      ? status(true, routeSet.has(symbol))
      : GATE_UNKNOWN;

  const feeRiskRatio = safeNum(selected.fee_risk_ratio);
  const feeRiskLimit = selected.strategy === 'SCALPING' ? 0.25 : 0.20;
  const feeStatus = hasReason(reasonText, 'fee') || hasReason(reasonText, 'cost ratio')
    ? GATE_BLOCK
    : feeRiskRatio !== null
      ? status(true, feeRiskRatio <= feeRiskLimit)
      : hasReason(reasonText, 'spread')
        ? GATE_BLOCK
        : GATE_UNKNOWN;

  const change24h = safeNum(selected.change_24h);
  const side = String(selected.side || '').toUpperCase();
  const antiChaseKnown = change24h !== null && (side === 'BUY' || side === 'SELL');
  const antiChasePass = side === 'BUY' ? change24h <= 15 : side === 'SELL' ? change24h >= -15 : false;
  const antiChaseStatus = hasReason(reasonText, 'anti-chase')
    ? GATE_BLOCK
    : antiChaseKnown
      ? status(true, antiChasePass)
      : GATE_UNKNOWN;

  const strategy = String(selected.strategy || '').trim().toUpperCase();
  const momentumStrategy = strategy === 'MOMENTUM';
  const scalpStrategy = strategy === 'SCALP' || strategy === 'SCALPING';
  const supportedStrategy = momentumStrategy || scalpStrategy;
  const rangeLimit = momentumStrategy ? 4 : 3;
  const emaDistanceLimit = momentumStrategy ? 3.5 : 2.5;

  // The worker persists these exact observation keys. Legacy aliases remain
  // read-only compatibility fallbacks; missing observations fail closed.
  const rangeAtr = safeNum(details.rangeAtr ?? details.rangeAtrRatio ?? details.range_atr_ratio);
  const rangeBlocked = hasReason(reasonText, '5m range') || hasReason(reasonText, 'range >');
  const rangeStatus = rangeBlocked || rangeAtr === null || !supportedStrategy
    ? GATE_BLOCK
    : status(true, rangeAtr <= rangeLimit);
  const rangeBlockReason = rangeBlocked
    ? 'Worker reported the 5m range blocker'
    : rangeAtr === null
      ? 'Cached rangeAtr observation missing; dashboard fails closed'
      : !supportedStrategy
        ? 'Strategy missing or unsupported; cannot select a matching range threshold'
        : rangeStatus === GATE_BLOCK
          ? 'Observed range/ATR exceeds the selected strategy limit'
          : '';

  const emaDistance = safeNum(details.emaDistanceAtr ?? details.ema21DistanceAtr ?? details.ema_distance_atr);
  const emaBlocked = hasReason(reasonText, 'price >') || hasReason(reasonText, 'EMA21 distance');
  const emaStatus = emaBlocked || emaDistance === null || !supportedStrategy
    ? GATE_BLOCK
    : status(true, emaDistance <= emaDistanceLimit);
  const emaBlockReason = emaBlocked
    ? 'Worker reported the EMA-distance blocker'
    : emaDistance === null
      ? 'Cached emaDistanceAtr observation missing; dashboard fails closed'
      : !supportedStrategy
        ? 'Strategy missing or unsupported; cannot select a matching EMA threshold'
        : emaStatus === GATE_BLOCK
          ? 'Observed EMA21 distance/ATR exceeds the selected strategy limit'
          : '';

  const btcOverride = details.btcRegimeOverride === true;
  const btcStatus = btcOverride
    ? GATE_PASS
    : hasReason(reasonText, 'BTC regime') ? GATE_BLOCK : GATE_UNKNOWN;

  const spreadPct = safeNum(selected.spread_pct);
  const spreadStatus = hasReason(reasonText, 'spread >') || hasReason(reasonText, 'spread too wide')
    ? GATE_BLOCK
    : spreadPct !== null
      ? status(true, spreadPct <= 0.35)
      : hasReason(reasonText, 'spread') ? GATE_BLOCK : GATE_UNKNOWN;

  const candlesFresh = details.candlesFresh;
  const freshnessStatus = hasReason(reasonText, 'fresh closed candles') || hasReason(reasonText, 'stale candle')
    ? GATE_BLOCK
    : typeof candlesFresh === 'boolean'
      ? status(true, candlesFresh)
      : GATE_UNKNOWN;

  const healthValues = [
    health?.workerLeaseActive,
    health?.exchangeHealthy,
    health?.tickFresh
  ];
  const healthKnown = healthValues.every(value => typeof value === 'boolean');
  const healthStatus = healthKnown
    ? status(true, healthValues.every(value => value === true))
    : healthValues.some(value => value === false)
      ? GATE_BLOCK
      : GATE_UNKNOWN;

  const positionsKnown = Array.isArray(positions) && Boolean(symbol);
  const duplicatePosition = positionsKnown && positions.some(position =>
    String(position?.symbol || '').trim().toUpperCase() === symbol &&
    (safeNum(position?.qty ?? position?.quantity) ?? 0) !== 0
  );
  // The backend can reserve a symbol while a signal is pending even when no
  // position row exists yet; preserve that explicit blocker in the inspector.
  const duplicateStatus = hasReason(reasonText, 'duplicate symbol')
    ? GATE_BLOCK
    : positionsKnown
      ? status(true, !duplicatePosition)
      : GATE_UNKNOWN;

  const qty = safeNum(selected.qty_contracts);
  const notional = safeNum(selected.notional);
  const marginStatus = qty !== null && notional !== null
    ? status(true, qty >= 1 && notional > 0)
    : GATE_UNKNOWN;

  return [
    gateResult({ gate: 'Signal CONFIRMED', result: confirmed, observedValue: selected.stage || null, unit: 'stage', threshold: minimumScore, thresholdUnit: 'minimum score', blockReason: confirmed === GATE_BLOCK ? 'Signal stage/score does not satisfy entry criteria' : '' }),
    gateResult({ gate: 'Tradetron futures route', result: routeStatus, observedValue: symbol || null, unit: 'symbol', blockReason: routeStatus === GATE_BLOCK ? (entrySafetyTrusted === false ? 'Fresh complete Tradetron position snapshot is unavailable; new entries fail closed' : 'Symbol has no usable Tradetron route') : routeStatus === GATE_UNKNOWN ? 'Worker-confirmed route data unavailable' : '' }),
    gateResult({ gate: 'Fee + spread vs 1R', result: feeStatus, observedValue: feeRiskRatio, unit: 'R', threshold: feeRiskLimit, thresholdUnit: 'R', blockReason: feeStatus === GATE_BLOCK ? 'Fee/spread cost exceeds configured limit or is explicitly blocked' : feeStatus === GATE_UNKNOWN ? 'Cost ratio missing' : '' }),
    gateResult({ gate: '24h anti-chase', result: antiChaseStatus, observedValue: change24h, unit: '%', threshold: side === 'BUY' ? 15 : -15, thresholdUnit: '%', blockReason: antiChaseStatus === GATE_BLOCK ? 'Anti-chase gate blocked' : antiChaseStatus === GATE_UNKNOWN ? '24h change or side missing' : '' }),
    gateResult({ gate: `5m range <= ${rangeLimit} ATR`, result: rangeStatus, observedValue: rangeAtr, unit: 'ATR', threshold: rangeLimit, thresholdUnit: 'ATR', blockReason: rangeBlockReason }),
    gateResult({ gate: `EMA21 distance <= ${emaDistanceLimit.toFixed(2)} ATR`, result: emaStatus, observedValue: emaDistance, unit: 'ATR', threshold: emaDistanceLimit, thresholdUnit: 'ATR', blockReason: emaBlockReason }),
    gateResult({ gate: 'BTC regime', result: btcStatus, observedValue: selected.btc_trend ?? null, blockReason: btcStatus === GATE_BLOCK ? 'BTC regime gate blocked' : btcStatus === GATE_UNKNOWN ? 'A trend label alone does not prove the regime gate passed' : 'Explicit adaptive override supplied' }),
    gateResult({ gate: 'Spread', result: spreadStatus, observedValue: spreadPct, unit: '%', threshold: 0.35, thresholdUnit: '%', blockReason: spreadStatus === GATE_BLOCK ? 'Spread above limit or explicitly blocked' : spreadStatus === GATE_UNKNOWN ? 'Spread observation missing' : '' }),
    gateResult({ gate: 'Fresh closed candles', result: freshnessStatus, observedValue: candlesFresh ?? null, blockReason: freshnessStatus === GATE_BLOCK ? 'Candle freshness blocked' : freshnessStatus === GATE_UNKNOWN ? 'Candle freshness was not supplied' : '' }),
    gateResult({ gate: 'API / worker healthy', result: healthStatus, blockReason: healthStatus === GATE_BLOCK ? 'At least one health check explicitly failed' : healthStatus === GATE_UNKNOWN ? 'One or more health checks unavailable' : '' }),
    gateResult({ gate: 'Duplicate symbol', result: duplicateStatus, observedValue: symbol || null, blockReason: duplicateStatus === GATE_BLOCK ? 'An open position already uses this symbol' : duplicateStatus === GATE_UNKNOWN ? 'Position data or symbol unavailable' : '' }),
    gateResult({ gate: 'Margin / min size', result: marginStatus, observedValue: qty, unit: 'contracts', threshold: 1, thresholdUnit: 'contract', blockReason: marginStatus === GATE_BLOCK ? 'Quantity or notional fails the minimum-size check' : marginStatus === GATE_UNKNOWN ? 'Quantity or notional missing' : '' })
  ];
}
