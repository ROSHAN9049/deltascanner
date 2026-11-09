import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBestOptionCandidates } from '../worker/options-candidate-selection.mjs';

test('confirmed, analysis-ready option replaces a higher-scoring setup option for the same underlying and strategy', () => {
  const setup = {
    underlyingSymbol: 'BTCUSD',
    strategy: 'OPTIONS_BUY',
    symbol: 'C-BTC-80000-131126',
    stage: 'SETUP',
    analysisReady: false,
    score: 95
  };
  const confirmed = {
    underlyingSymbol: 'BTC',
    strategy: 'OPTIONS_BUY',
    symbol: 'C-BTC-81000-131126',
    stage: 'CONFIRMED',
    analysisReady: true,
    score: 85
  };

  const selected = selectBestOptionCandidates([setup, confirmed]);

  assert.equal(selected.size, 1);
  assert.equal(selected.get('BTC:OPTIONS_BUY'), confirmed);
  assert.equal(selected.get('BTC:OPTIONS_BUY').symbol, 'C-BTC-81000-131126');
});

test('score decides between candidates with the same confirmation and readiness status', () => {
  const lower = {
    underlyingSymbol: 'ETHUSD',
    strategy: 'OPTIONS_BUY',
    symbol: 'C-ETH-2400-131126',
    stage: 'CONFIRMED',
    analysisReady: true,
    score: 84
  };
  const higher = {
    ...lower,
    symbol: 'C-ETH-2500-131126',
    score: 91
  };

  assert.equal(
    selectBestOptionCandidates([lower, higher]).get('ETH:OPTIONS_BUY'),
    higher
  );
});
