BEGIN;

ALTER TABLE public.dd_option_cache
  ADD COLUMN IF NOT EXISTS iv_delta_bucket TEXT NULL,
  ADD COLUMN IF NOT EXISTS iv_dte_bucket TEXT NULL;

ALTER TABLE public.dd_iv_history
  ADD COLUMN IF NOT EXISTS option_type TEXT NULL
    CHECK (option_type IN ('CALL', 'PUT')),
  ADD COLUMN IF NOT EXISTS delta_bucket TEXT NULL,
  ADD COLUMN IF NOT EXISTS dte_bucket TEXT NULL,
  ADD COLUMN IF NOT EXISTS delta_value NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS dte NUMERIC NULL;

CREATE INDEX IF NOT EXISTS dd_iv_history_group_observed_idx
  ON public.dd_iv_history (
    underlying, option_type, delta_bucket, dte_bucket, observed_at DESC
  );

COMMENT ON COLUMN public.dd_iv_history.option_type IS
  'Normalized option type used to share IV history across expiring contract symbols.';
COMMENT ON COLUMN public.dd_iv_history.delta_bucket IS
  'Absolute option delta bucket; historical rows without captured delta remain NULL and are excluded.';
COMMENT ON COLUMN public.dd_iv_history.dte_bucket IS
  'Days-to-expiry tenor bucket; allows IV history to roll across expiry symbols.';
COMMENT ON COLUMN public.dd_iv_history.delta_value IS
  'Absolute observed option delta used to assign delta_bucket.';
COMMENT ON COLUMN public.dd_iv_history.dte IS
  'Days to expiry at observation time.';

NOTIFY pgrst, 'reload schema';
COMMIT;
