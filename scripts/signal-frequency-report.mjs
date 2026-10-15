#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const SCORE_BANDS = [
  { label: '0–<40', min: 0, max: 40, includeMax: false },
  { label: '40–<70', min: 40, max: 70, includeMax: false },
  { label: '70–<85', min: 70, max: 85, includeMax: false },
  { label: '85–100', min: 85, max: 100, includeMax: true }
];
const BLOCK_TYPES = [
  'No directional trigger', 'Signal score below threshold', 'RSI/VWAP',
  'Volume spike', 'Anti-chase', 'Entry candle range', 'EMA distance',
  'BTC regime', 'Fee+spread', 'Spread', 'Invalid price/stop'
];

function parseArgs(argv) {
  const result = { signals: 'signals.json', fills: 'fills.json', events: 'events.json', output: 'signal-frequency-report.json' };
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error('Arguments must use --name=value format.');
    const split = arg.slice(2).split('=');
    const key = split.shift();
    const value = split.join('=');
    if (!['signals', 'fills', 'events', 'output'].includes(key) || !value) throw new Error('Unsupported or empty argument: ' + key);
    result[key] = value;
  }
  return result;
}

function readRows(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error('Unable to read or parse ' + label + ' input: ' + filePath);
  }
  if (Array.isArray(parsed)) return parsed.filter(row => row && typeof row === 'object' && !Array.isArray(row));
  for (const key of ['rows', 'data', label]) {
    if (parsed && Array.isArray(parsed[key])) return parsed[key].filter(row => row && typeof row === 'object' && !Array.isArray(row));
  }
  throw new Error(label + ' input must be a JSON array or a wrapper containing rows/data/' + label + '.');
}

function dateMs(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}
function utcDate(value) {
  const ms = dateMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}
function stageOf(row) {
  return String(row?.stage || 'UNKNOWN').trim().toUpperCase();
}
function strategyOf(row) {
  const value = String(row?.strategy || 'UNKNOWN').trim().toUpperCase();
  if (value.includes('MOMENTUM')) return 'MOMENTUM';
  if (value.includes('SCALP')) return 'SCALPING';
  if (value.includes('OPTION')) return 'OPTIONS';
  return value || 'UNKNOWN';
}
function symbolOf(row) {
  return String(row?.symbol || '').trim().toUpperCase();
}
function sideOf(row) {
  return String(row?.side || '').trim().toUpperCase();
}
function detailsOf(row) {
  const value = row?.details;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}
function scalarReason(item) {
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item && typeof item === 'object') {
    const value = item.reason ?? item.message ?? item.code ?? item.blockedReason ?? item.name;
    if (value !== undefined && value !== null) return String(value).trim();
    return Object.entries(item).filter(([, v]) => v === true).map(([k]) => k).join(', ');
  }
  return '';
}
function parseReasons(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return source.trim() ? [source.trim()] : []; }
  }
  if (Array.isArray(source)) return source.map(scalarReason).filter(Boolean);
  if (source && typeof source === 'object') {
    for (const key of ['reasons', 'blocked', 'items']) {
      if (Array.isArray(source[key])) return source[key].map(scalarReason).filter(Boolean);
    }
    const text = scalarReason(source);
    if (text) return [text];
    return Object.entries(source).filter(([, v]) => v === true).map(([k]) => k);
  }
  return [];
}
function isEmptyReasons(value) {
  return parseReasons(value).length === 0;
}
function categorizeReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (/no directional trigger|directional trigger|no trigger/.test(text)) return 'No directional trigger';
  if (/score.*below|below.*score|score.*threshold/.test(text)) return 'Signal score below threshold';
  if (/rsi|vwap/.test(text)) return 'RSI/VWAP';
  if (/volume|spike/.test(text)) return 'Volume spike';
  if (/anti.?chase|24.?h/.test(text)) return 'Anti-chase';
  if (/entry candle|candle.*range|range.*atr/.test(text)) return 'Entry candle range';
  if (/ema.*distance|distance.*ema/.test(text)) return 'EMA distance';
  if (/\bbtc\b|btc regime|btc compatibility/.test(text)) return 'BTC regime';
  if (/fee.*spread|spread.*fee|cost.*risk|1r cost/.test(text)) return 'Fee+spread';
  if (/spread/.test(text)) return 'Spread';
  if (/invalid.*(price|stop)|price.*stop/.test(text)) return 'Invalid price/stop';
  return String(reason || 'Unknown reason').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Unknown reason';
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function round(value, places = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(places));
}
function scoreBand(score) {
  if (score === null || score === undefined || score === '') return null;
  const value = Number(score);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return SCORE_BANDS.find(band => value >= band.min && (band.includeMax ? value <= band.max : value < band.max))?.label ?? null;
}
function countMap(entries, keyFn) {
  const output = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    output.set(key, (output.get(key) || 0) + 1);
  }
  return output;
}
function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
function coverage(rows, field, nowMs) {
  const times = rows.map(row => dateMs(row?.[field])).filter(value => value !== null);
  const min = times.length ? Math.min(...times) : null;
  const max = times.length ? Math.max(...times) : null;
  return {
    rows: rows.length,
    validTimestampRows: times.length,
    min: min === null ? null : new Date(min).toISOString(),
    max: max === null ? null : new Date(max).toISOString(),
    observedSpanDays: min === null || max === null ? null : round((max - min) / DAY_MS),
    oldestRowAgeDays: min === null ? null : round(Math.max(0, nowMs - min) / DAY_MS),
    timestampCoveragePct: rows.length ? round((times.length / rows.length) * 100) : null
  };
}
function rowHasCorrelationKeys(row, timeField) {
  return Boolean(symbolOf(row) && dateMs(row?.[timeField]) !== null);
}
function compatibleSide(source, target) {
  const a = sideOf(source);
  const b = sideOf(target);
  return !a || !b || a === b;
}

