import { CONFIG } from '../../server/config.js';
import { hasValidEngineSecretHeader, isEngineSessionValid, isSameOriginRequest } from '../../server/engine-session.js';
import { insert, select, updateReturning } from '../../server/db.js';
import { buildSettingsAuditEntry } from '../../server/settings-audit.js';
import { createEmergencyStopReleaseChallenge, hashEmergencyStopReleaseToken, matchesEmergencyStopReleaseToken, verifyEmergencyStopReleaseChallenge } from '../../server/estop-release-confirmation.js';
import { GRID_MAX_POSITION_CHOICES, GRID_RISK_PER_TRADE_CHOICES, GRID_DAILY_LOSS_CHOICES, GRID_MOMENTUM_PAUSE_CHOICES } from '../../shared/grid-settings.js';
import { isAllowedDeltaTestnetFutureSymbol } from '../../worker/execution/execution-route-policy.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });
  const headerAuthorized = Boolean(CONFIG.engineSecret) && hasValidEngineSecretHeader(req, CONFIG.engineSecret);
  const cookieAuthorized = Boolean(CONFIG.engineSecret) && isEngineSessionValid(req, CONFIG.engineSecret) && isSameOriginRequest(req);
  if (!CONFIG.engineSecret || (!headerAuthorized && !cookieAuthorized)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body);
    const current = (await select('dd_settings', 'id=eq.1&select=*'))?.[0] || {};
    let releaseTokenHash = null;
    let releaseActivationAt = null;

    // The UI countdown is only a usability safeguard. The signed, server-stored
    // challenge enforces delay, single-use consumption, and current activation.
    if (body.requestEmergencyStopRelease === true) {
      if (current.emergency_stop !== true) {
        return res.status(409).json({ success: false, error: 'E-STOP is not active; no release challenge is available.' });
      }
      const activationAt = String(current.emergency_stop_activated_at || '').trim();
      if (!activationAt) {
        return res.status(409).json({
          success: false,
          error: 'E-STOP activation timestamp is unavailable. Apply the E-STOP release migration before issuing a challenge.'
        });
      }
      const challenge = createEmergencyStopReleaseChallenge(CONFIG.engineSecret);
      const stored = await updateReturning(
        'dd_settings',
        'id=eq.1&emergency_stop=eq.true&emergency_stop_activated_at=eq.' +
          encodeURIComponent(activationAt) + '&select=id',
        { emergency_stop_release_token_hash: hashEmergencyStopReleaseToken(challenge.token) }
      );
      if (!Array.isArray(stored) || stored.length !== 1) {
        return res.status(409).json({
          success: false,
          error: 'E-STOP changed while creating the release challenge. Keep it active and request a new challenge.'
        });
      }
      return res.status(200).json({
        success: true,
        emergencyStopReleaseToken: challenge.token,
        emergencyStopReleaseAvailableAt: challenge.availableAt,
        emergencyStopReleaseExpiresAt: challenge.expiresAt
      });
    }

    if (body.emergencyStop === false && current.emergency_stop === true) {
      if (body.emergencyStopReleaseVerified !== true) {
        return res.status(409).json({ success: false, error: 'Explicit system-state verification is required to release E-STOP.' });
      }
      const verification = verifyEmergencyStopReleaseChallenge(
        body.emergencyStopReleaseToken,
        CONFIG.engineSecret
      );
      if (!verification.valid) {
        const error = verification.reason === 'countdown'
          ? 'Server safety countdown has not completed; wait before releasing E-STOP.'
          : verification.reason === 'expired'
            ? 'E-STOP release challenge expired. Request a new challenge and repeat the countdown.'
            : 'E-STOP release challenge is invalid. Request a new challenge and repeat the countdown.';
        return res.status(409).json({
          success: false,
          error,
          ...(verification.availableAt ? { emergencyStopReleaseAvailableAt: verification.availableAt } : {})
        });
      }
      releaseActivationAt = String(current.emergency_stop_activated_at || '').trim();
      releaseTokenHash = hashEmergencyStopReleaseToken(body.emergencyStopReleaseToken);
      if (!releaseActivationAt ||
          !matchesEmergencyStopReleaseToken(body.emergencyStopReleaseToken, current.emergency_stop_release_token_hash)) {
        return res.status(409).json({
          success: false,
          error: 'E-STOP release challenge is stale, already consumed, or belongs to another activation. Request a new challenge.'
        });
      }
    } else if (body.emergencyStop === false &&
               body.emergencyStopReleaseToken &&
               current.emergency_stop !== true) {
      return res.status(409).json({
        success: false,
        error: 'E-STOP is no longer active; the release challenge cannot be reused.'
      });
    }

    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.autoTrade !== undefined) patch.auto_trade = !!body.autoTrade;
    if (body.emergencyStop !== undefined) {
      patch.emergency_stop = !!body.emergencyStop;
      if (body.emergencyStop === true && current.emergency_stop !== true) {
        patch.emergency_stop_activated_at = new Date().toISOString();
        patch.emergency_stop_release_token_hash = null;
      } else if (body.emergencyStop === false && current.emergency_stop === true) {
        // Consumed atomically with the state transition at the bottom.
        patch.emergency_stop_release_token_hash = null;
      }
    }
    if (body.continuousMode !== undefined) patch.continuous_mode = !!body.continuousMode;
    const strategyPositionLimitFields = [
      ['maxMomentumPositions', 'max_momentum_positions'],
      ['maxScalpingPositions', 'max_scalping_positions'],
      ['maxGridPositions', 'max_grid_positions'],
      ['maxOptionsPositions', 'max_options_positions']
    ];
    for (const [inputKey, column] of strategyPositionLimitFields) {
      if (body[inputKey] === undefined) continue;
      const value = Number(body[inputKey]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
        return res.status(400).json({
          success: false,
          error: inputKey + ' must be an integer from 1 to 20.'
        });
      }
      patch[column] = value;
    }
    if (body.maxOpenPositions !== undefined) patch.max_open_positions = Math.max(1, Math.min(100, Math.round(Number(body.maxOpenPositions))));
    if (body.riskPct !== undefined) patch.risk_pct = Math.max(0.1, Math.min(5, Number(body.riskPct)));
    if (body.momentumRr !== undefined) patch.momentum_rr = Math.max(1, Math.min(5, Number(body.momentumRr)));
    if (body.scalpingRr !== undefined) patch.scalping_rr = Math.max(1, Math.min(5, Number(body.scalpingRr)));
    if (body.tp1Pct !== undefined) patch.tp1_pct = Math.max(1, Math.min(99, Number(body.tp1Pct)));
    if (body.maxHoldMinutes !== undefined) patch.max_hold_minutes = Math.max(1, Math.min(1440, Math.round(Number(body.maxHoldMinutes))));
    if (body.optionsEnabled !== undefined) patch.options_enabled = !!body.optionsEnabled;
    if (body.optionsBuyEnabled !== undefined) patch.options_buy_enabled = !!body.optionsBuyEnabled;
    if (body.optionsSellEnabled !== undefined) patch.options_sell_enabled = !!body.optionsSellEnabled;
    if (body.optionsBuyMinDelta !== undefined) patch.options_buy_min_delta = Math.max(0.30, Math.min(0.80, Number(body.optionsBuyMinDelta)));
    if (body.optionsBuyMaxDelta !== undefined) patch.options_buy_max_delta = Math.max(0.40, Math.min(0.90, Number(body.optionsBuyMaxDelta)));
    if (body.optionsSellMinDelta !== undefined) patch.options_sell_min_delta = Math.max(0.05, Math.min(0.50, Number(body.optionsSellMinDelta)));
    if (body.optionsSellMaxDelta !== undefined) patch.options_sell_max_delta = Math.max(0.10, Math.min(0.60, Number(body.optionsSellMaxDelta)));

    let gridState = current.grid_state;
    if (typeof gridState === 'string') {
      try { gridState = JSON.parse(gridState); } catch { gridState = null; }
    }
    if (!gridState || typeof gridState !== 'object' || Array.isArray(gridState)) {
      gridState = {
        version: 1, status: 'OFF', positions: [], trades: [], events: [],
        realizedPnl: 0, dayPnl: 0, dayStartEquity: 0, strategyStartEquity: 0,
        highWaterEquity: 0, consecutiveLosses: 0, pausedReason: null, lastPrice: 0,
        currentPrice: 0, unrealizedPnl: 0, currentEquity: 0, drawdownPct: 0,
        openRiskUsd: 0, tradeDate: null, lastTickAt: null, wasEnabled: false,
        momentum: { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 }
      };
    }
    const gridPositions = Array.isArray(gridState.positions) ? gridState.positions : [];
    const pendingEntries = Array.isArray(gridState.pendingEntries) ? gridState.pendingEntries : [];
    const testnetOpenGridPositions = await select(
      'dd_delta_positions',
      'strategy=eq.GRID&status=eq.OPEN&select=id,symbol,qty&limit=10'
    );
    const testnetPendingGridOrders = await select(
      'dd_orders',
      'strategy=eq.GRID&role=eq.ENTRY&state=in.(PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED)&select=id,symbol,state&limit=10'
    );
    const activeGridSymbols = new Set([
      ...gridPositions.map(row => String(row.symbol || '').toUpperCase()),
      ...pendingEntries.map(row => String(row.symbol || '').toUpperCase()),
      ...(Array.isArray(testnetOpenGridPositions) ? testnetOpenGridPositions : []).map(row => String(row.symbol || '').toUpperCase()),
      ...(Array.isArray(testnetPendingGridOrders) ? testnetPendingGridOrders : []).map(row => String(row.symbol || '').toUpperCase())
    ].filter(Boolean));
    const effectiveGridPositionCount = activeGridSymbols.size;
    const gridRangeOrInstrumentChanged = [
      'gridSymbol', 'gridLowerPrice', 'gridUpperPrice', 'gridLevelsCount', 'gridSymbolConfigs'
    ].some(key => body[key] !== undefined);
    if (gridRangeOrInstrumentChanged && effectiveGridPositionCount > 0) {
      return res.status(409).json({ success: false, error: 'Grid symbol ranges cannot change while an exchange position or entry order is open.' });
    }
    if (body.gridReset === true) {
      if (effectiveGridPositionCount > 0) {
        return res.status(409).json({ success: false, error: 'Close all Grid exchange positions before resetting a hard stop.' });
      }
      if (current.emergency_stop === true) {
        return res.status(409).json({ success: false, error: 'Turn off the global emergency stop before resetting the grid.' });
      }
      if (gridState.pausedReason === 'DAILY_LOSS_LIMIT') {
        return res.status(409).json({ success: false, error: 'Daily loss lock is automatic and cannot be reset during the same India trading day.' });
      }
      if (gridState.pausedReason === 'OVERALL_DRAWDOWN_STOP') {
        return res.status(409).json({ success: false, error: 'The 5% overall drawdown stop is terminal for this grid run. Do not restart this run with the same capital baseline.' });
      }
      patch.grid_enabled = false;
      patch.grid_state = {
        ...gridState,
        status: 'OFF',
        positions: [],
        pausedReason: null,
        lastPrice: 0,
        wasEnabled: false,
        lastTickAt: null,
        unrealizedPnl: 0,
        openRiskUsd: 0,
        currentEquity: Math.max(0, Number(gridState.strategyStartEquity || 0) + Number(gridState.realizedPnl || 0)),
        momentum: { paused: false, direction: 'NONE', movePct: 0, retracementPct: 0 },
        events: [...(Array.isArray(gridState.events) ? gridState.events : []), {
          type: 'RESET', reason: 'MANUAL_REVIEW_RESET', at: new Date().toISOString()
        }].slice(-80)
      };
    } else {
      if (body.gridSymbolConfigs !== undefined) {
        const configs = body.gridSymbolConfigs;
        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
          return res.status(400).json({ success: false, error: 'Grid symbol configurations must be an object keyed by Testnet symbol.' });
        }
        const entries = Object.entries(configs);
        const configuredSymbols = Array.isArray(CONFIG.gridSymbols) ? CONFIG.gridSymbols : [];
        const requestedSymbols = entries.map(([symbol]) => String(symbol).trim().toUpperCase());
        if (configuredSymbols.length !== 2 || requestedSymbols.length !== 2 ||
            requestedSymbols.some(symbol => !isAllowedDeltaTestnetFutureSymbol(symbol)) ||
            [...requestedSymbols].sort().join(',') !== [...configuredSymbols].sort().join(',')) {
          return res.status(400).json({ success: false, error: 'Grid configurations must match the two GRID_SYMBOLS configured in the Testnet worker.' });
        }
        const normalized = {};
        for (const [rawSymbol, config] of entries) {
          const symbol = String(rawSymbol).trim().toUpperCase();
          const lowerPrice = Number(config?.lowerPrice ?? config?.grid_lower_price);
          const upperPrice = Number(config?.upperPrice ?? config?.grid_upper_price);
          const levelsCount = Number(config?.levelsCount ?? config?.grid_levels_count ?? 10);
          if (!Number.isFinite(lowerPrice) || lowerPrice <= 0 ||
              !Number.isFinite(upperPrice) || upperPrice <= lowerPrice ||
              !Number.isInteger(levelsCount) || levelsCount < 8 || levelsCount > 12) {
            return res.status(400).json({ success: false, error: 'Each Grid symbol needs valid lower/upper prices and 8–12 levels.' });
          }
          normalized[symbol] = { lowerPrice, upperPrice, levelsCount };
        }
        patch.grid_symbol_configs = normalized;
        patch.grid_symbol = configuredSymbols[0];
        patch.grid_lower_price = normalized[configuredSymbols[0]].lowerPrice;
        patch.grid_upper_price = normalized[configuredSymbols[0]].upperPrice;
        patch.grid_levels_count = normalized[configuredSymbols[0]].levelsCount;
      }
      if (body.gridSymbol !== undefined) {
        const symbol = String(body.gridSymbol || '').trim().toUpperCase();
        if (!isAllowedDeltaTestnetFutureSymbol(symbol)) {
          return res.status(400).json({ success: false, error: 'Grid instrument must be in the Delta Testnet futures allowlist.' });
        }
        patch.grid_symbol = symbol;
      }
      if (body.gridLowerPrice !== undefined) {
        const value = Number(body.gridLowerPrice);
        if (!Number.isFinite(value) || value <= 0) {
          return res.status(400).json({ success: false, error: 'Grid lower price must be greater than zero.' });
        }
        patch.grid_lower_price = value;
      }
      if (body.gridUpperPrice !== undefined) {
        const value = Number(body.gridUpperPrice);
        if (!Number.isFinite(value) || value <= 0) {
          return res.status(400).json({ success: false, error: 'Grid upper price must be greater than zero.' });
        }
        patch.grid_upper_price = value;
      }
      if (body.gridLevelsCount !== undefined) {
        const value = Number(body.gridLevelsCount);
        if (!Number.isInteger(value) || value < 8 || value > 12) {
          return res.status(400).json({ success: false, error: 'Grid levels must be an integer from 8 to 12.' });
        }
        patch.grid_levels_count = value;
      }
      if (body.gridMaxPositions !== undefined) {
        const value = Number(body.gridMaxPositions);
        if (value !== 2 || !GRID_MAX_POSITION_CHOICES.includes(value)) {
          return res.status(400).json({ success: false, error: 'Two-symbol Grid supports a maximum of exactly two independently protected positions.' });
        }
        if (effectiveGridPositionCount > value) {
          return res.status(409).json({ success: false, error: 'Grid max positions cannot be lower than the active symbol count.' });
        }
        patch.grid_max_positions = value;
        patch.max_grid_positions = value;
      }
      if (body.gridRiskPerTradePct !== undefined) {
        const value = Number(body.gridRiskPerTradePct);
        if (!GRID_RISK_PER_TRADE_CHOICES.includes(value)) {
          return res.status(400).json({ success: false, error: 'Grid per-trade risk target must be 0.30%, 0.50%, 0.75% or 1.00%.' });
        }
        patch.grid_risk_per_trade_pct = value;
      }
      if (body.gridDailyLossPct !== undefined) {
        const value = Number(body.gridDailyLossPct);
        if (!GRID_DAILY_LOSS_CHOICES.includes(value)) {
          return res.status(400).json({ success: false, error: 'Grid daily loss limit is fixed at 2%.' });
        }
        patch.grid_daily_loss_pct = value;
      }
      if (body.gridMomentumPausePct !== undefined) {
        const value = Number(body.gridMomentumPausePct);
        if (!GRID_MOMENTUM_PAUSE_CHOICES.includes(value)) {
          return res.status(400).json({ success: false, error: 'Grid momentum pause must be 2.5%, 2.75% or 3%.' });
        }
        patch.grid_momentum_pause_pct = value;
      }
      if (body.gridReduceAfterLosses !== undefined) patch.grid_reduce_after_losses = !!body.gridReduceAfterLosses;

      const lower = Number(patch.grid_lower_price ?? current.grid_lower_price ?? 0);
      const upper = Number(patch.grid_upper_price ?? current.grid_upper_price ?? 0);
      if (lower > 0 && upper > 0 && upper <= lower) {
        return res.status(400).json({ success: false, error: 'Grid upper price must be greater than lower price.' });
      }
      if (body.gridEnabled === true) {
        if (CONFIG.gridExecutionAllowed !== true || CONFIG.directDeltaExecutionEnabled !== true ||
            CONFIG.deltaExecutionMode !== 'testnet' || CONFIG.environment !== 'TESTNET') {
          return res.status(409).json({ success: false, error: 'Grid Testnet execution is locked. Set GRID_EXECUTION_ALLOWED=true only in the Delta TESTNET profile and verify the worker/API environment.' });
        }
        if (current.emergency_stop === true) {
          return res.status(409).json({ success: false, error: 'Global Emergency Stop is active. Grid cannot start while E-STOP is active.' });
        }
        if (current.auto_trade !== true || current.enabled !== true || current.continuous_mode === false) {
          return res.status(409).json({ success: false, error: 'Global Auto Trade / engine enable is off. Grid cannot bypass global execution controls.' });
        }
        const configs = patch.grid_symbol_configs || current.grid_symbol_configs || {};
        const symbols = Array.isArray(CONFIG.gridSymbols) ? CONFIG.gridSymbols : [];
        if (symbols.length !== 2 || symbols.some(symbol => {
          const config = configs?.[symbol];
          const lowerPrice = Number(config?.lowerPrice ?? config?.grid_lower_price);
          const upperPrice = Number(config?.upperPrice ?? config?.grid_upper_price);
          const levelsCount = Number(config?.levelsCount ?? config?.grid_levels_count);
          return !(Number.isFinite(lowerPrice) && lowerPrice > 0 &&
            Number.isFinite(upperPrice) && upperPrice > lowerPrice &&
            Number.isInteger(levelsCount) && levelsCount >= 8 && levelsCount <= 12);
        })) {
          return res.status(400).json({ success: false, error: 'Configure a valid range and 8–12 Grid levels for both Testnet symbols before starting.' });
        }
        if (gridState.pausedReason) {
          return res.status(409).json({ success: false, error: 'Reset the Grid hard stop before starting again.' });
        }
        patch.grid_enabled = true;
        patch.grid_max_positions = 2;
        patch.max_grid_positions = 2;
      } else if (body.gridEnabled === false) {
        patch.grid_enabled = false;
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'No supported setting supplied' });
    const releaseQuery = releaseTokenHash && releaseActivationAt
      ? 'id=eq.1&emergency_stop=eq.true&emergency_stop_activated_at=eq.' +
        encodeURIComponent(releaseActivationAt) +
        '&emergency_stop_release_token_hash=eq.' + releaseTokenHash
      : 'id=eq.1';
    const updatedRows = await updateReturning(
      'dd_settings',
      releaseQuery + '&select=*',
      { ...patch, updated_at: new Date().toISOString() }
    );
    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      return res.status(409).json({
        success: false,
        error: releaseTokenHash
          ? 'E-STOP release challenge was already consumed or the activation changed. E-STOP remains active unless this request reports success.'
          : 'Settings were not saved: the dd_settings row with id=1 was not updated. Verify the settings row exists.'
      });
    }
    const internalKeys = new Set([
      'grid_state', 'emergency_stop_activated_at', 'emergency_stop_release_token_hash'
    ]);
    const publicPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !internalKeys.has(key))
    );
    const persisted = Object.fromEntries(
      Object.keys(patch)
        .filter(key => !internalKeys.has(key))
        .map(key => [key, updatedRows[0][key]])
    );
    const auditPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !internalKeys.has(key))
    );
    const auditEntry = buildSettingsAuditEntry({
      actor: headerAuthorized ? 'engine-secret-header' : 'authenticated-engine-session',
      previous: current,
      patch: auditPatch,
      persisted: updatedRows[0],
      at: new Date().toISOString()
    });
    let auditLogPersisted = true;
    let auditWarning = null;
    if (auditEntry) {
      try {
        await insert('dd_engine_logs', auditEntry);
      } catch (auditError) {
        auditLogPersisted = false;
        auditWarning = 'Settings were saved, but the audit log could not be persisted.';
        console.error('[SettingsAudit] Failed to persist settings change audit entry:', String(auditError?.message || auditError).slice(0, 240));
      }
    }
    return res.status(200).json({
      success: true,
      changed: publicPatch,
      persisted,
      previous: current,
      auditLogPersisted,
      ...(auditWarning ? { warning: auditWarning } : {})
    });
  } catch (e) {
    return res.status(503).json({ success: false, error: e.message });
  }
}