BEGIN;

ALTER TABLE public.dd_option_cache
  ADD COLUMN IF NOT EXISTS oi_value_usd NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS volume_usd NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS market_data_source TEXT NULL;

COMMENT ON COLUMN public.dd_option_cache.oi IS
  'Open interest in option contracts (Delta ticker oi); not a USD notional value.';
COMMENT ON COLUMN public.dd_option_cache.volume IS
  '24-hour traded option volume in contracts (Delta ticker volume).';
COMMENT ON COLUMN public.dd_option_cache.oi_value_usd IS
  'Open-interest valuation in USD from Delta ticker oi_value_usd.';
COMMENT ON COLUMN public.dd_option_cache.volume_usd IS
  '24-hour traded value in USD from Delta ticker turnover_usd.';
COMMENT ON COLUMN public.dd_option_cache.market_data_source IS
  'Origin of public quote/liquidity metrics; Testnet product IDs remain separately joined by exact symbol.';

NOTIFY pgrst, 'reload schema';
COMMIT;
