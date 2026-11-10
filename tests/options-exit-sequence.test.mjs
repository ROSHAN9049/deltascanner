import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDefinedRiskSellExit } from '../worker/options-exit-sequence.mjs';

test('SELL exit confirms short buyback fill before closing protective hedge', async () => {
  const events = [];
  const result = await executeDefinedRiskSellExit({
    quantity: 2,
    closeShort: async () => {
      events.push('SHORT_BUYBACK_SUBMITTED');
      events.push('SHORT_BUYBACK_FILLED');
      return {
        order: { id: 'short-close-1' },
        fill: { fullyFilled: true, filledQty: 2, averageFillPrice: 42.5 }
      };
    },
    closeHedge: async ({ shortOrder, shortFill }) => {
      assert.equal(shortOrder.id, 'short-close-1');
      assert.equal(shortFill.fullyFilled, true);
      assert.equal(shortFill.filledQty, 2);
      events.push('HEDGE_CLOSE_SUBMITTED');
      return { closed: true };
    }
  });
  assert.deepEqual(events, [
    'SHORT_BUYBACK_SUBMITTED', 'SHORT_BUYBACK_FILLED', 'HEDGE_CLOSE_SUBMITTED'
  ]);
  assert.deepEqual(result, { closed: true });
});

test('SELL exit never closes hedge when short buyback fill is unconfirmed', async () => {
  let hedgeCloseCalls = 0;
  await assert.rejects(executeDefinedRiskSellExit({
    quantity: 1,
    closeShort: async () => ({ fullyFilled: false, filledQty: 0, averageFillPrice: null }),
    closeHedge: async () => { hedgeCloseCalls += 1; }
  }), error => error.code === 'OPTIONS_SHORT_EXIT_UNCONFIRMED');
  assert.equal(hedgeCloseCalls, 0);
});
