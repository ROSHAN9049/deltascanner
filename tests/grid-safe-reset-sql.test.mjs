import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../docs/sql/grid-nvdax-safe-reset.sql', import.meta.url), 'utf8');

test('NVDAX safe reset is transactional and updates only dd_settings', () => {
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+public\.(?:dd_delta_positions|dd_orders|dd_trades)\b/i);
  assert.match(sql, /grid_symbol_configs\s*=\s*v_configs/i);
  assert.match(sql, /grid_state\s*=\s*v_state/i);
});

test('NVDAX safe reset requires fresh exchange-flat and database-flat preconditions', () => {
  assert.match(sql, /deltaExchangePositions/);
  assert.match(sql, /INTERVAL '2 minutes'/);
  assert.match(sql, /exchange snapshot shows an open NVDAXUSD position/);
  assert.match(sql, /NVDAXUSD has % open dd_delta_positions rows/);
  assert.match(sql, /NVDAXUSD has % open legacy dd_positions rows/);
  assert.match(sql, /NVDAXUSD has % unresolved dd_orders rows/);
});

test('NVDAX safe reset refuses Grid positions and pending orders on both symbols', () => {
  assert.match(sql, /upper\(symbol\) IN \('PAXGUSD','NVDAXUSD'\)/);
  assert.match(sql, /DDG-%/);
  assert.match(sql, /persisted Grid state contains % position\/reservation entries/);
  assert.match(sql, /expected open PAXGUSD Futures position is missing or unclassified/);
  assert.match(sql, /PAXGUSD exchange exposure is not positively classified as Futures/);
});

test('NVDAX safe reset pauses PAXG and only clears the NVDAX trailing-shift latch', () => {
  assert.match(sql, /v_paxg \|\| '\{"paused":true\}'::jsonb/);
  assert.match(sql, /v_nvdax \|\| '\{"paused":false\}'::jsonb/);
  assert.match(sql, /v_nvdax_reason = 'GRID_TRAILING_SHIFT_UNCONFIRMED'/);
  assert.match(sql, /symbolStates,NVDAXUSD,pausedReason/);
  assert.match(sql, /symbolStates,NVDAXUSD,trailingShiftManualResetRequired/);
  assert.doesNotMatch(sql, /symbolStates,PAXGUSD,pausedReason/);
});