function correlateUnique(sources, targets, options) {
  const sourceTime = options.sourceTime;
  const targetTime = options.targetTime;
  const windowMs = options.windowMs;
  const sourceEligible = sources.filter(row => rowHasCorrelationKeys(row, sourceTime));
  const targetEligible = targets.filter(row => rowHasCorrelationKeys(row, targetTime));
  const candidateMap = new Map();
  const reverseMap = new Map();

  sourceEligible.forEach((source, sourceIndex) => {
    const timestamp = dateMs(source[sourceTime]);
    const candidates = [];
    targetEligible.forEach((target, targetIndex) => {
      if (symbolOf(source) !== symbolOf(target) || !compatibleSide(source, target)) return;
      const delta = Math.abs(dateMs(target[targetTime]) - timestamp);
      if (delta <= windowMs) candidates.push({ target, targetIndex, delta });
    });
    candidateMap.set(sourceIndex, candidates);
    for (const candidate of candidates) {
      if (!reverseMap.has(candidate.targetIndex)) reverseMap.set(candidate.targetIndex, []);
      reverseMap.get(candidate.targetIndex).push(sourceIndex);
    }
  });

  const definite = [];
  const ambiguousSources = new Set();
  for (const [sourceIndex, candidates] of candidateMap.entries()) {
    if (!candidates.length) continue;
    if (candidates.length !== 1 || (reverseMap.get(candidates[0].targetIndex) || []).length !== 1) {
      ambiguousSources.add(sourceIndex);
      continue;
    }
    definite.push({ source: sourceEligible[sourceIndex], target: candidates[0].target, deltaMs: candidates[0].delta });
  }
  const unmatchedCount = sourceEligible.length - definite.length - ambiguousSources.size;
  const missingSourceKeys = sources.length - sourceEligible.length;
  const missingTargetKeys = targets.length - targetEligible.length;
  let nearestGapOver15Minutes = 0;
  if (options.checkLongGaps) {
    for (const source of sourceEligible) {
      let nearest = Infinity;
      for (const target of targetEligible) {
        if (symbolOf(source) !== symbolOf(target) || !compatibleSide(source, target)) continue;
        nearest = Math.min(nearest, Math.abs(dateMs(target[targetTime]) - dateMs(source[sourceTime])));
      }
      if (nearest > 15 * MINUTE_MS && nearest <= 60 * MINUTE_MS) nearestGapOver15Minutes += 1;
    }
  }

  const sourceKeyCoverage = sources.length ? sourceEligible.length / sources.length : 0;
  const targetKeyCoverage = targets.length ? targetEligible.length / targets.length : 0;
  const ambiguousPct = sourceEligible.length ? ambiguousSources.size / sourceEligible.length : 0;
  const unreliable = !sources.length || !targets.length || sourceKeyCoverage < 0.8 ||
    targetKeyCoverage < 0.8 || ambiguousSources.size > 0 || nearestGapOver15Minutes > 0;
  let confidence = 'UNKNOWN';
  if (sources.length && targets.length && sourceEligible.length && targetEligible.length) {
    const matchPct = definite.length / Math.max(1, sourceEligible.length);
    if (unreliable || ambiguousPct > 0) confidence = 'LOW';
    else if (matchPct >= 0.9 && sourceKeyCoverage >= 0.9 && targetKeyCoverage >= 0.9) confidence = 'HIGH';
    else if (matchPct >= 0.5) confidence = 'MEDIUM';
    else confidence = 'LOW';
  }
  return {
    count: unreliable ? 'UNKNOWN' : definite.length,
    confidence,
    unreliable,
    definite,
    definiteCount: definite.length,
    ambiguousCount: ambiguousSources.size,
    unmatchedCount,
    sourceRows: sources.length,
    sourceRowsWithKeys: sourceEligible.length,
    targetRows: targets.length,
    targetRowsWithKeys: targetEligible.length,
    missingSourceKeys,
    missingTargetKeys,
    nearestGapOver15Minutes,
    notes: unreliable
      ? 'UNKNOWN: correlation coverage is insufficient, identifiers/timestamps are missing, a match is ambiguous, a nearby gap exceeds 15 minutes, or the target export is empty.'
      : 'Heuristic symbol/side and timestamp correlation; not a definitive execution identifier match.'
  };
}

