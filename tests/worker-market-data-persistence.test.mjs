import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyse } from '../worker/strategy.mjs';
import { DELTA_TESTNET_FUTURES_ALLOWLIST } from '../worker/execution/execution-route-policy.mjs';

// These tests deliberately import the worker in its explicit Demo/Testnet profile.
// Dummy credentials are sufficient because no private API request is made.
process.env.DELTA_ENVIRONMENT = 'TESTNET';
process.env.DELTA_EXECUTION_MODE = 'testnet';
process.env.DELTA_TESTNET_API_KEY = 'unit-test-key';
process.env.DELTA_TESTNET_API_SECRET = 'unit-test-secret';

const { DeltaEngine } = await import('../worker/engine.mjs');

const product = (symbol, id, patch = {}) => ({
  id,
  symbol,
  contract_type: 'perpetual_futures',
  state: 'live',
  trading_status: 'operational',
  only_reduce_only_orders_allowed: false,
  contract_value: '1',
  tick_size: '0.01',
  notional_type: 'vanilla',
  max_leverage_notional: '100000',
  ...patch
});

test('strategy preserves distinct Testnet execution and public market-data product IDs', () => {
  const signal = analyse(
    {
      symbol: 'LINKUSD',
      mark_price: '10',
      close: '10',
      ltp_change_24h: '0',
      quotes: { best_bid: '9.99', best_ask: '10.01' }
    },
    product('LINKUSD', 70001, { marketDataProductId: 50122 }),
    [], [], [], [], [], 'MOMENTUM', {}
  );

  assert.equal(signal.productId, 70001, 'execution continues to use the verified Testnet product ID');
  assert.equal(signal.marketDataProductId, 50122, 'history/cache writes use the public market-data product ID');
});

test('refreshProducts reports LINKUSD as a market-universe mismatch and retains the other eleven allowlisted routes', async () => {
  const engine = new DeltaEngine();
  const marketSymbols = DELTA_TESTNET_FUTURES_ALLOWLIST
    .filter(symbol => symbol !== 'LINKUSD')
    .concat('SOONUSD');
  const executionProducts = DELTA_TESTNET_FUTURES_ALLOWLIST.map((symbol, index) =>
    product(symbol, 80000 + index)
  );
  engine.adapter = {
    async products() {
      return marketSymbols.map((symbol, index) => product(symbol, 90000 + index));
    },
    async executionProducts() {
      return executionProducts;
    }
  };

  const logs = [];
  engine.log = async (level, message, data) => logs.push({ level, message, data });
  await engine.refreshProducts({ executionMode: 'testnet' });

  assert.equal(engine.testnetExecutionCatalogReady, false, 'the full twelve-symbol intersection remains incomplete');
  const refreshLog = logs.find(row => row.message === 'Delta product universe refreshed');
  assert.ok(refreshLog);
  assert.deepEqual(refreshLog.data.testnetAllowlistMissingFromTestnetCatalog, []);
  assert.deepEqual(refreshLog.data.testnetAllowlistMissingFromMarketDataUniverse, ['LINKUSD']);
  assert.deepEqual(refreshLog.data.testnetAllowlistMissing, ['LINKUSD']);
  assert.equal(refreshLog.data.testnetAllowlistPartialReady, true);
  assert.equal(refreshLog.data.testnetAllowlistAvailableCount, 11);

  for (const symbol of DELTA_TESTNET_FUTURES_ALLOWLIST.filter(value => value !== 'LINKUSD')) {
    assert.equal(engine.productMap.get(symbol)?.executionProductAvailable, true, symbol + ' must retain its verified Testnet route');
  }
  assert.equal(engine.productMap.has('LINKUSD'), false, 'do not alias LINKUSD to the different public SOONUSD symbol');
  assert.equal(engine.productMap.get('SOONUSD')?.executionProductAvailable, false, 'SOONUSD is not in the fixed Testnet entry allowlist');
});

