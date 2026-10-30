BEGIN;

-- Keep expiry exposure distinct from a data-integrity reconciliation lock.
-- EXIT_REQUIRED allows only DB-authorized EXIT/UNWIND attempts; it never
-- enables execution by itself.
ALTER TABLE public.dd_options_execution_groups
  DROP CONSTRAINT IF EXISTS dd_options_execution_groups_state_check;

ALTER TABLE public.dd_options_execution_groups
  ADD CONSTRAINT dd_options_execution_groups_state_check
  CHECK (state IN (
    'RESERVED',
    'BUY_ENTRY_PENDING',
    'HEDGE_ENTRY_PENDING',
    'SHORT_ENTRY_PENDING',
    'OPEN',
    'LONG_EXIT_PENDING',
    'SHORT_EXIT_PENDING',
    'HEDGE_EXIT_PENDING',
    'UNWIND_PENDING',
    'EXIT_REQUIRED',
    'RECONCILIATION_REQUIRED',
    'CLOSED',
    'REJECTED',
    'FAILED'
  ));

CREATE OR REPLACE FUNCTION public.mark_dd_options_group_expiry_exit_required(
  p_group_id UUID,
  p_expiry_at TIMESTAMPTZ,
  p_minutes_before_expiry INTEGER,
  p_open_qty NUMERIC,
  p_raw JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.dd_options_execution_groups%ROWTYPE;
  v_open_qty NUMERIC;
  v_active_orders INTEGER;
  v_raw JSONB;
BEGIN
  IF p_group_id IS NULL OR p_expiry_at IS NULL OR
     p_minutes_before_expiry IS NULL OR p_minutes_before_expiry < 5 OR
     p_minutes_before_expiry > 240 OR
     p_open_qty IS NULL OR p_open_qty <= 0 OR
     jsonb_typeof(COALESCE(p_raw, '{}'::JSONB)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Options expiry exit inputs are invalid';
  END IF;

  SELECT * INTO v_group
  FROM public.dd_options_execution_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Options execution group does not exist';
  END IF;

  IF v_group.state IN ('CLOSED', 'REJECTED', 'FAILED', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'Terminal or reconciliation-locked Options group cannot enter expiry exit';
  END IF;

  IF v_group.expiry_at IS DISTINCT FROM p_expiry_at OR
     NOW() < v_group.expiry_at - make_interval(mins => p_minutes_before_expiry) THEN
    RAISE EXCEPTION 'Options expiry deadline is not due for the persisted expiry';
  END IF;

  SELECT COALESCE(SUM(GREATEST(0, filled_qty - exit_filled_qty)), 0)
  INTO v_open_qty
  FROM public.dd_options_execution_legs
  WHERE group_id = p_group_id;

  IF v_open_qty <= 0 OR ABS(v_open_qty - p_open_qty) > 0.00000001 THEN
    RAISE EXCEPTION 'Options expiry exit quantity differs from the persisted leg fill ledger';
  END IF;

  SELECT COUNT(*) INTO v_active_orders
  FROM public.dd_options_execution_orders
  WHERE group_id = p_group_id
    AND order_state IN (
      'RESERVED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED',
      'UNKNOWN', 'RECONCILIATION_REQUIRED'
    );

  IF v_active_orders > 0 THEN
    RAISE EXCEPTION 'Options expiry exit cannot begin while an order attempt is unresolved';
  END IF;

  v_raw := COALESCE(p_raw, '{}'::JSONB) || jsonb_build_object(
    'expiry_exit_required', TRUE,
    'expiry_exit_marked_at', NOW(),
    'expiry_at', v_group.expiry_at,
    'minutes_before_expiry', p_minutes_before_expiry,
    'open_qty', v_open_qty
  );

  UPDATE public.dd_options_execution_groups
  SET state = 'EXIT_REQUIRED',
      last_error_code = 'OPTIONS_EXPIRY_EXIT_REQUIRED',
      last_error_detail = 'Mandatory supervised reduce-only exit is due before Options settlement',
      raw = COALESCE(raw, '{}'::JSONB) || v_raw,
      updated_at = NOW()
  WHERE id = p_group_id
  RETURNING * INTO v_group;

  RETURN jsonb_build_object(
    'group_id', v_group.id,
    'client_group_id', v_group.client_group_id,
    'state', v_group.state,
    'last_error_code', v_group.last_error_code,
    'expiry_at', v_group.expiry_at,
    'open_qty', v_open_qty,
    'updated_at', v_group.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_dd_options_group_expiry_exit_required(UUID, TIMESTAMPTZ, INTEGER, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_dd_options_group_expiry_exit_required(UUID, TIMESTAMPTZ, INTEGER, NUMERIC, JSONB)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
