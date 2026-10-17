const VALID_REASONS = new Set([
  'position_cap_block',
  'api_error',
  'routing_error',
  'signal_expired',
  'unknown'
]);

const clean = value => String(value ?? '').trim();

export function sanitizeTradetronFailureDetail(value, maxLength = 240) {
  const raw = value && typeof value === 'object'
    ? (value.message || value.reason || value.error || value.code || '')
    : value;
  const sanitized = clean(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:sk|pk|sb_secret_|sb_publishable_|sbp_)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  return sanitized.slice(0, Math.max(0, Number(maxLength) || 240)) || 'No diagnostic details supplied';
}

export function classifyTradetronSignalFailure(input = {}) {
  const detail = sanitizeTradetronFailureDetail(input);
  const reason = clean(input?.reason || '');
  const code = clean(input?.code || '');
  const message = clean(input?.message || (input instanceof Error ? input.message : ''));
  const combined = [reason, code, message, detail].filter(Boolean).join(' ').toLowerCase();

  if (input?.positionSafetyBlocked === true ||
      input?.globalPositionCapBlocked === true ||
      /global open-position limit reached|position[_ -]cap|position safety blocked/.test(combined)) {
    return 'position_cap_block';
  }
  if (/signal[_ -]?expired|reservation expired|ttl expired|expired before/.test(combined)) {
    return 'signal_expired';
  }
  if (/no configured bridge route|unsupported.*symbol|symbol.*(?:invalid|unsupported)|route(?:ing)? error|route unavailable|bridge disabled/.test(combined)) {
    return 'routing_error';
  }
  if (/tradetron api|supabase\s+\d{3}|http\s+\d{3}|api[_ -]?error|api request|request failed|did not confirm acceptance|fetch failed|network|connection|timeout|aborterror|econn|enotfound|status\s*[:=]\s*\d{3}/.test(combined) ||
      (input?.status !== undefined && input?.status !== null && Number.isFinite(Number(input.status))) ||
      Boolean(input?.retryable)) {
    return 'api_error';
  }
  if (VALID_REASONS.has(reason.toLowerCase())) return reason.toLowerCase();
  return 'unknown';
}
