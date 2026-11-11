-- Safe Grid ownership reset for the PAXGUSD / NVDAXUSD split.
-- This script only updates public.dd_settings (grid_symbol_configs + one
-- NVDAXUSD symbol-state reason). It never updates/deletes dd_delta_positions,
-- dd_orders, dd_trades, or any exchange-side position/bracket/SL/TP.
--
-- Guard reads are intentionally restricted:
--   * dd_delta_positions: only NVDAXUSD flatness + strategy='GRID' rows
--     for both symbols. PAXGUSD Futures (MOMENTUM/SCALPING) rows are never read.
--   * dd_orders: read-only checks for unresolved Grid orders on both symbols
--     and any unresolved NVDAXUSD order. Nothing in dd_orders is modified.
--
-- Run only after the isolation build is deployed and after the operator has
-- independently confirmed NVDAXUSD is flat on Delta Testnet.

BEGIN;

DO $grid_reset$
DECLARE
  v_settings public.dd_settings%ROWTYPE;
  v_nvdax_open_positions integer := 0;
  v_nvdax_unresolved_orders integer := 0;
  v_grid_open_positions integer := 0;
  v_grid_unresolved_orders integer := 0;
  v_local_grid_exposure integer := 0;
  v_terminal_states constant text[] := ARRAY[
    'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'REJECTED',
    'FAILED', 'EXPIRED', 'EXITED', 'COMPLETE', 'COMPLETED'
  ];
