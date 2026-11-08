BEGIN;

ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS grid_trailing_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.dd_settings.grid_trailing_enabled IS
  'Explicit dashboard opt-in for the environment-gated Delta Testnet Trailing Grid; defaults off.';

NOTIFY pgrst, 'reload schema';
COMMIT;
