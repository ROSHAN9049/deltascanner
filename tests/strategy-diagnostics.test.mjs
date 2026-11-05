import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DELTA_ENVIRONMENT = 'TESTNET';
process.env.DELTA_EXECUTION_MODE = 'testnet';
process.env.DELTA_TESTNET_API_KEY = 'unit-test-key';
process.env.DELTA_TESTNET_API_SECRET = 'unit-test-secret';

const { DeltaEngine } = await import('../worker/engine.mjs');
const { OPTIONS_EXECUTION_ALLOWED, isOptionsExecutionAllowed } = await import('../worker/options-execution-lock.mjs');

test('Testnet Grid default-off execution gate blocks routing until explicitly enabled', async () => {
  const engine = new DeltaEngine();
  const logs = [];
  let orderCalls = 0;
  engine.log = async (level, message, data) => logs.push({ level, message, data });
  engine.adapter.placeOrder = async () => { orderCalls += 1; throw new Error('must not route'); };
  engine.tickerMap = new Map([['BTCUSD', { symbol: 'BTCUSD', mark_price: 100 }]]);
  engine.productMap = new Map([['BTCUSD', {
    symbol: 'BTCUSD',
    executionProductAvailable: false,
    contract_value: 1,
    maker_commission_rate: 0.0002
  }]]);
  engine.gridCandleSymbol = 'BTCUSD';
  engine.lastGridCandleRefresh = Date.now();
  engine.refreshCandle = async () => {};
  engine.getCandles = () => Array.from({ length: 12 }, (_, index) => ({
    time: Date.now() - (11 - index) * 60_000,
    open: 100, high: 101, low: 99, close: 100, volume: 10
  }));

  await engine.manageGridStrategy({
    grid_enabled: true,
    grid_symbol: 'BTCUSD',
    grid_lower_price: 90,
    grid_upper_price: 110,
    grid_levels_count: 8,
    grid_risk_per_trade_pct: 0.3,
    grid_daily_loss_pct: 2,
    grid_max_drawdown_pct: 5,
    grid_momentum_pause_pct: 2.5,
    grid_reduce_after_losses: true,
    emergency_stop: false,
    grid_state: null
  }, { equity: 1000, available: 1000 });

  assert.equal(orderCalls, 0);
  assert.equal(engine.lastGridTestnetDiagnostics.status, 'GRID_EXECUTION_DISABLED');
  assert.equal(engine.lastGridTestnetDiagnostics.gridExecutionAllowed, false);
  assert.equal(engine.lastGridTestnetDiagnostics.executionLocked, true);
  assert.equal(engine.lastGridTestnetDiagnostics.orderRoutingAttempted, false);
  assert.equal(orderCalls, 0);
});

test('missing option catalogue credentials or API failure are diagnostic-only and clear stale candidates', async () => {
  const engine = new DeltaEngine();
  const logs = [];
  engine.log = async (level, message, data) => logs.push({ level, message, data });
  engine.optionTickerMap.set('C-BTC-80000-311226', { symbol: 'C-BTC-80000-311226' });
  engine.optionProductMap.set('C-BTC-80000-311226', { product_id: 1 });
  engine.refreshOptionTickers = async () => { throw new Error('Testnet option catalogue unavailable'); };

  const refreshed = await engine.refreshOptionDiagnosticsSafely({ options_enabled: true });

  assert.equal(refreshed, false);
  assert.equal(engine.optionTickerMap.size, 0);
  assert.equal(engine.optionProductMap.size, 0);
  assert.equal(engine.lastOptionsTestnetDiagnostics.status, 'DIAGNOSTICS_ERROR');
  assert.ok(logs.some(row => row.level === 'WARN' && row.message.includes('Options diagnostics skipped')));
});

test('an Options analysis exception does not prevent Momentum/Scalping signal processing', async () => {
  const engine = new DeltaEngine();
  const logs = [];
  engine.log = async (level, message, data) => logs.push({ level, message, data });
  engine.analyseOptions = async () => { throw new Error('bad option contract row'); };

  const result = await engine.analyseOptionsSafely([], { equity: 1000 }, { options_enabled: true }, []);

  assert.deepEqual(result, []);
  assert.deepEqual(engine.lastOptionSignals, []);
  assert.ok(logs.some(row => row.level === 'WARN' && row.message.includes('Momentum/Scalping scan continues')));
});

test('Options order-routing hard lock remains unchanged', () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  assert.equal(isOptionsExecutionAllowed(), false);
});
