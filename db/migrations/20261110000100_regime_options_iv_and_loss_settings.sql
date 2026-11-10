BEGIN;

ALTER TABLE public.dd_option_cache
  ADD COLUMN IF NOT EXISTS iv_current NUMERIC NULL;

ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS options_iv_rank_buy_max NUMERIC NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS options_iv_rank_sell_min NUMERIC NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS options_daily_loss_limit_pct NUMERIC NOT NULL DEFAULT 2.0;

ALTER TABLE public.dd_settings
  DROP CONSTRAINT IF EXISTS dd_settings_options_iv_rank_buy_max_check,
  DROP CONSTRAINT IF EXISTS dd_settings_options_iv_rank_sell_min_check,
  DROP CONSTRAINT IF EXISTS dd_settings_options_daily_loss_limit_pct_check;

ALTER TABLE public.dd_settings
  ADD CONSTRAINT dd_settings_options_iv_rank_buy_max_check
    CHECK (options_iv_rank_buy_max >= 0 AND options_iv_rank_buy_max <= 100),
  ADD CONSTRAINT dd_settings_options_iv_rank_sell_min_check
    CHECK (options_iv_rank_sell_min >= 0 AND options_iv_rank_sell_min <= 100),
  ADD CONSTRAINT dd_settings_options_daily_loss_limit_pct_check
    CHECK (options_daily_loss_limit_pct > 0 AND options_daily_loss_limit_pct <= 2.0);

COMMENT ON COLUMN public.dd_option_cache.iv_current IS
  'Current implied volatility from the Delta option ticker/Greeks payload; NULL when unavailable.';
COMMENT ON COLUMN public.dd_settings.options_iv_rank_buy_max IS
  'Maximum IV Rank allowed for long Options entries; default 40 and exclusive.';
COMMENT ON COLUMN public.dd_settings.options_iv_rank_sell_min IS
  'Minimum IV Rank required for short defined-risk Options entries; default 50 and exclusive.';
COMMENT ON COLUMN public.dd_settings.options_daily_loss_limit_pct IS
  'Separate Options daily realized-loss limit as a percentage of equity; hard-capped at 2%.';

NOTIFY pgrst, 'reload schema';
COMMIT;
