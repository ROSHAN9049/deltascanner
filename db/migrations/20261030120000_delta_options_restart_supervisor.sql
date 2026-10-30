BEGIN;

-- A restart supervisor must be able to park a live Options group when exchange
-- positions, open orders, fills, or expiry state cannot be reconciled exactly.
-- This RPC never places an exchange order and cannot unlock the execution slot.
CREATE OR REPLACE FUNCTION public.mark_dd_options_group_reconciliation_required(
  p_group_id UUID,
  p_error_code TEXT,
  p_error_detail TEXT,
  p_raw JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group public.dd_options_execution_groups%ROWTYPE;
  v_error_code TEXT;
  v_error_detail TEXT;
  v_raw JSONB;
BEGIN
  v_error_code := UPPER(COALESCE(BTRIM(p_error_code), ''));
  v_error_detail := LEFT(COALESCE(BTRIM(p_error_detail), 'Options reconciliation is required'), 300);
  v_raw := COALESCE(p_raw, '{}'::JSONB);

  IF p_group_id IS NULL OR
     v_error_code !~ '^[A-Z0-9_]{4,64}$' OR
     jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Options reconciliation lock inputs are invalid';
  END IF;

  SELECT * INTO v_group
  FROM public.dd_options_execution_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Options execution group does not exist';
  END IF;

  IF v_group.state IN ('CLOSED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION 'Terminal Options execution group cannot be changed by the restart supervisor';
  END IF;

  UPDATE public.dd_options_execution_groups
  SET state = 'RECONCILIATION_REQUIRED',
      last_error_code = v_error_code,
      last_error_detail = v_error_detail,
      raw = COALESCE(raw, '{}'::JSONB) || v_raw ||
        jsonb_build_object(
          'reconciliation_required', TRUE,
          'reconciliation_marked_at', NOW()
        ),
      updated_at = NOW()
  WHERE id = p_group_id
  RETURNING * INTO v_group;

  RETURN jsonb_build_object(
    'group_id', v_group.id,
    'client_group_id', v_group.client_group_id,
    'state', v_group.state,
    'last_error_code', v_group.last_error_code,
    'updated_at', v_group.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_dd_options_group_reconciliation_required(UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_dd_options_group_reconciliation_required(UUID, TEXT, TEXT, JSONB)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
