-- Safe operator reset for NVDAXUSD Grid only.
-- This script never writes dd_delta_positions, dd_orders, dd_trades, or exchange orders.
-- Run only after the symbol-isolation Worker build is deployed and a fresh heartbeat
-- includes deltaExchangePositions. Any failed precondition aborts the transaction.

BEGIN;

DO $$
DECLARE
  v_settings public.dd_settings%ROWTYPE;
  v_heartbeat public.dd_engine_logs%ROWTYPE;
  v_exchange_positions jsonb;
  v_state jsonb;
  v_configs jsonb;
  v_paxg jsonb;
  v_nvdax jsonb;
  v_nvdax_reason text;
  v_grid_db_positions integer := 0;
  v_grid_db_orders integer := 0;
  v_nvdax_db_positions integer := 0;
  v_nvdax_legacy_positions integer := 0;
  v_nvdax_db_orders integer := 0;
  v_grid_state_exposure integer := 0;
BEGIN
  SELECT * INTO v_settings
  FROM public.dd_settings
  WHERE id = 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: dd_settings id=1 is missing';
  END IF;

  -- Require a recent exchange snapshot, not merely an old database ledger.
  SELECT * INTO v_heartbeat
  FROM public.dd_engine_logs
  WHERE message LIKE 'Worker heartbeat scan%'
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND OR v_heartbeat.created_at < NOW() - INTERVAL '2 minutes' THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: no Worker exchange-position heartbeat newer than 2 minutes';
  END IF;

  v_exchange_positions := v_heartbeat.data->'deltaExchangePositions';
  IF jsonb_typeof(v_exchange_positions) <> 'array' THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: heartbeat has no authenticated deltaExchangePositions array; deploy the snapshot build first';
  END IF;

  -- NVDAXUSD must be flat on the actual exchange.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_exchange_positions) AS p
    WHERE upper(COALESCE(p->>'symbol','')) = 'NVDAXUSD'
      AND abs(COALESCE(NULLIF(p->>'qty','')::numeric, 0)) > 0
  ) THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: exchange snapshot shows an open NVDAXUSD position';
  END IF;

  -- If PAXGUSD is open, it must be classified as Futures, never Grid/unknown.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_exchange_positions) AS p
    WHERE upper(COALESCE(p->>'symbol','')) = 'PAXGUSD'
      AND abs(COALESCE(NULLIF(p->>'qty','')::numeric, 0)) > 0
      AND upper(COALESCE(p->>'strategyGroup','UNCLASSIFIED')) <> 'FUTURES'
  ) THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: PAXGUSD exchange exposure is not positively classified as Futures';
  END IF;

  -- NVDAXUSD must have no open database position or unresolved order of any strategy.
  SELECT count(*) INTO v_nvdax_db_positions
  FROM public.dd_delta_positions
  WHERE upper(symbol) = 'NVDAXUSD' AND status = 'OPEN' AND abs(COALESCE(qty,0)) > 0;

  IF v_nvdax_db_positions <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: NVDAXUSD has % open dd_delta_positions rows', v_nvdax_db_positions;
  END IF;

  SELECT count(*) INTO v_nvdax_legacy_positions
  FROM public.dd_positions
  WHERE upper(symbol) = 'NVDAXUSD' AND abs(COALESCE(qty,0)) > 0;

  IF v_nvdax_legacy_positions <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: NVDAXUSD has % open legacy dd_positions rows', v_nvdax_legacy_positions;
  END IF;

  SELECT count(*) INTO v_nvdax_db_orders
  FROM public.dd_orders
  WHERE upper(symbol) = 'NVDAXUSD'
    AND upper(COALESCE(state,'')) NOT IN
      ('FILLED','CLOSED','CANCELLED','CANCELED','REJECTED','FAILED','EXPIRED','EXITED','COMPLETE','COMPLETED');

  IF v_nvdax_db_orders <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: NVDAXUSD has % unresolved dd_orders rows', v_nvdax_db_orders;
  END IF;

  -- No Grid-owned position or unresolved Grid order may exist on either symbol.
  SELECT count(*) INTO v_grid_db_positions
  FROM public.dd_delta_positions
  WHERE upper(symbol) IN ('PAXGUSD','NVDAXUSD')
    AND (
      upper(COALESCE(strategy,'')) = 'GRID'
      OR upper(COALESCE(client_order_id,'')) LIKE 'DDG-%'
    )
    AND status = 'OPEN' AND abs(COALESCE(qty,0)) > 0;

  IF v_grid_db_positions <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: found % open Grid-owned position rows on PAXGUSD/NVDAXUSD', v_grid_db_positions;
  END IF;

  SELECT count(*) INTO v_grid_db_orders
  FROM public.dd_orders
  WHERE upper(symbol) IN ('PAXGUSD','NVDAXUSD')
    AND (
      upper(COALESCE(strategy,'')) = 'GRID'
      OR upper(COALESCE(client_order_id,'')) LIKE 'DDG-%'
      OR upper(COALESCE(raw->>'strategy','')) = 'GRID'
    )
    AND upper(COALESCE(state,'')) NOT IN
      ('FILLED','CLOSED','CANCELLED','CANCELED','REJECTED','FAILED','EXPIRED','EXITED','COMPLETE','COMPLETED');

  IF v_grid_db_orders <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: found % unresolved Grid orders on PAXGUSD/NVDAXUSD', v_grid_db_orders;
  END IF;

  -- Also guard persisted Grid state arrays, including reservations not yet reflected in dd_orders.
  SELECT
    COALESCE(jsonb_array_length(v_settings.grid_state #> '{symbolStates,PAXGUSD,positions}'),0) +
    COALESCE(jsonb_array_length(v_settings.grid_state #> '{symbolStates,NVDAXUSD,positions}'),0) +
    COALESCE(jsonb_array_length(v_settings.grid_state #> '{symbolStates,PAXGUSD,pendingEntries}'),0) +
    COALESCE(jsonb_array_length(v_settings.grid_state #> '{symbolStates,NVDAXUSD,pendingEntries}'),0) +
    (SELECT count(*)::integer
       FROM jsonb_array_elements(COALESCE(v_settings.grid_state->'positions','[]'::jsonb)) AS p
      WHERE upper(COALESCE(p->>'symbol','')) IN ('PAXGUSD','NVDAXUSD')
        AND abs(COALESCE(NULLIF(p->>'qty','')::numeric,0)) > 0) +
    (SELECT count(*)::integer
       FROM jsonb_array_elements(COALESCE(v_settings.grid_state->'pendingEntries','[]'::jsonb)) AS p
      WHERE upper(COALESCE(p->>'symbol','')) IN ('PAXGUSD','NVDAXUSD')
         OR COALESCE(p->>'symbol','') = '')
  INTO v_grid_state_exposure;

  IF v_grid_state_exposure <> 0 THEN
    RAISE EXCEPTION 'SAFE RESET REFUSED: persisted Grid state contains % position/reservation entries on PAXGUSD/NVDAXUSD', v_grid_state_exposure;
  END IF;

  -- Keep PAXG's Grid manual-review state intact; only set its config pause flag.
  v_configs := COALESCE(v_settings.grid_symbol_configs, '{}'::jsonb);
  v_paxg := COALESCE(v_configs->'PAXGUSD', '{}'::jsonb);
  v_nvdax := COALESCE(v_configs->'NVDAXUSD', '{}'::jsonb);
  v_configs := jsonb_set(v_configs, '{PAXGUSD}', v_paxg || '{"paused":true}'::jsonb, true);
  v_configs := jsonb_set(v_configs, '{NVDAXUSD}', v_nvdax || '{"paused":false}'::jsonb, true);

  -- Clear only NVDAXUSD's trailing-shift manual-review latch, if that is its current reason.
  v_state := COALESCE(v_settings.grid_state, '{}'::jsonb);
  v_nvdax_reason := v_state #>> '{symbolStates,NVDAXUSD,pausedReason}';
  IF v_nvdax_reason = 'GRID_TRAILING_SHIFT_UNCONFIRMED' THEN
    v_state := jsonb_set(v_state, '{symbolStates,NVDAXUSD,pausedReason}', 'null'::jsonb, true);
    v_state := jsonb_set(v_state, '{symbolStates,NVDAXUSD,status}', '"PENDING"'::jsonb, true);
    v_state := jsonb_set(v_state, '{symbolStates,NVDAXUSD,skipReason}', 'null'::jsonb, true);
    v_state := jsonb_set(v_state, '{symbolStates,NVDAXUSD,trailingShiftManualResetRequired}', 'false'::jsonb, true);
    v_state := jsonb_set(v_state, '{symbolStates,NVDAXUSD,trailingShiftFailureTimestamps}', '[]'::jsonb, true);
  END IF;

  UPDATE public.dd_settings
  SET grid_symbol_configs = v_configs,
      grid_state = v_state,
      updated_at = NOW()
  WHERE id = 1;

  RAISE NOTICE 'Grid safe reset applied: PAXGUSD paused; NVDAXUSD unpaused; NVDAXUSD prior reason was %',
    COALESCE(v_nvdax_reason, '<none>');
END
$$;

-- Read-back values. Root status is reported as stored; the next Worker cycle
-- will recompute the aggregate from the per-symbol states.
SELECT
  grid_symbol_configs->'PAXGUSD'->>'paused' AS paxg_paused,
  grid_symbol_configs->'NVDAXUSD'->>'paused' AS nvdax_paused,
  grid_state #>> '{symbolStates,NVDAXUSD,pausedReason}' AS nvdax_pause_reason,
  grid_state->>'status' AS root_grid_status
FROM public.dd_settings
WHERE id = 1;

COMMIT;
