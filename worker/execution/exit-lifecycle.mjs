const stringOrEmpty = value => String(value ?? '').trim();

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric >= 1e14) return numeric / 1000;
    if (numeric >= 1e11) return numeric;
    return numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveExitLifecycleBoundary(settingsRows) {
  if (!Array.isArray(settingsRows)) return null;
  const value = settingsRows[0]?.exit_lifecycle_deploy_boundary_utc;
  const parsed = timestampMs(value);
  return parsed === null ? null : parsed;
}

export function parseEnrolledPositionIds(value = '') {
  return new Set(String(value ?? '').split(',').map(item => item.trim()).filter(item => /^\\d+$/.test(item)));
}

export function isExitLifecycleEnrolled(
  position,
  { deploymentBoundaryMs = null, enrolledPositionIds = new Set() } = {}
) {
  const openedAt = timestampMs(position?.opened_at ?? position?.created_at);
  const canonicalId = String(position?.id ?? position?.delta_position_id ?? position?.canonical_position_id ?? '').trim();
  if (openedAt === null) return enrolledPositionIds.has(canonicalId);
  if (deploymentBoundaryMs === null || !Number.isFinite(Number(deploymentBoundaryMs))) {
    return enrolledPositionIds.has(canonicalId);
  }
  return openedAt >= Number(deploymentBoundaryMs) || enrolledPositionIds.has(canonicalId);
}

export function resolveAutomaticPositionExitReason(
  position,
  { nowMs = Date.now(), maxHoldMinutes = 240 } = {}
) {
  const marker = stringOrEmpty(position?.requested_exit_reason).toUpperCase();
  if (['TIMEOUT', 'STOP_LOSS', 'TAKE_PROFIT'].includes(marker)) return marker;

  const openedAt = timestampMs(position?.opened_at ?? position?.created_at);
  const holdMinutes = Number(maxHoldMinutes);
  if (openedAt === null || !Number.isFinite(holdMinutes) || holdMinutes <= 0) return null;
  return nowMs - openedAt >= holdMinutes * 60_000 ? 'TIMEOUT' : null;
}

export async function runAutomaticPositionExitCycle({
  position,
  nowMs = Date.now(),
  maxHoldMinutes = 240,
  onExit
} = {}) {
  if (typeof onExit !== 'function') throw new Error('Automatic exit cycle requires an onExit callback');
  const reason = resolveAutomaticPositionExitReason(position, { nowMs, maxHoldMinutes });
  if (!reason) return { attempted: false, reason: null, result: null };
  const result = await onExit(reason);
  return { attempted: true, reason, result };
}

