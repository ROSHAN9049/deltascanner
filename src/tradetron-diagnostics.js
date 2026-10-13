const clean = value => String(value ?? '').trim();

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeKey(value) {
  const key = clean(value);
  return /^[A-Za-z0-9_]{1,100}$/.test(key) ? key : '';
}

function safeLabel(value, pattern = /^[A-Za-z0-9_-]{1,40}$/) {
  const label = clean(value);
  return pattern.test(label) ? label : '';
}

/**
 * Return only non-sensitive, operator-useful Tradetron bridge diagnostics.
 * Never expose the raw worker log payload because it may contain unrelated data.
 */
export function getTradetronDiagnosticDetails(value) {
  const root = parseObject(value);
  const sources = [root];
  for (const key of ['data', 'details', 'bridge', 'tradetron']) {
    const nested = parseObject(root[key]);
    if (Object.keys(nested).length) sources.push(nested);
  }

  const pick = keys => {
    for (const source of sources) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && clean(source[key]) !== '') return source[key];
      }
    }
    return null;
  };

  const symbol = safeLabel(pick(['symbol', 'market_symbol', 'marketSymbol']), /^[A-Za-z0-9_-]{1,40}$/);
  const sideRaw = safeLabel(pick(['side']), /^[A-Za-z0-9_-]{1,20}$/).toUpperCase();
  const side = ['BUY', 'SELL'].includes(sideRaw) ? sideRaw : '';
  const strategy = safeLabel(pick(['strategy']), /^[A-Za-z0-9_-]{1,40}$/).toUpperCase();
  const entryVariableKey = safeKey(pick([
    'entryVariableKey', 'entry_variable_key', 'bridge_entry_variable_key', 'bridgeEntryVariableKey'
  ]));
  const globalTriggerKey = safeKey(pick([
    'globalTriggerKey', 'global_trigger_key', 'bridge_global_trigger_key',
    'bridgeGlobalTriggerKey', 'triggerKey', 'bridge_trigger_key'
  ]));
  const rawCountValue = pick([
    'payloadVariableCount', 'payload_variable_count', 'bridge_variable_count', 'bridgeVariableCount'
  ]);
  const rawCount = rawCountValue === null ? NaN : Number(rawCountValue);
  const payloadVariableCount = Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : null;
  const rawKeys = pick([
    'payloadVariableKeys', 'payload_variable_keys', 'bridge_variable_keys', 'bridgeVariableKeys'
  ]);
  const payloadVariableKeys = Array.isArray(rawKeys)
    ? [...new Set(rawKeys.map(safeKey).filter(Boolean))].slice(0, 40)
    : [];

  if (!entryVariableKey && !globalTriggerKey && payloadVariableCount === null && !payloadVariableKeys.length) {
    return null;
  }

  return {
    symbol,
    side,
    strategy,
    entryVariableKey,
    globalTriggerKey,
    payloadVariableCount,
    payloadVariableKeys
  };
}
