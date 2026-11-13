import test from 'node:test';
import assert from 'node:assert/strict';
import { deltaCloseFields, normalizeDeltaExitReason } from '../worker/execution/delta-exit-events.mjs';

test('exit reason mapping uses documented fill/order evidence', () => {
  const cases = [
    [{ reason: 'Stop Loss Order' }, 'SL'],
    [{ stop_order_type: 'stop_loss_order' }, 'SL'],
    [{ stop_order_type: 'take_profit_order' }, 'TP'],
    [{ fill_type: 'liquidation' }, 'LIQUIDATION'],
    [{ fill_type: 'adl' }, 'ADL'],
    [{ fill_type: 'settlement' }, 'SETTLEMENT'],
    [{ client_order_id: 'DDX-X-BTCUSD-close' }, 'BOT'],
    [{ client_order_id: 'OSL-BTCUSD-protection' }, 'SL'],
    [{ client_order_id: 'OSLBE-BTCUSD-protection' }, 'SL'],
    [{ client_order_id: 'OTP-BTCUSD-protection' }, 'TP'],
    [{ client_order_id: 'OTP1-BTCUSD-protection' }, 'TP'],
    [{ close_reason: 'stop_loss_order' }, 'SL'],
    [{ close_reason: 'take_profit_order' }, 'TP'],
    [{ meta_data: { close_reason: 'liquidation' } }, 'LIQUIDATION'],
    [{ client_order_id: 'manual-close-9001' }, 'MANUAL'],
    [{ close_order_history_found: true }, 'MANUAL'],
    [{}, 'UNKNOWN']
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
  assert.equal(fields.exit_reason, 'UNKNOWN');
  assert.equal(fields.close_order_id, null);
  const entryOrderOnly = deltaCloseFields({ order_id: 'entry-order', current_price: 4050 });
  assert.equal(entryOrderOnly.close_order_id, null);
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
  assert.equal(fields.exit_reason, 'TP');
  assert.equal(fields.close_order_id, '9001');
});

test('explicit requested exit reason fills UNKNOWN client-order attribution without overriding exchange stop evidence', () => {
  assert.equal(normalizeDeltaExitReason({
    client_order_id: 'CLS-BTCUSD-timeout',
    requested_exit_reason: 'TIMEOUT'
  }), 'TIMEOUT');
  assert.equal(normalizeDeltaExitReason({
    client_order_id: 'CLS-BTCUSD-timeout',
    requested_exit_reason: 'TIMEOUT',
    stop_order_type: 'stop_loss_order'
  }), 'SL');
});

test('nested Delta fill metadata is used to classify stop and take-profit exits', () => {
  assert.equal(normalizeDeltaExitReason({
    meta_data: { order_type: 'stop_loss_order' }
  }), 'SL');
  assert.equal(normalizeDeltaExitReason({
    metadata: { stop_order_type: 'take_profit_order' }
  }), 'TP');
});
