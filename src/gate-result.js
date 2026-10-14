import { safeNum } from './formatters.js';

export const GATE_PASS = 'PASS';
export const GATE_BLOCK = 'BLOCK';
export const GATE_UNKNOWN = 'UNKNOWN';

const VALID_RESULTS = new Set([GATE_PASS, GATE_BLOCK, GATE_UNKNOWN]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function present(value, unit = '') {
  if (value === null || value === undefined || value === '') return null;
  const n = safeNum(value);
  const text = n === null ? String(value).trim() : String(n);
  if (!text || text === 'undefined' || text === 'null') return null;
  return text + (cleanText(unit) ? ' ' + cleanText(unit) : '');
}

function normalizeGate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      gate: 'UNKNOWN_GATE',
      result: GATE_UNKNOWN,
      observedValue: null,
      unit: '',
      threshold: null,
      thresholdUnit: '',
      blockReason: 'INVALID GATE RECORD',
      validRecord: false
    };
  }

  const gateName = cleanText(input.gate || input.name);
  const gate = gateName || 'UNKNOWN_GATE';
  const rawResult = cleanText(input.result).toUpperCase();
  const validResult = VALID_RESULTS.has(rawResult);
  const validRecord = validResult && Boolean(gateName);
  const result = validRecord ? rawResult : GATE_UNKNOWN;
  const observedValue = input.observedValue ?? input.observed_value ?? null;
  const threshold = input.threshold ?? input.limit ?? null;
  const blockReason = cleanText(input.blockReason || input.block_reason) ||
    (!gateName
      ? 'MISSING GATE NAME'
      : validResult ? '' : ('UNRECOGNIZED RESULT' + (rawResult ? ': ' + rawResult : '')));

  return {
    gate,
    result,
    observedValue,
    unit: cleanText(input.unit),
    threshold,
    thresholdUnit: cleanText(input.thresholdUnit || input.threshold_unit || input.unit),
    blockReason,
    validRecord
  };
}

export function gateResult(input = {}) {
  return normalizeGate(input);
}

export function gateTooltip(input) {
  const gate = normalizeGate(input);
  const detail = [];
  const observed = present(gate.observedValue, gate.unit);
  const limit = present(gate.threshold, gate.thresholdUnit);
  if (observed !== null) detail.push('observed ' + observed);
  if (limit !== null) detail.push('limit ' + limit);
  if (gate.blockReason) detail.push(gate.blockReason);
  return gate.gate + ': ' + gate.result + (detail.length ? ' — ' + detail.join('; ') : '');
}

function describeGate(gate) {
  const detail = [];
  const observed = present(gate.observedValue, gate.unit);
  const limit = present(gate.threshold, gate.thresholdUnit);
  if (observed !== null) detail.push('observed ' + observed);
  if (limit !== null) detail.push('limit ' + limit);
  if (gate.blockReason) detail.push(gate.blockReason);
  return gate.gate + (detail.length ? ' (' + detail.join('; ') + ')' : '');
}

/** PASS is shown only when every supplied gate is a valid PASS. */
export function blockersDisplay(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return 'UNKNOWN — NO GATE DATA';

  const normalized = gates.map(normalizeGate);
  const blockers = normalized.filter(gate => gate.result === GATE_BLOCK);
  const unknown = normalized.filter(gate => gate.result === GATE_UNKNOWN || !gate.validRecord);

  if (blockers.length && unknown.length) {
    return 'BLOCKED: ' + blockers.map(describeGate).join('; ') +
      '; INCOMPLETE: ' + unknown.map(describeGate).join('; ');
  }
  if (blockers.length) {
    return 'BLOCKED: ' + blockers.map(describeGate).join('; ');
  }
  if (unknown.length) {
    return 'PARTIAL: ' + unknown.map(describeGate).join('; ');
  }
  if (normalized.every(gate => gate.validRecord && gate.result === GATE_PASS)) {
    return 'PASS — NO BLOCKERS';
  }
  return 'UNKNOWN — GATE RESULTS NOT VERIFIED';
}