function pct(value, denominator) {
  return denominator ? round((value / denominator) * 100) : null;
}
function countDisplay(value) {
  return value === 'UNKNOWN' ? 'UNKNOWN' : String(value);
}
function fmtPct(value) {
  return value === null || value === undefined ? 'N/A' : Number(value).toFixed(1) + '%';
}
function fmtNum(value, places = 2) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? 'N/A' : Number(value).toFixed(places);
}
function safeCell(value) {
  return String(value === null || value === undefined || value === '' ? '—' : value)
    .replace(/[\r\n\t|]/g, ' ')
    .slice(0, 70);
}
function renderTable(title, headers, rows, maxWidth = 34) {
  console.log(title);
  if (!rows.length) rows = [['No rows']];
  const matrix = [headers, ...rows].map(row => row.map(cell => safeCell(cell)));
  const widths = headers.map((header, index) => Math.min(maxWidth, Math.max(String(header).length, ...matrix.map(row => (row[index] || '').length))));
  const line = row => '| ' + row.map((cell, index) => cell.padEnd(widths[index], ' ')).join(' | ') + ' |';
  console.log(line(headers));
  console.log('|-' + widths.map(width => '-'.repeat(width)).join('-|-') + '-|');
  for (const row of matrix.slice(1)) console.log(line(headers.map((_, index) => (row[index] || '').slice(0, widths[index]))));
  console.log('');
}
function summaryAction(confirmedPerDay, activeDays, coverageDays, confirmedCount, fillsCount, funnel, signalsCount) {
  const actions = [];
  if (!signalsCount) {
    actions.push('Insufficient dd_signals data. Verify DATABASE_URL, table population, and retention before changing the score.');
    return actions;
  }
  if (coverageDays !== null && coverageDays < 7) {
    actions.push('Data window is short (' + coverageDays + ' covered day(s)); collect more history before recalibrating.');
  }
  if (confirmedPerDay === null) {
    actions.push('CONFIRMED/day is unavailable because signal timestamps are missing.');
  } else if (confirmedPerDay <= 2) {
    actions.push('CONFIRMED/day is about 0–2: review restrictive gates and data-window coverage before considering a score change.');
  } else if (confirmedPerDay <= 10) {
    actions.push('CONFIRMED/day is 3–10: broadly consistent with the requested initial target for ₹5,000 capital; validate fill quality before recalibrating.');
  } else {
    actions.push('CONFIRMED/day is above 10: investigate over-signaling and consider a reviewed score/gate recalibration; do not change live settings automatically.');
  }
  if (confirmedCount > 0 && funnel?.tradetron?.count === 'UNKNOWN') {
    actions.push('Tradetron event correlation is UNKNOWN. Do not interpret it as zero events; inspect identifiers and event timestamp coverage. A correlated event is not proof of outbound signal delivery.');
  } else if (confirmedCount > 0 && typeof funnel?.tradetron?.count === 'number' &&
             funnel.tradetron.count < confirmedCount * 0.5) {
    actions.push('CONFIRMED observations substantially exceed correlated Tradetron event rows; inspect event coverage and duplicate signal observations. Event-table correlation is not proof of outbound delivery.');
  }
  if (confirmedCount > 0 && fillsCount > confirmedCount * 2) {
    actions.push('Recorded fill rows exceed CONFIRMED observations by more than 2×. Investigate time-window/data-integrity mismatch; multiple partial fills per trade may explain some of the difference.');
  }
  if (activeDays !== null && activeDays < 7) {
    actions.push('Only ' + activeDays + ' calendar day(s) contain observations. Treat daily averages as provisional.');
  }
  actions.push('Keep score/gate and live-trading configuration unchanged until this report has been reviewed.');
  return actions;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const signals = readRows(args.signals, 'signals');
  const fills = readRows(args.fills, 'fills');
  const events = readRows(args.events, 'events');
  const now = Date.now();
  const signalCoverage = coverage(signals, 'captured_at', now);
  const fillCoverage = coverage(fills, 'created_at', now);
  const eventCoverage = coverage(events, 'event_at', now);
  const validSignalTimes = signals.map(row => dateMs(row.captured_at)).filter(value => value !== null);
  const validMin = validSignalTimes.length ? Math.min(...validSignalTimes) : null;
  const validMax = validSignalTimes.length ? Math.max(...validSignalTimes) : null;
  const allSymbolSet = new Set(signals.map(symbolOf).filter(Boolean));
  const allStrategySet = new Set(signals.map(strategyOf).filter(Boolean));
  const symbolStrategySet = new Set(signals.filter(row => symbolOf(row) && strategyOf(row))
    .map(row => symbolOf(row) + '|' + strategyOf(row)));
  const uniqueSymbolSideSet = new Set(signals.filter(row => symbolOf(row) && sideOf(row))
    .map(row => symbolOf(row) + '|' + strategyOf(row) + '|' + sideOf(row)));
  const confirmed = signals.filter(row => stageOf(row) === 'CONFIRMED');
  const stageCounts = countMap(signals, stageOf);
  const strategyCounts = countMap(signals, strategyOf);
  const readyConfirmed = confirmed.filter(row => row.ready === true && isEmptyReasons(row.blocked_reasons));
  const readinessKnownCount = confirmed.filter(row => typeof row.ready === 'boolean' && row.blocked_reasons !== undefined && row.blocked_reasons !== null).length;
  const readinessUnknownCount = confirmed.length - readinessKnownCount;
  const readinessStepCount = readinessKnownCount === confirmed.length ? readyConfirmed.length : 'UNKNOWN';

  const bandCounts = rows => {
    const counts = Object.fromEntries(SCORE_BANDS.map(band => [band.label, 0]));
    let valid = 0;
    let invalid = 0;
    for (const row of rows) {
      const band = scoreBand(row.score);
      if (band) {
        counts[band] += 1;
        valid += 1;
      } else {
        invalid += 1;
      }
    }
    return { counts, validScores: valid, missingOrOutOfRange: invalid, totalRows: rows.length };
  };
  const allScoreBands = bandCounts(signals);
  const confirmedScoreBands = bandCounts(confirmed);

  const strategyBlockCounts = new Map();
  const strategyReasonCounts = new Map();
  let persistedReasonOccurrences = 0;
  for (const row of signals) {
    const strategy = strategyOf(row);
    const reasons = parseReasons(row.blocked_reasons).map(categorizeReason);
    for (const reason of reasons) {
      persistedReasonOccurrences += 1;
      strategyBlockCounts.set(reason, (strategyBlockCounts.get(reason) || 0) + 1);
      const key = strategy + '|' + reason;
      strategyReasonCounts.set(key, (strategyReasonCounts.get(key) || 0) + 1);
    }
  }
  const engineBlockCounts = new Map();
  let engineReasonOccurrences = 0;
  let rowsWithDetailsBlocked = 0;
  for (const row of signals) {
    const blocked = detailsOf(row).blocked;
    const reasons = parseReasons(blocked);
    if (blocked !== undefined && blocked !== null) rowsWithDetailsBlocked += 1;
    for (const reason of reasons) {
      engineReasonOccurrences += 1;
      engineBlockCounts.set(categorizeReason(reason), (engineBlockCounts.get(categorizeReason(reason)) || 0) + 1);
    }
  }
  const topStrategyReasons = sortedCounts(strategyBlockCounts).slice(0, 10);
  const topEngineReasons = sortedCounts(engineBlockCounts).slice(0, 10);
  const topByStrategy = sortedCounts(strategyReasonCounts).slice(0, 100).map(([key, count]) => {
    const split = key.indexOf('|');
    return { strategy: key.slice(0, split), reason: key.slice(split + 1), count };
  });

  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const currentUtcMidnight = Date.parse(todayUtc + 'T00:00:00.000Z');
  const firstQueryDate = new Date(now - 29 * DAY_MS).toISOString().slice(0, 10);
  const firstQueryMidnight = Date.parse(firstQueryDate + 'T00:00:00.000Z');
  const dailyRows = [];
  for (let timestamp = firstQueryMidnight; timestamp <= currentUtcMidnight; timestamp += DAY_MS) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    dailyRows.push({ date, total: 0, confirmed: 0, momentum: 0, scalping: 0 });
  }
  const dailyMap = new Map(dailyRows.map(row => [row.date, row]));
  for (const row of signals) {
    const date = utcDate(row.captured_at);
    const target = date ? dailyMap.get(date) : null;
    if (!target) continue;
    target.total += 1;
    if (stageOf(row) === 'CONFIRMED') {
      target.confirmed += 1;
      const strategy = strategyOf(row);
      if (strategy === 'MOMENTUM') target.momentum += 1;
      if (strategy === 'SCALPING') target.scalping += 1;
    }
  }
  const observedDateRows = dailyRows.filter(row => row.total > 0);
  const activeDayCount = observedDateRows.length;
  const signalDayValues = observedDateRows.map(row => row.total);
  const confirmedDayValues = observedDateRows.map(row => row.confirmed);
  const totalDayValues = dailyRows.map(row => row.total);
  const confirmedCalendarValues = dailyRows.map(row => row.confirmed);
  const activeDateSpan = validMin === null || validMax === null
    ? null
    : Math.max(1, Math.floor((Date.parse(new Date(validMax).toISOString().slice(0, 10) + 'T00:00:00.000Z') -
                             Date.parse(new Date(validMin).toISOString().slice(0, 10) + 'T00:00:00.000Z')) / DAY_MS) + 1);
  const confirmedCount = confirmed.length;
  const confirmedPerDay = activeDayCount ? confirmedCount / activeDayCount : (signals.length ? 0 : null);
  const actualRetentionDays = signalCoverage.oldestRowAgeDays;
  const dataSpanDays = signalCoverage.observedSpanDays;

  const eventCorrelation = correlateUnique(readyConfirmed, events, {
    sourceTime: 'captured_at', targetTime: 'event_at', windowMs: 5 * MINUTE_MS, checkLongGaps: true
  });
  eventCorrelation.notes += ' dd_tradetron_events stores received/synchronized events in this schema; a match is not proof of outbound notification delivery.';
  let fillCorrelation;
  if (eventCorrelation.count === 'UNKNOWN') {
    fillCorrelation = {
      count: 'UNKNOWN', confidence: 'UNKNOWN', unreliable: true, definite: [], definiteCount: 0,
      ambiguousCount: null, unmatchedCount: null, sourceRows: eventCorrelation.definiteCount,
      targetRows: fills.length, notes: 'UNKNOWN because the preceding signal-to-Tradetron correlation is UNKNOWN.'
    };
  } else if (eventCorrelation.count === 0) {
    fillCorrelation = {
      count: 'UNKNOWN', confidence: 'UNKNOWN', unreliable: true, definite: [], definiteCount: 0,
      ambiguousCount: null, unmatchedCount: null, sourceRows: 0, targetRows: fills.length,
      notes: 'UNKNOWN because there are no uniquely correlated Tradetron signal events to follow through to fills.'
    };
  } else {
    const deliveredSignalRows = eventCorrelation.definite.map(pair => pair.source);
    fillCorrelation = correlateUnique(deliveredSignalRows, fills, {
      sourceTime: 'captured_at', targetTime: 'created_at', windowMs: 15 * MINUTE_MS, checkLongGaps: true
    });
    if (fillCorrelation.count === 'UNKNOWN') {
      fillCorrelation.notes = 'UNKNOWN: fill-to-signal symbol/side/timestamp correlation is unreliable; direct order/execution linkage is not included in the requested export.';
    } else {
      fillCorrelation.notes = 'Heuristic: unique symbol/compatible-side fill within ±15 minutes of a uniquely correlated delivered signal. Partial fills can create many-to-one relationships.';
    }
  }

  const funnelRows = [
    { stage: '1. CONFIRMED observations', count: confirmedCount, pctPrevious: null, notes: 'Rows with stage exactly CONFIRMED; observations, not unique trades.' },
    { stage: '2. ready=true and no blockers', count: readinessStepCount, pctPrevious: typeof readinessStepCount === 'number' ? pct(readinessStepCount, confirmedCount) : null, notes: readinessStepCount === 'UNKNOWN' ? 'UNKNOWN: readiness/blocker fields are missing for ' + readinessUnknownCount + ' CONFIRMED row(s).' : 'Requires ready=true and an empty blocked_reasons array.' },
    { stage: '3. Tradetron event correlated', count: readinessStepCount === 'UNKNOWN' ? 'UNKNOWN' : (readinessStepCount === 0 ? 'UNKNOWN' : eventCorrelation.count), pctPrevious: null, notes: eventCorrelation.notes },
    { stage: '4. Recorded fill correlated', count: readinessStepCount === 'UNKNOWN' ? 'UNKNOWN' : (readinessStepCount === 0 ? 'UNKNOWN' : fillCorrelation.count), pctPrevious: null, notes: fillCorrelation.notes }
  ];
  funnelRows[2].pctPrevious = typeof funnelRows[2].count === 'number' ? pct(funnelRows[2].count, typeof readinessStepCount === 'number' ? readinessStepCount : 0) : null;
  funnelRows[3].pctPrevious = typeof funnelRows[3].count === 'number' ? pct(funnelRows[3].count, typeof funnelRows[2].count === 'number' ? funnelRows[2].count : 0) : null;

  const correlationConfidence = readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ||
    eventCorrelation.count === 'UNKNOWN' || fillCorrelation.count === 'UNKNOWN'
    ? 'UNKNOWN'
    : (eventCorrelation.confidence === 'LOW' || fillCorrelation.confidence === 'LOW'
      ? 'LOW'
      : (eventCorrelation.confidence === 'MEDIUM' || fillCorrelation.confidence === 'MEDIUM' ? 'MEDIUM' : 'HIGH'));
  const report = {
    generatedAt: new Date(now).toISOString(),
    queryWindow: { requestedDays: 30, signalLimit: 100000, fillLimit: 10000, eventLimit: 10000 },
    dataCoverage: {
      dd_signals: { ...signalCoverage, uniqueSymbols: allSymbolSet.size, uniqueStrategies: allStrategySet.size, uniqueSymbolStrategyCombos: symbolStrategySet.size, retentionInterpretation: 'age of oldest exported row; the configured retention policy itself is not known' },
      dd_fills: { ...fillCoverage, retentionInterpretation: 'age of oldest exported row; the configured retention policy itself is not known' },
      dd_tradetron_events: { ...eventCoverage, retentionInterpretation: 'age of oldest exported row; the configured retention policy itself is not known' },
      observedSignalSpanDays: dataSpanDays,
      actualSignalRetentionDays: actualRetentionDays
    },
    signalObservations: {
      total: signals.length,
      uniqueSymbols: allSymbolSet.size,
      uniqueSymbolStrategySideTuples: uniqueSymbolSideSet.size,
      stageBreakdown: Object.fromEntries([...stageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([stage, count]) => [stage, { count, pct: pct(count, signals.length) }])),
      strategyBreakdown: Object.fromEntries([...strategyCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([strategy, count]) => [strategy, { count, pct: pct(count, signals.length) }]))
    },
    signalFrequency: {
      observationPerDay: {
        averageOnObservedDays: activeDayCount ? round(signalDayValues.reduce((sum, value) => sum + value, 0) / activeDayCount) : null,
        medianOnObservedDays: round(median(signalDayValues)),
        maxOnObservedDays: signalDayValues.length ? Math.max(...signalDayValues) : null,
        observedDays: activeDayCount,
        avgAcrossFull30CalendarDays: round(totalDayValues.reduce((sum, value) => sum + value, 0) / 30)
      },
      confirmedPerDay: {
        averageOnObservedDays: activeDayCount ? round(confirmedPerDay) : null,
        medianOnObservedDays: round(median(confirmedDayValues)),
        maxOnObservedDays: confirmedDayValues.length ? Math.max(...confirmedDayValues) : null,
        observedDays: activeDayCount,
        avgAcrossFull30CalendarDays: round(confirmedCalendarValues.reduce((sum, value) => sum + value, 0) / 30)
      },
      dailyConfirmedLast30Days: dailyRows.map(row => ({ date: row.date, confirmed: row.confirmed, momentum: row.momentum, scalping: row.scalping }))
    },
    scoreDistribution: {
      bandBoundaries: '0–<40, 40–<70, 70–<85, 85–100 (upper edge included only for final band)',
      allObservations: allScoreBands,
      confirmedOnly: confirmedScoreBands
    },
    blockReasons: {
      level1PersistedBlockedReasons: {
        sourceField: 'dd_signals.blocked_reasons',
        sourceNote: 'Counts are kept separate from details.blocked. In the current engine persistence path, this field may reflect downstream gate reasons; do not assume every reason is generated by the strategy itself.',
        totalReasonOccurrences: persistedReasonOccurrences,
        top10: topStrategyReasons.map(([reason, count]) => ({ reason, count })),
        byStrategy: topByStrategy
      },
      level2DetailsBlocked: {
        sourceField: 'dd_signals.details.blocked',
        sourceNote: 'Counted independently when details.blocked is present; this is a strategy-evaluation field where emitted by the current strategy path.',
        rowsWithDetailsBlocked,
        totalReasonOccurrences: engineReasonOccurrences,
        top10: topEngineReasons.map(([reason, count]) => ({ reason, count }))
      },
      recognizedCategories: BLOCK_TYPES
    },
    funnel: {
      steps: funnelRows,
      confirmedCount,
      readyConfirmedCount: readinessStepCount,
      tradetronCorrelation: {
        sourceNote: 'A matching dd_tradetron_events row is only a correlation proxy; the table stores received/synchronized events and does not prove outbound signal delivery.',
        count: readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ? 'UNKNOWN' : eventCorrelation.count,
        confidence: readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ? 'UNKNOWN' : eventCorrelation.confidence,
        diagnostics: {
          sourceRows: eventCorrelation.sourceRows,
          sourceRowsWithKeys: eventCorrelation.sourceRowsWithKeys,
          targetRows: eventCorrelation.targetRows,
          targetRowsWithKeys: eventCorrelation.targetRowsWithKeys,
          definiteMatches: eventCorrelation.definiteCount,
          ambiguousMatches: eventCorrelation.ambiguousCount,
          unmatchedRows: eventCorrelation.unmatchedCount,
          missingSourceKeys: eventCorrelation.missingSourceKeys,
          missingTargetKeys: eventCorrelation.missingTargetKeys,
          nearestGapOver15Minutes: eventCorrelation.nearestGapOver15Minutes
        }
      },
      fillCorrelation: {
        count: readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ? 'UNKNOWN' : fillCorrelation.count,
        confidence: readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ? 'UNKNOWN' : fillCorrelation.confidence,
        diagnostics: {
          sourceRows: fillCorrelation.sourceRows,
          targetRows: fillCorrelation.targetRows,
          definiteMatches: fillCorrelation.definiteCount,
          ambiguousMatches: fillCorrelation.ambiguousCount,
          unmatchedRows: fillCorrelation.unmatchedCount,
          notes: fillCorrelation.notes
        }
      },
      correlationConfidence
    },
    summary: {
      confirmedPerObservedDay: round(confirmedPerDay),
      activeObservationDays: activeDayCount,
      observationDateSpanDays: activeDateSpan,
      recommendedActions: summaryAction(round(confirmedPerDay), activeDayCount, dataSpanDays, confirmedCount, fills.length, {
        tradetron: { count: readinessStepCount === 'UNKNOWN' || readinessStepCount === 0 ? 'UNKNOWN' : eventCorrelation.count }
      }, signals.length)
    }
  };

  const coverageRows = [
    ['dd_signals', signalCoverage.rows, signalCoverage.min || '—', signalCoverage.max || '—', signalCoverage.oldestRowAgeDays === null ? 'N/A' : signalCoverage.oldestRowAgeDays],
    ['dd_fills', fillCoverage.rows, fillCoverage.min || '—', fillCoverage.max || '—', fillCoverage.oldestRowAgeDays === null ? 'N/A' : fillCoverage.oldestRowAgeDays],
    ['dd_tradetron_events', eventCoverage.rows, eventCoverage.min || '—', eventCoverage.max || '—', eventCoverage.oldestRowAgeDays === null ? 'N/A' : eventCoverage.oldestRowAgeDays]
  ];
  console.log('SIGNAL FREQUENCY / QUALITY REPORT');
  console.log('Generated at: ' + report.generatedAt);
  console.log('Input files: ' + args.signals + ' | ' + args.fills + ' | ' + args.events);
  console.log('');
  renderTable('SECTION 1 — DATA COVERAGE (oldest-row age is observed retention; no policy assumed)', ['Source', 'Rows', 'Min timestamp', 'Max timestamp', 'Oldest age d'], coverageRows, 29);
  console.log('dd_signals unique symbols: ' + allSymbolSet.size);
  console.log('dd_signals unique strategies: ' + allStrategySet.size);
  console.log('dd_signals unique (symbol,strategy) combos: ' + symbolStrategySet.size);
  console.log('Observed signal timestamp span: ' + (dataSpanDays === null ? 'N/A' : dataSpanDays + ' days'));
  console.log('');
  renderTable('SECTION 2 — SIGNAL OBSERVATIONS', ['Metric', 'Count', '% of total'], [
    ['Total observations', signals.length, '100.0%'],
    ['Unique symbols', allSymbolSet.size, fmtPct(pct(allSymbolSet.size, signals.length))],
    ['Unique (symbol,strategy,side)', uniqueSymbolSideSet.size, fmtPct(pct(uniqueSymbolSideSet.size, signals.length))],
    ...[...stageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => ['Stage ' + key, value, fmtPct(pct(value, signals.length))]),
    ...[...strategyCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => ['Strategy ' + key, value, fmtPct(pct(value, signals.length))])
  ], 31);
  renderTable('SECTION 3 — FREQUENCY (averages on days with observations; zero-filled 30-calendar-day average shown in JSON)', ['Metric', 'Average/day', 'Median/day', 'Max/day', 'Days'], [
    ['All observations', fmtNum(report.signalFrequency.observationPerDay.averageOnObservedDays), fmtNum(report.signalFrequency.observationPerDay.medianOnObservedDays), report.signalFrequency.observationPerDay.maxOnObservedDays ?? 'N/A', activeDayCount],
    ['CONFIRMED only', fmtNum(report.signalFrequency.confirmedPerDay.averageOnObservedDays), fmtNum(report.signalFrequency.confirmedPerDay.medianOnObservedDays), report.signalFrequency.confirmedPerDay.maxOnObservedDays ?? 'N/A', activeDayCount]
  ], 26);
  renderTable('Daily CONFIRMED breakdown — last 30 UTC calendar days', ['Date', 'CONFIRMED', 'MOMENTUM', 'SCALPING'], report.signalFrequency.dailyConfirmedLast30Days.map(row => [row.date, row.confirmed, row.momentum, row.scalping]), 18);
  const scoreRows = SCORE_BANDS.map(band => [
    band.label,
    allScoreBands.counts[band.label],
    fmtPct(pct(allScoreBands.counts[band.label], allScoreBands.validScores)),
    confirmedScoreBands.counts[band.label],
    fmtPct(pct(confirmedScoreBands.counts[band.label], confirmedScoreBands.validScores))
  ]);
  renderTable('SECTION 4 — SCORE DISTRIBUTION (ALL vs CONFIRMED only; percentages use valid in-range scores)', ['Score band', 'ALL n', 'ALL %', 'CONFIRMED n', 'CONFIRMED %'], scoreRows, 21);
  console.log('Scores missing/out-of-range: ALL=' + allScoreBands.missingOrOutOfRange + '; CONFIRMED=' + confirmedScoreBands.missingOrOutOfRange);
  console.log('');
  renderTable('SECTION 5A — PERSISTED dd_signals.blocked_reasons (not merged with details.blocked)', ['Reason category', 'Count'], topStrategyReasons.map(([reason, count]) => [reason, count]), 40);
  console.log('Reason occurrences: ' + persistedReasonOccurrences + '; distinct reason categories: ' + strategyBlockCounts.size);
  renderTable('Most frequent persisted reason by strategy', ['Strategy', 'Reason category', 'Count'], topByStrategy.slice(0, 15).map(row => [row.strategy, row.reason, row.count]), 40);
  renderTable('SECTION 5B — details.blocked (independent strategy-evaluation field)', ['Reason category', 'Count'], topEngineReasons.map(([reason, count]) => [reason, count]), 40);
  console.log('Rows with details.blocked: ' + rowsWithDetailsBlocked + '; reason occurrences: ' + engineReasonOccurrences);
  console.log('');
  renderTable('SECTION 6 — SIGNAL TO ACTION FUNNEL', ['Stage', 'Count', '% previous', 'Notes'], funnelRows.map(row => [row.stage, countDisplay(row.count), fmtPct(row.pctPrevious), row.notes]), 45);
  console.log('Correlation confidence: ' + correlationConfidence);
  console.log('Tradetron correlation diagnostics: ' + JSON.stringify(report.funnel.tradetronCorrelation.diagnostics));
  console.log('Fill correlation diagnostics: ' + JSON.stringify(report.funnel.fillCorrelation.diagnostics));
  console.log('');
  console.log('SECTION 7 — SUMMARY & RECOMMENDED ACTION');
  console.log('CONFIRMED observations: ' + confirmedCount);
  console.log('CONFIRMED per observed day: ' + fmtNum(confirmedPerDay));
  console.log('Actual oldest signal age: ' + (actualRetentionDays === null ? 'N/A' : actualRetentionDays + ' days'));
  for (const action of report.summary.recommendedActions) console.log('- ' + action);
  console.log('');
  try {
    fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    throw new Error('Could not write JSON report output: ' + args.output);
  }
  console.log('JSON report written: ' + args.output);
}

try {
  main();
} catch (error) {
  console.error('Signal frequency report failed: ' + String(error?.message || 'unknown error'));
  process.exitCode = 1;
}
