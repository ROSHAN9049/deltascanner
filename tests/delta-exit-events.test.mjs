import test from 'node:test';
import assert from 'node:assert/strict';
import { deltaCloseFields, normalizeDeltaExitReason } from '../worker/execution/delta-exit-events.mjs';

test('exit reason mapping uses documented fill/order evidence', () => {
  const cases = [
    [{ stop_order_type: 'stop_loss_order' }, 'stop_loss_order'],
    [{ stop_order_type: 'take_profit_order' }, 'take_profit_order'],
    [{ fill_type: 'liquidation' }, 'liquidation'],
    [{ fill_type: 'adl' }, 'adl'],
    [{ fill_type: 'settlement' }, 'settlement'],
    [{ client_order_id: 'DDX-X-BTCUSD-close' }, 'bot-exit'],
    [{ close_order_history_found: true }, 'manual-or-external'],
    [{}, 'unknown']
  ];
  for (const [event, expected] of cases) {
    assert.equal(normalizeDeltaExitReason(event), expected);
  }
});

test('missing close details remain null and mark price never becomes exit price', () => {
  const fields = deltaCloseFields({ current_price: 4050, unrealized_pnl: -6.73 });
  assert.equal(fields.exit_price, null);
  assert.equal(fields.fees, null);
  assert.equal(fields.fee_currency, null);
  assert.equal(fields.realized_pnl, null);
  assert.equal(fields.exit_reason, 'unknown');
  assert.equal(fields.close_order_id, null);
});

test('verified close details take precedence over unverified event fields', () => {
  const fields = deltaCloseFields({
    current_price: 4050,
    realized_pnl: 0,
    order_id: 'entry-order'
  }, {
    exit_price: 4060,
    fees: 0.15,
    fee_currency: 'USD',
    realized_pnl: 3.25,
    close_order_id: 9001,
    stop_order_type: 'take_profit_order',
    close_order_history_found: true
  });
  assert.equal(fields.exit_price, 4060);
  assert.equal(fields.fees, 0.15);
  assert.equal(fields.fee_currency, 'USD');
  assert.equal(fields.realized_pnl, 3.25);
  assert.equal(fields.exit_reason, 'take_profit_order');
  assert.equal(fields.close_order_id, '9001');
});