test('incomplete full allowlist does not add a global block to an individually verified symbol', async () => {
  const engine = new DeltaEngine();
  engine.testnetExecutionCatalogReady = false;
  engine.lastTickAt = Date.now();

  const signal = {
    symbol: 'LINKUSD',
    blocked: [],
    normalizedScore: 90,
    side: 'BUY',
    stage: 'SETUP',
    ready: false,
    executionProductAvailable: true,
    productId: 50122,
    price: 10,
    sl: 9,
    tp: 12,
    candlesFresh: true
  };
  const gate = await engine.riskGate(
    signal,
    'MOMENTUM',
    { equity: 1000, available: 1000 },
    { enabled: false, auto_trade: false, emergency_stop: true, continuous_mode: true },
    [],
    []
  );

  assert.ok(!gate.reasons.some(reason => /allowlist is incomplete/i.test(reason)));
  assert.ok(!gate.reasons.some(reason => /Testnet route unavailable/i.test(reason)));
  assert.ok(gate.reasons.includes('Emergency Stop'));
  assert.ok(gate.reasons.includes('Auto OFF'));
});

test('final entry path reaches the individual risk gate when the full catalogue has one unmapped symbol', async () => {
  const engine = new DeltaEngine();
  engine.testnetExecutionCatalogReady = false;
  engine.lastTickAt = Date.now();
  engine.privateExecutionAvailable = true;

  let riskGateCalled = false;
  let executionCalled = false;
  engine.riskGate = async () => {
    riskGateCalled = true;
    return { reasons: ['Emergency Stop', 'Auto OFF'], size: null };
  };
  engine.executeSignal = async () => {
    executionCalled = true;
    throw new Error('test must never reach order execution');
  };

  const opened = await engine.openTrade(
    {},
    'MOMENTUM',
    {
      symbol: 'LINKUSD',
      side: 'BUY',
      stage: 'CONFIRMED',
      ready: true,
      normalizedScore: 95,
      executionProductAvailable: true,
      productId: 50122,
      price: 10,
      sl: 9,
      tp: 12
    },
    { equity: 1000, available: 1000 },
    { enabled: false, auto_trade: false, emergency_stop: true },
    [],
    []
  );

  assert.equal(opened, false);
  assert.equal(riskGateCalled, true, 'the individually verified product must reach normal interlocks');
  assert.equal(executionCalled, false, 'E-STOP/Auto OFF must still prevent all order execution');
});

test('fresh tick is persisted only when a real ticker snapshot has non-empty rows', async () => {
  const engine = new DeltaEngine();
  const updates = [];
  engine.updateEngineState = async patch => updates.push(patch);
  engine.lastTickAt = Date.parse('2026-11-02T12:30:00.000Z');
  engine.tickerMap = new Map([['LINKUSD', { symbol: 'LINKUSD' }]]);

  assert.equal(await engine.persistMarketTick(), true);
  assert.deepEqual(updates, [{ last_tick_at: '2026-11-02T12:30:00.000Z' }]);

  engine.tickerMap.clear();
  assert.equal(await engine.persistMarketTick(), false);
  assert.equal(updates.length, 1, 'an empty ticker map must never refresh the persisted tick');
});

test('scanOnce persists the fresh tick before market cache, candle warm-up and deep analysis', async () => {
  const source = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async scanOnce() {');
  const end = source.indexOf('\n  async recordMemoryUsage', start);
  assert.ok(start >= 0 && end > start, 'scanOnce source should be present');
  const body = source.slice(start, end);

  const refresh = body.indexOf('await this.refreshTickers();');
  const persist = body.indexOf('await this.persistMarketTick();');
  const marketCache = body.indexOf('await this.cacheMarketState();');
  const candleWarmup = body.indexOf('await this.refreshCandleWarmup();');
  const deepAnalysis = body.indexOf('await this.analyseUniverse(');

  assert.ok(refresh >= 0);
  assert.ok(persist > refresh, 'persist tick immediately after ticker refresh');
  assert.ok(marketCache > persist, 'persist tick before market cache persistence');
  assert.ok(candleWarmup > marketCache, 'persist tick before candle work');
  assert.ok(deepAnalysis > candleWarmup, 'persist tick before deep analysis');
});

test('failed history batch is logged and does not throw into the scan loop', async () => {
  const engine = new DeltaEngine();
  const logs = [];
  engine.insertSignalHistoryBatch = async () => {
    throw Object.assign(new Error('Supabase 400: 23502 product_id null'), { code: '23502', status: 400 });
  };
  engine.log = async (level, message, data) => logs.push({ level, message, data });

  const inserted = await engine.persistSignalHistorySafely([{ symbol: 'BTCUSD', product_id: null }]);

  assert.equal(inserted, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'ERROR');
  assert.equal(logs[0].message, 'Signal history batch persistence failed; live scan continues');
  assert.equal(logs[0].data.code, '23502');
});
