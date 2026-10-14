import { CONFIG } from '../../server/config.js';
import { select, updateReturning } from '../../server/db.js';
import { GRID_MAX_POSITION_CHOICES, GRID_RISK_PER_TRADE_CHOICES, GRID_DAILY_LOSS_CHOICES, GRID_MOMENTUM_PAUSE_CHOICES } from '../../shared/grid-settings.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });
  if (!CONFIG.engineSecret || req.headers['x-engine-secret'] !== CONFIG.engineSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body);
    const current = (await select('dd_settings', 'id=eq.1&select=*'))?.[0] || {};
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.autoTrade !== undefined) patch.auto_trade = !!body.autoTrade;
    if (body.emergencyStop !== undefined) patch.emergency_stop = !!body.emergencyStop;
    if (body.continuousMode !== undefined) patch.continuous_mode = !!body.continuousMode;
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
    const gridRangeOrInstrumentChanged = [
      'gridSymbol', 'gridLowerPrice', 'gridUpperPrice', 'gridLevelsCount'
    ].some(key => body[key] !== undefined);
    if (gridRangeOrInstrumentChanged && gridPositions.length > 0) {
      return res.status(409).json({ success: false, error: 'Grid instrument/range/levels cannot change while a grid position is open.' });
    }
    if (body.gridReset === true) {
      if (gridPositions.length > 0) {
        return res.status(409).json({ success: false, error: 'Close all grid positions before resetting a hard stop.' });
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
      if (body.gridSymbol !== undefined) {
        const symbol = String(body.gridSymbol || '').trim().toUpperCase();
        if (!['BTCUSD', 'ETHUSD'].includes(symbol)) {
          return res.status(400).json({ success: false, error: 'Grid instrument must be BTCUSD or ETHUSD.' });
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
        if (!GRID_MAX_POSITION_CHOICES.includes(value)) {
          return res.status(400).json({ success: false, error: 'Grid max positions must be 1, 3 or 4. Tradetron bridge mode still limits the live simulation to one net position.' });
        }
        if (gridPositions.length > value) {
          return res.status(409).json({ success: false, error: 'Grid max positions cannot be lower than the current open position count.' });
        }
        patch.grid_max_positions = value;
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
          return res.status(400).json({ success: false, error: 'Grid daily loss limit must be 2%, 2.25% or 2.5%.' });
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
        if (!(lower > 0 && upper > lower)) {
          return res.status(400).json({ success: false, error: 'Set a valid grid lower and upper price before starting.' });
        }
        if (gridState.pausedReason) {
          return res.status(409).json({ success: false, error: 'Reset the grid hard stop before starting again.' });
        }
        patch.grid_enabled = true;
      } else if (body.gridEnabled === false) {
        patch.grid_enabled = false;
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'No supported setting supplied' });
    const updatedRows = await updateReturning(
      'dd_settings',
      'id=eq.1&select=*',
      { ...patch, updated_at: new Date().toISOString() }
    );
    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      return res.status(409).json({
        success: false,
        error: 'Settings were not saved: the dd_settings row with id=1 was not updated. Verify the settings row exists.'
      });
    }
    const persisted = Object.fromEntries(
      Object.keys(patch)
        .filter(key => key !== 'grid_state')
        .map(key => [key, updatedRows[0][key]])
    );
    return res.status(200).json({ success: true, changed: patch, persisted, previous: current });
  } catch (e) {
    return res.status(503).json({ success: false, error: e.message });
  }
}