BEGIN
  SELECT *
    INTO v_settings
    FROM public.dd_settings
   WHERE id = 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: public.dd_settings id=1 is missing';
  END IF;

  -- NVDAXUSD must be flat for every recorded strategy.
  SELECT count(*)
    INTO v_nvdax_open_positions
    FROM public.dd_delta_positions
   WHERE upper(symbol) = 'NVDAXUSD'
     AND upper(status) = 'OPEN'
     AND abs(coalesce(qty, 0)) > 0;

  IF v_nvdax_open_positions <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: NVDAXUSD has % open position row(s)',
      v_nvdax_open_positions;
  END IF;

  -- dd_positions is the legacy/current Futures position ledger. Treat any
  -- NVDAXUSD positive-quantity row as exposure; Grid-owned rows on either
  -- symbol also block. PAXGUSD non-Grid strategy rows are never selected.
  IF EXISTS (
    SELECT 1
      FROM public.dd_positions
     WHERE upper(symbol) = 'NVDAXUSD'
       AND abs(coalesce(qty, 0)) > 0
  ) THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: dd_positions still has NVDAXUSD exposure';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.dd_positions
     WHERE upper(symbol) IN ('PAXGUSD', 'NVDAXUSD')
       AND upper(strategy) = 'GRID'
       AND abs(coalesce(qty, 0)) > 0
  ) THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: dd_positions contains Grid-owned exposure on PAXGUSD/NVDAXUSD';
  END IF;

  -- No unresolved exchange order/reservation may remain on NVDAXUSD.
  SELECT count(*)
    INTO v_nvdax_unresolved_orders
    FROM public.dd_orders
   WHERE upper(symbol) = 'NVDAXUSD'
     AND coalesce(upper(state), 'UNKNOWN') <> ALL (v_terminal_states);

  IF v_nvdax_unresolved_orders <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: NVDAXUSD has % unresolved order row(s)',
      v_nvdax_unresolved_orders;
  END IF;

  -- Never reset while any Grid-owned open exposure exists on either symbol.
  -- PAXGUSD rows for other strategies are excluded from this guard by design.
  SELECT count(*)
    INTO v_grid_open_positions
    FROM public.dd_delta_positions
   WHERE upper(symbol) IN ('PAXGUSD', 'NVDAXUSD')
     AND upper(strategy) = 'GRID'
     AND upper(status) = 'OPEN'
     AND abs(coalesce(qty, 0)) > 0;

  IF v_grid_open_positions <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: found % Grid-owned open position row(s) on PAXGUSD/NVDAXUSD',
      v_grid_open_positions;
  END IF;

  -- No unresolved Grid order of any role (entry, exit, bracket, etc.) on
  -- either symbol. Null/unknown state is non-terminal and therefore blocks.
  SELECT count(*)
    INTO v_grid_unresolved_orders
    FROM public.dd_orders
   WHERE upper(symbol) IN ('PAXGUSD', 'NVDAXUSD')
     AND upper(strategy) = 'GRID'
     AND coalesce(upper(state), 'UNKNOWN') <> ALL (v_terminal_states);

  IF v_grid_unresolved_orders <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: found % unresolved Grid order row(s) on PAXGUSD/NVDAXUSD',
      v_grid_unresolved_orders;
  END IF;

  -- Fail closed on any in-memory Grid reservations/positions still persisted
  -- in either symbol's state, even if corresponding DB rows are absent.
  SELECT
    coalesce(jsonb_array_length(v_settings.grid_state #> '{symbolStates,PAXGUSD,positions}'), 0) +
    coalesce(jsonb_array_length(v_settings.grid_state #> '{symbolStates,PAXGUSD,pendingEntries}'), 0) +
    coalesce(jsonb_array_length(v_settings.grid_state #> '{symbolStates,NVDAXUSD,positions}'), 0) +
    coalesce(jsonb_array_length(v_settings.grid_state #> '{symbolStates,NVDAXUSD,pendingEntries}'), 0)
    INTO v_local_grid_exposure;

  IF v_local_grid_exposure <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: persisted per-symbol Grid positions/pending entries count is %',
      v_local_grid_exposure;
  END IF;

  -- Also fail closed if the legacy/root aggregate still contains a Grid
  -- position or pending entry not reflected in per-symbol state.
  IF coalesce(jsonb_array_length(v_settings.grid_state->'positions'), 0) <> 0 OR
     coalesce(jsonb_array_length(v_settings.grid_state->'pendingEntries'), 0) <> 0 THEN
    RAISE EXCEPTION 'SAFE GRID RESET REFUSED: root Grid state still contains positions or pending entries';
  END IF;

  -- Only dd_settings is written. Keep all ATR/range/manual-review fields.
  -- PAXGUSD is paused permanently until the operator explicitly edits paused
  -- to false after Futures is flat and has been independently verified.
  UPDATE public.dd_settings
     SET grid_symbol_configs =
       jsonb_set(
         jsonb_set(
           coalesce(grid_symbol_configs, '{}'::jsonb),
           '{PAXGUSD}',
           coalesce(grid_symbol_configs->'PAXGUSD', '{}'::jsonb) ||
             jsonb_build_object('paused', true),
           true
         ),
         '{NVDAXUSD}',
         coalesce(
           jsonb_set(
             coalesce(grid_symbol_configs->'NVDAXUSD', '{}'::jsonb),
             '{paused}', 'false'::jsonb, true
           ),
           '{}'::jsonb
         ),
         true
       ),
       grid_state =
         CASE
           WHEN grid_state #>> '{symbolStates,NVDAXUSD,pausedReason}' =
                'GRID_TRAILING_SHIFT_UNCONFIRMED'
           THEN jsonb_set(
             jsonb_set(
               jsonb_set(
                 grid_state,
                 '{symbolStates,NVDAXUSD,pausedReason}',
                 'null'::jsonb,
                 true
               ),
               '{symbolStates,NVDAXUSD,status}',
               to_jsonb('PENDING'::text),
               true
             ),
             '{symbolStates,NVDAXUSD,trailingShiftManualResetRequired}',
             'false'::jsonb,
             true
           )
           ELSE grid_state
         END,
       updated_at = now()
   WHERE id = 1;
END
$grid_reset$;

-- Returned postconditions. Historical HALT events are deliberately retained
-- for audit; only NVDAXUSD's active pausedReason is cleared when it equals the
-- exact trailing-shift failure code.
SELECT
  (grid_symbol_configs #>> '{PAXGUSD,paused}')::boolean AS paxg_paused,
  (grid_symbol_configs #>> '{NVDAXUSD,paused}')::boolean AS nvdax_paused,
  grid_state #>> '{symbolStates,NVDAXUSD,pausedReason}' AS nvdax_pause_reason,
  grid_state->>'status' AS root_grid_status
FROM public.dd_settings
WHERE id = 1;

COMMIT;