export async function closeTrackedPosition({
  database,
  executor,
  position,
  symbol,
  productId,
  qty,
  side,
  reason,
  deploymentBoundaryMs = null,
  enrolledPositionIds = new Set(),
  now = () => Date.now(),
  log = async () => {}
} = {}) {
  const normalizedSymbol = stringOrEmpty(symbol).toUpperCase();
  const closeReason = stringOrEmpty(reason).toUpperCase();
  const executionId = stringOrEmpty(position?.execution_id);
  const positionAliases = new Set([
    executionId,
    stringOrEmpty(position?.client_order_id),
    stringOrEmpty(position?.entry_order_id)
  ].filter(Boolean));

  if (!database || typeof database.select !== 'function' || typeof database.update !== 'function') {
    throw new Error('Exit lifecycle database is unavailable; close blocked');
  }
  if (!executor || typeof executor.closePosition !== 'function') {
    throw new Error('Dedicated Delta Testnet close executor is unavailable; close blocked');
  }
  if (!normalizedSymbol || !/^[A-Z0-9]+USD$/.test(normalizedSymbol)) {
    throw new Error('Invalid perpetual symbol for automatic exit');
  }
  if (!['TIMEOUT', 'STOP_LOSS', 'TAKE_PROFIT'].includes(closeReason)) {
    throw new Error('Unsupported automatic close reason');
  }
  if (position?.origin !== 'ENGINE' || !['MOMENTUM', 'SCALPING'].includes(stringOrEmpty(position?.strategy).toUpperCase())) {
    throw new Error('Automatic Futures exit is restricted to enrolled Engine Momentum/Scalping positions');
  }
  if (!positionAliases.size) throw new Error('Position has no stable execution identity; automatic close blocked');

  const rows = await database.select(
    'dd_delta_positions',
    'symbol=eq.' + encodeURIComponent(normalizedSymbol) +
      '&status=eq.OPEN&select=id,symbol,status,client_order_id,entry_order_id,side,product_id&limit=100'
  );
  if (!Array.isArray(rows)) throw new Error('Canonical OPEN position lookup is incomplete; automatic close blocked');
  const explicitPositionId = stringOrEmpty(position?.delta_position_id ?? position?.canonical_position_id);
  const matches = rows.filter(row =>
    (explicitPositionId && String(row?.id ?? '') === explicitPositionId) ||
    [row?.client_order_id, row?.entry_order_id].some(value => positionAliases.has(stringOrEmpty(value)))
  );
  if (matches.length !== 1 || matches[0]?.id === undefined || matches[0]?.id === null) {
    throw new Error('Expected exactly one canonical OPEN Delta position for ' + normalizedSymbol +
      '; found ' + matches.length + '. Automatic close blocked');
  }

  const canonical = matches[0];
  const enrollmentPosition = { ...position, id: canonical.id };
  if (!isExitLifecycleEnrolled(enrollmentPosition, { deploymentBoundaryMs, enrolledPositionIds })) {
    await log('WARN', '[ExitLifecycle] Historical position is not explicitly enrolled; automatic close remains disabled', {
      symbol: normalizedSymbol, positionId: String(canonical.id),
      openedAt: position?.opened_at ?? position?.created_at ?? null,
      executionBlocked: true
    });
    return { skipped: true, reason: 'LEGACY_POSITION_NOT_ENROLLED' };
  }
  const canonicalSide = stringOrEmpty(canonical.side).toUpperCase();
  const requestedSide = stringOrEmpty(side).toUpperCase();
  if (canonicalSide && requestedSide && canonicalSide !== requestedSide) {
    throw new Error('Local/canonical position side mismatch; automatic close blocked');
  }
  const canonicalProductId = Number(canonical.product_id);
  const requestedProductId = Number(productId);
  if (Number.isFinite(canonicalProductId) && canonicalProductId > 0 &&
      Number.isFinite(requestedProductId) && requestedProductId > 0 &&
      canonicalProductId !== requestedProductId) {
    throw new Error('Local/canonical product ID mismatch; automatic close blocked');
  }

  const updatedAt = new Date(now()).toISOString();
  await database.update(
    'dd_delta_positions',
    'id=eq.' + encodeURIComponent(String(canonical.id)),
    { requested_exit_reason: closeReason, updated_at: updatedAt }
  );
  if (executionId) {
    await database.update(
      'dd_positions',
      'execution_id=eq.' + encodeURIComponent(executionId),
      { requested_exit_reason: closeReason, updated_at: updatedAt }
    );
  }

  try {
    const order = await executor.closePosition(normalizedSymbol, qty, {
      positionId: String(canonical.id),
      closeReason,
      expectedSide: requestedSide,
      expectedProductId: Number.isFinite(requestedProductId) ? requestedProductId : null,
      strategy: stringOrEmpty(position.strategy).toUpperCase()
    });
    await log('INFO', '[ExitLifecycle] Reduce-only Testnet close submitted or already in flight', {
      symbol: normalizedSymbol,
      positionId: String(canonical.id),
      closeReason,
      clientOrderId: order?.client_order_id ?? null,
      orderId: order?.id ?? null,
      reduceOnly: true,
      environment: 'testnet'
    });
    return { skipped: false, positionId: String(canonical.id), order };
  } catch (error) {
    await log('ERROR', '[ExitLifecycle] Automatic close failed; position remains OPEN and will be reconciled', {
      symbol: normalizedSymbol,
      positionId: String(canonical.id),
      closeReason,
      executionId: executionId || null,
      error: String(error?.message || error).slice(0, 240),
      code: error?.code ?? null,
      status: error?.status ?? null,
      positionStatus: 'OPEN',
      environment: 'testnet'
    });
    throw error;
  }
}
