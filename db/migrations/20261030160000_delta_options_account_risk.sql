BEGIN;

-- Do not guess settlement assets for legacy rows. New reservations must carry
-- a product-catalogue-verified settlement asset in their immutable raw data.
ALTER TABLE public.dd_options_execution_groups
  ADD COLUMN IF NOT EXISTS settlement_asset TEXT NULL;
ALTER TABLE public.dd_options_execution_legs
  ADD COLUMN IF NOT EXISTS settlement_asset TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dd_options_groups_settlement_asset_check'
      AND conrelid = 'public.dd_options_execution_groups'::regclass
  ) THEN
    ALTER TABLE public.dd_options_execution_groups
      ADD CONSTRAINT dd_options_groups_settlement_asset_check
      CHECK (settlement_asset IS NULL OR settlement_asset = 'USD');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dd_options_legs_settlement_asset_check'
      AND conrelid = 'public.dd_options_execution_legs'::regclass
  ) THEN
    ALTER TABLE public.dd_options_execution_legs
      ADD CONSTRAINT dd_options_legs_settlement_asset_check
      CHECK (settlement_asset IS NULL OR settlement_asset = 'USD');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_dd_options_group_settlement_asset()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw_asset TEXT;
BEGIN
  v_raw_asset := UPPER(COALESCE(NEW.raw->>'settlement_asset', ''));
  IF v_raw_asset <> 'USD' THEN
    RAISE EXCEPTION 'Options group requires a verified USD settlement asset in raw product evidence';
  END IF;
  IF NEW.settlement_asset IS NOT NULL AND UPPER(NEW.settlement_asset) <> v_raw_asset THEN
    RAISE EXCEPTION 'Options group settlement asset does not match its product evidence';
  END IF;
  NEW.settlement_asset := v_raw_asset;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_dd_options_leg_settlement_asset()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw_asset TEXT;
  v_group_asset TEXT;
BEGIN
  v_raw_asset := UPPER(COALESCE(NEW.raw->>'settlement_asset', ''));
  SELECT settlement_asset INTO v_group_asset
  FROM public.dd_options_execution_groups
  WHERE id = NEW.group_id;

  IF v_raw_asset <> 'USD' OR v_group_asset IS DISTINCT FROM v_raw_asset THEN
    RAISE EXCEPTION 'Options leg settlement asset must match the verified USD group settlement asset';
  END IF;
  IF NEW.settlement_asset IS NOT NULL AND UPPER(NEW.settlement_asset) <> v_raw_asset THEN
    RAISE EXCEPTION 'Options leg settlement asset does not match its product evidence';
  END IF;
  NEW.settlement_asset := v_raw_asset;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_dd_options_group_settlement_asset()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_dd_options_leg_settlement_asset()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS dd_options_group_settlement_asset_guard
  ON public.dd_options_execution_groups;
CREATE TRIGGER dd_options_group_settlement_asset_guard
  BEFORE INSERT OR UPDATE OF settlement_asset
  ON public.dd_options_execution_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.set_dd_options_group_settlement_asset();

DROP TRIGGER IF EXISTS dd_options_leg_settlement_asset_guard
  ON public.dd_options_execution_legs;
CREATE TRIGGER dd_options_leg_settlement_asset_guard
  BEFORE INSERT OR UPDATE OF settlement_asset
  ON public.dd_options_execution_legs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_dd_options_leg_settlement_asset();

NOTIFY pgrst, 'reload schema';
COMMIT;
