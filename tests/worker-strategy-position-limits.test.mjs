import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DELTA_ENVIRONMENT = 'TESTNET';
process.env.DELTA_EXECUTION_MODE = 'testnet';
process.env.DELTA_TESTNET_API_KEY = 'unit-test-key';
process.env.DELTA_TESTNET_API_SECRET = 'unit-test-secret';

const { DeltaEngine } = await import('../worker/engine.mjs');

const baseSignal = {
  symbol:'DOGSUSD',
  blocked:[],
  normalizedScore:90,
  side:'BUY',
  stage:'CONFIRMED',
  ready:true,
  executionProductAvailable:true,
  productId:70001,
  price:10,
  sl:9.7,
  tp:11.5,
  candlesFresh:true,
  feeRiskRatio:0.05,
  costGateRatio:0.2
};

test('worker risk gate blocks Momentum at its own cap and does not use the Scalping cap', async () => {
  const engine = new DeltaEngine();
  engine.getStrategyPositionCapAssessment = async strategy => strategy === 'MOMENTUM'
    ? {status:'BLOCK',blocked:true,exposure:5,limit:5,reason:'Strategy position cap reached (MOMENTUM: 5/5); new entries blocked'}
    : {status:'PASS',blocked:false,exposure:0,limit:5,reason:''};
  const gate = await engine.riskGate(
    {...baseSignal},'MOMENTUM',
    {equity:1000,available:1000},
    {enabled:true,auto_trade:true,emergency_stop:false,continuous_mode:true},
    [],[]
  );
  assert.ok(gate.reasons.includes('Strategy position cap reached (MOMENTUM: 5/5); new entries blocked'));
});

test('worker risk gate checks Options_BUY and Options_SELL against the same Options cap', async () => {
  const engine = new DeltaEngine();
  const calls = [];
  engine.getStrategyPositionCapAssessment = async strategy => {
    calls.push(strategy);
    return {status:'BLOCK',blocked:true,exposure:4,limit:4,reason:'Strategy position cap reached (OPTIONS: 4/4); new entries blocked'};
  };
  const signal = { ...baseSignal, side:null, mark:10, ticker:{contract_value:1}, executionLocked:true };
  await engine.riskGate(signal,'OPTIONS_BUY',{equity:1000,available:1000},{enabled:true,auto_trade:true},[],[]);
  await engine.riskGate(signal,'OPTIONS_SELL',{equity:1000,available:1000},{enabled:true,auto_trade:true},[],[]);
  assert.deepEqual(calls,['OPTIONS_BUY','OPTIONS_SELL']);
});

test('worker keeps the Options execution lock and Grid single-position invariant', async () => {
  const { isOptionsExecutionAllowed } = await import('../worker/options-execution-lock.mjs');
  const { readFile } = await import('node:fs/promises');
  const gridSource = await readFile(new URL('../worker/execution/delta-grid-engine.mjs', import.meta.url),'utf8');
  assert.equal(isOptionsExecutionAllowed(),false);
  assert.match(gridSource,/GRID_SINGLE_POSITION_INVARIANT_BROKEN/);\n  assert.match(gridSource,/assessStrategyPositionCap/);
});
