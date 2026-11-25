import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBracketChildOrderIds } from '../worker/execution/bracket-child-order-ids.mjs';

test('resolves matching reduce-only SL and TP child IDs, never parent IDs', () => {
  const result = resolveBracketChildOrderIds([
    { id: 100, product_id: 9, size: 63, stop_order_type: 'stop_loss_order', stop_price: '3615.31', reduce_only: true },
    { id: 101, product_id: 9, size: 63, stop_order_type: 'take_profit_order', stop_price: '3428.29', reduce_only: true },
    { id: 99, product_id: 9, size: 63, role: 'ENTRY' }
  ], { productId: 9, qty: 63, stopPrice: 3615.31, takeProfitPrice: 3428.29 });
  assert.deepEqual(result, { stopLossOrderId: '100', takeProfitOrderId: '101' });
});

test('does not link wrong product, wrong size, or wrong trigger orders', () => {
  const result = resolveBracketChildOrderIds([
    { id: 100, product_id: 9, size: 62, stop_order_type: 'stop_loss_order', stop_price: '3615.31', reduce_only: true },
    { id: 101, product_id: 10, size: 63, stop_order_type: 'take_profit_order', stop_price: '3428.29', reduce_only: true },
    { id: 102, product_id: 9, size: 63, stop_order_type: 'take_profit_order', stop_price: '3430', reduce_only: true }
  ], { productId: 9, qty: 63, stopPrice: 3615.31, takeProfitPrice: 3428.29 });
  assert.deepEqual(result, { stopLossOrderId: null, takeProfitOrderId: null });
});
