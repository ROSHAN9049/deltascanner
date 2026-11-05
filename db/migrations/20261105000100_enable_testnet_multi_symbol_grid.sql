BEGIN;

ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS grid_symbol_configs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.dd_settings.grid_symbol_configs IS
  'Per-symbol Grid boundaries and level counts for the two-symbol Delta India Testnet Grid.';

NOTIFY pgrst, 'reload schema';
COMMIT;
